import { countries, countryMatches, feeds, feedRecords, normalizeJob } from '../lib.mjs';
import { digest } from './supabase.mjs';
import { checkAvailability } from '../availability.mjs';

export async function syncHostedFeeds(db, fetcher = fetch) {
  if (!await db.rpc('ns_claim_feed_refresh')) {
    const cached = await db.rows('ns_meta', { key: 'eq.syncResult', select: 'value' });
    return { ...(cached[0]?.value || { sources: [] }), cached: true, message: 'A refresh is running or ran within 15 minutes. Using cached listings.' };
  }
  const results = await Promise.all(feeds.map(async feed => {
    try {
      if(feed.cooldown) {
        const cached=(await db.rows('ns_meta',{key:`eq.source:${feed.name}`,select:'value'}))[0]?.value;
        if(cached && Date.now()-Date.parse(cached.at)<feed.cooldown) return {feed,jobs:[],cached};
        await db.rows('ns_meta',{on_conflict:'key'},{method:'POST',body:[{key:`source:${feed.name}`,value:{at:new Date().toISOString(),ok:false,count:cached?.count || 0,error:'The last source refresh did not complete. Waiting for the 6-hour retry window.'}}],headers:{Prefer:'resolution=merge-duplicates'}});
      }
      const response = await fetcher(feed.url, { signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json', 'User-Agent': 'Nextstep/1.0 public job dashboard' } });
      if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}`);
      const payload = await response.json();
      const records = feedRecords(payload, feed.name);
      if (!Array.isArray(records)) throw new Error('Provider returned an unexpected response');
      const jobs = records.slice(0, 300).map(raw => normalizeJob(raw, feed.name)).filter(Boolean);
      return { feed, jobs };
    } catch (error) {
      console.error(`[feed:${feed.name}]`, error.name);
      return { feed, error: error.name === 'TimeoutError' ? 'Provider timed out.' : 'Provider could not be refreshed. Existing listings remain available.' };
    }
  }));
  let added = 0, updated = 0;
  const sources = [];
  for (const result of results) {
    if (result.error) { sources.push({ name: result.feed.name, ok: false, error: result.error }); continue; }
    if(result.cached) { sources.push({name:result.feed.name,ok:result.cached.ok,count:result.cached.count,error:result.cached.error,cached:true}); continue; }
    for (let i = 0; i < result.jobs.length; i += 100) {
      const batch = result.jobs.slice(i, i + 100).map(job => {
        const { updatedAt, ...content } = job;
        return { data: job, fingerprint: digest(JSON.stringify(content)), eligibleCountries: countries.filter(c => countryMatches(job, c)) };
      });
      const imported = await db.rpc('ns_import_jobs', { p_jobs: batch });
      added += imported.added; updated += imported.updated;
    }
    sources.push({ name: result.feed.name, ok: true, count: result.jobs.length });
    if(result.feed.cooldown) await db.rows('ns_meta',{on_conflict:'key'},{method:'POST',body:[{key:`source:${result.feed.name}`,value:{at:new Date().toISOString(),ok:true,count:result.jobs.length}}],headers:{Prefer:'resolution=merge-duplicates'}});
  }
  const at = new Date().toISOString();
  const result = { sources, added, updated, at };
  const values = [{ key: 'syncResult', value: result }];
  if (sources.some(s => s.ok)) values.push({ key: 'lastSuccess', value: at });
  await db.rows('ns_meta', { on_conflict: 'key' }, { method: 'POST', body: values, headers: { Prefer: 'resolution=merge-duplicates' } });
  return result;
}

export async function hostedAvailability(db, job, fetcher = fetch) {
  if (!job.closed && Date.parse(job.expiresAt) > Date.now() && Date.now() - Date.parse(job.availabilityCheckedAt) < 900000) return job;
  const status = await checkAvailability(job, fetcher);
  if (status.closed && !job.closed) await db.rpc('ns_mark_closed', { p_ids: [job.id] });
  if (status.closed) return { ...job, closed: true, description: '' };
  if (job.source === 'Himalayas') {
    const data = await db.rpc('ns_record_availability', { p_id: job.id, p_unknown: Boolean(status.availabilityUnknown) });
    if (!data) throw new Error('This listing is no longer available.');
    return data;
  }
  return job;
}

export async function maintainAvailability(db, fetcher = fetch) {
  const budget = AbortSignal.timeout(6000);
  await db.rpc('ns_expire_jobs');
  const rows = await db.rows('ns_jobs', { select: 'data', 'data->>source': 'eq.Himalayas', 'data->>closed': 'eq.false', order: 'data->>availabilityCheckedAt.asc.nullsfirst', limit: '5' });
  for (const { data } of rows) {
    if (budget.aborted) break;
    try { await hostedAvailability(db, data, (url, options) => fetcher(url, { ...options, signal: AbortSignal.any([budget, options.signal]) })); }
    catch (error) { console.error('[availability]', error.name); }
  }
}
