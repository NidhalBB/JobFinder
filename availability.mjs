export async function checkAvailability(job, fetcher = fetch) {
  if (job.source !== 'Himalayas') return { closed: Boolean(job.closed) };
  if (job.closed || Date.parse(job.expiresAt) <= Date.now()) return { closed: true };
  const guid = new URL(job.sourceUrl);
  if (guid.origin !== 'https://himalayas.app' || !/^\/companies\/[^/]+\/jobs\/[^/]+$/.test(guid.pathname)) throw new Error('Invalid source status URL.');
  const response = await fetcher(`https://himalayas.app/jobs/api${guid.pathname}`, { signal: AbortSignal.timeout(6000), redirect: 'error' });
  if (response.status === 410) return { closed: true };
  if (response.status === 404) return { closed: false, availabilityUnknown: true };
  if (!response.ok) throw new Error(`Could not verify the source listing (HTTP ${response.status}). Try again later.`);
  const result = await response.json();
  if (!result.job || result.job.guid !== job.sourceUrl) throw new Error('The source returned an unexpected listing.');
  const expires = Number(result.job.expiryDate) * 1000;
  if (!Number.isFinite(expires) || expires <= 0) throw new Error('The source returned an invalid expiry date.');
  return { closed: expires <= Date.now(), availabilityUnknown: false };
}
