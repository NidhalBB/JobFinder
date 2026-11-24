import { createSupabase, hostedConfig, scheduledFetch } from '../../hosted/supabase.mjs';
import { syncHostedFeeds } from '../../hosted/jobs.mjs';

export default async () => {
  const fetcher = scheduledFetch();
  const db = createSupabase(hostedConfig(), fetcher);
  const result = await syncHostedFeeds(db, fetcher);
  if (!result.cached && !result.sources.some(source => source.ok)) throw new Error('All public feeds failed. Review provider status in My job agent.');
  await db.rpc('ns_cleanup');
  console.log('[refresh-jobs]', JSON.stringify(result));
  return Response.json({ ok: true });
};

export const config = { schedule: '0 6 * * *' };
