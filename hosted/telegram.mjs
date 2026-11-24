import { randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { telegramSend } from '../telegram.mjs';
import { digest, fail } from './supabase.mjs';

export const sameSecret = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function createHostedTelegram(db, config, fetcher = fetch) {
  const operation = async (action, user = null, data = {}) => {
    const result = await db.rpc('ns_telegram', { p_action: action, p_user: user, p_data: data });
    if (result?.error) throw fail(result.status, result.error);
    return result;
  };
  const ready = () => { if (!config) throw fail(503, 'Telegram is not configured by the administrator yet. In-app notifications still work.'); };
  async function webhook(secret, update) {
    ready();
    if (!sameSecret(secret, config.secret)) throw fail(403, 'Invalid webhook credentials.');
    const msg = update?.message;
    if (!msg || msg.chat?.type !== 'private' || !Number.isSafeInteger(msg.chat.id) || msg.chat.id <= 0 || msg.from?.id !== msg.chat.id || msg.from?.is_bot) return;
    const chat = String(msg.chat.id);
    if (/^\/stop(?:@\w+)?$/.test(msg.text || '')) { await operation('stop', null, { chat }); return; }
    const start = /^\/start(?:@\w+)? ([A-Za-z0-9_-]{43})$/.exec(msg.text || '');
    if (!start) return;
    const code = String(randomInt(100000, 1000000));
    const data = { hash: digest(start[1]), chat, codeHash: digest(code) };
    if (!(await operation('start', null, data)).claimed) return;
    try {
      await telegramSend(config, chat, `Your Nextstep connection code: ${code}\nEnter it in your signed-in workspace within 10 minutes. Never share this code. No alerts are enabled until you confirm on the website.`, fetcher);
    } catch (error) {
      await operation('failed-code', null, data);
      throw fail(502, error.message);
    }
  }
  async function handle(path, method, user, input) {
    ready();
    if (path === 'link' && method === 'POST') {
      const token = randomBytes(32).toString('base64url');
      await operation('begin', user, { hash: digest(token) });
      return { url: `https://t.me/${config.username}?start=${token}`, expires: Date.now() + 600000 };
    }
    if (path === 'link' && method === 'DELETE') return operation('disconnect', user);
    if (path === 'confirm' && method === 'POST') {
      if (input.consent !== true || !/^\d{6}$/.test(input.code || '')) throw fail(400, 'Enter the six-digit code and consent to generic Telegram alerts.');
      return operation('confirm', user, { codeHash: digest(input.code) });
    }
    if (path === 'preferences' && method === 'PUT') {
      if (typeof input.enabled !== 'boolean' || !Number.isInteger(input.minScore) || input.minScore < 40 || input.minScore > 100) throw fail(400, 'Choose a threshold between 40 and 100 and a valid enabled setting.');
      return operation('preferences', user, input);
    }
    if (path === 'test' && method === 'POST') { await operation('test', user, { origin: config.origin }); return { queued: true }; }
    throw fail(404, 'Telegram endpoint not found.');
  }
  async function run() {
    if (!config) return { configured: false };
    const started = Date.now();
    await operation('prepare', null, { origin: config.origin });
    let sent = 0, claimed = 0;
    for (let i = 0; i < 5; i++) {
      if (Date.now() - started > 12000) break;
      const lease = randomUUID();
      const batch = await operation('claim', null, { lease, limit: 1 });
      if (!batch.length) break;
      const item = batch[0];
      claimed++;
      await sleep(1100);
      const links = await db.rows('ns_telegram_links', { user_id: `eq.${item.user_id}`, enabled: 'eq.true', select: 'chat_id' });
      const queued = await db.rows('ns_telegram_queue', { id: `eq.${item.id}`, lease_id: `eq.${lease}`, select: 'id' });
      if (links[0]?.chat_id !== item.chat_id || !queued.length) continue;
      let outcome = { result: 'sent' };
      try { await telegramSend(config, item.chat_id, item.text, fetcher); sent++; }
      catch (error) {
        const result = error.code === 403 ? 'blocked' : error.code === 429 ? 'limited' : 'retry';
        outcome = { result, retryAfter: error.code === 429 ? error.retryAfter : Math.min(3600, 60 * 2 ** item.attempts),
          error: result === 'blocked' ? 'Bot blocked or chat unavailable. Reconnect Telegram.' : 'Telegram delivery failed. Retrying, up to five attempts.' };
        console.error('[telegram]', outcome.error);
      }
      await operation('finish', null, { id: item.id, lease, ...outcome });
      if (outcome.result === 'limited') break;
    }
    return { configured: true, sent, claimed };
  }
  return { webhook, handle, run };
}
