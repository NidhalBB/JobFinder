import { createSupabase, hostedConfig, scheduledFetch } from '../../hosted/supabase.mjs';
import { maintainAvailability } from '../../hosted/jobs.mjs';
import { runHostedEmail } from '../../hosted/email.mjs';

export default async () => {
  const config = hostedConfig(), fetcher = scheduledFetch(), db = createSupabase(config, fetcher);
  await maintainAvailability(db, fetcher);
  const result = await runHostedEmail(db, config.email);
  console.log('[email-digests]', JSON.stringify(result));
  return Response.json({ ok: true });
};
export const config = { schedule: '15 * * * *' };
