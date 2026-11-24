import { drainEmail } from '../email.mjs';
export async function runHostedEmail(db, config, send) {
  if (!config) return { configured: false };
  await db.rpc('ns_prepare_email', { p_origin: config.origin });
  return drainEmail({
    claim: lease => db.rpc('ns_claim_email', { p_lease: lease }),
    allowed: item => db.rpc('ns_email_allowed', { p_id: item.id, p_email: item.email }),
    finish: (item, lease, result, error = null) => db.rpc('ns_finish_email', { p_id: item.id, p_lease: lease, p_result: result, p_error: error }),
  }, config, send);
}
