import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { matchJob } from './lib.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (status, message) => Object.assign(new Error(message), { status });
const equal = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
const day = 86400000;

export function telegramConfig(env = process.env) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const username = env.TELEGRAM_BOT_USERNAME;
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  if (!token && !username && !secret) return null;
  if (!/^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(token || '') || !/^[A-Za-z0-9_]{5,32}$/.test(username || '') || !/^[A-Za-z0-9_-]{32,256}$/.test(secret || '')) {
    throw new Error('Telegram requires a valid bot token, bot username (without @), and a random 32-256 character webhook secret. Keep these in server environment variables.');
  }
  const origin = new URL(env.PUBLIC_ORIGIN || '');
  if (origin.protocol !== 'https:' || origin.origin !== env.PUBLIC_ORIGIN) throw new Error('Telegram requires PUBLIC_ORIGIN to be an HTTPS origin without a trailing slash.');
  return { token, username, secret, origin: origin.origin };
}

export async function telegramSend(config, chatId, text, fetcher = fetch) {
  let response;
  try {
    response = await fetcher(`https://api.telegram.org/bot${config.token}/sendMessage`, {
      method: 'POST', signal: AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, link_preview_options: { is_disabled: true }, protect_content: true, allow_paid_broadcast: false }),
    });
  } catch {
    throw new Error('Telegram could not be reached. Delivery will be retried.');
  }
  let data;
  try { data = await response.json(); } catch { throw new Error('Telegram returned an unreadable response.'); }
  if (!response.ok || !data.ok) {
    const code = Number(data.error_code || response.status);
    throw Object.assign(new Error(`Telegram delivery failed (HTTP ${code}).`), {
      code, retryAfter: Math.min(86400, Math.max(1, Number(data.parameters?.retry_after) || 60)),
    });
  }
}

export function createTelegram(db, config, transport = telegramSend) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_events (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, kind TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS telegram_links (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, chat_id TEXT UNIQUE NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, min_score INTEGER NOT NULL DEFAULT 60, cursor INTEGER NOT NULL, last_digest INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS telegram_pending (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT UNIQUE NOT NULL, expires INTEGER NOT NULL, chat_id TEXT, code_hash TEXT, attempts INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS telegram_queue (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, event_key TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0, error TEXT, created_at INTEGER NOT NULL, UNIQUE(user_id,event_key));
    CREATE TABLE IF NOT EXISTS telegram_runtime (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS telegram_due ON telegram_queue(status,next_attempt);
    CREATE INDEX IF NOT EXISTS job_event_cursor ON job_events(job_id,id);
  `);
  let sending = false;
  let nextSend = 0;
  const maxCursor = () => db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM job_events').get().id;
  const ready = () => { if (!config) throw fail(503, 'Telegram is not configured by the administrator yet. In-app notifications still work.'); };
  const log = (id, message) => db.prepare('INSERT INTO activities(user_id,message,created_at) VALUES (?,?,?)').run(id, message, new Date().toISOString());
  const linkFor = id => db.prepare('SELECT * FROM telegram_links WHERE user_id=?').get(id);
  async function send(chatId, text, allowed = () => true) {
    const at = Math.max(Date.now(), nextSend);
    nextSend = at + 1100;
    await sleep(Math.max(0, at - Date.now()));
    if (!allowed()) return;
    return transport(config, chatId, text);
  }
  function disconnect(userId) {
    db.prepare('DELETE FROM telegram_links WHERE user_id=?').run(userId);
    db.prepare('DELETE FROM telegram_pending WHERE user_id=?').run(userId);
    db.prepare('DELETE FROM telegram_queue WHERE user_id=?').run(userId);
  }
  function state(userId, now = Date.now()) {
    if (!userId) return { configured: Boolean(config), linked: false };
    const link = linkFor(userId);
    const pending = db.prepare('SELECT expires,chat_id FROM telegram_pending WHERE user_id=? AND expires>?').get(userId, now);
    const delivery = db.prepare('SELECT status,error,created_at AS createdAt FROM telegram_queue WHERE user_id=? ORDER BY id DESC LIMIT 1').get(userId);
    return {
      configured: Boolean(config), linked: Boolean(link), enabled: Boolean(link?.enabled), minScore: link?.min_score ?? 60,
      pending: Boolean(pending), awaitingCode: Boolean(pending?.chat_id), expires: pending?.expires,
      lastDigest: link?.last_digest ? new Date(link.last_digest).toISOString() : null, delivery: delivery || null,
    };
  }
  function beginLink(userId, now = Date.now()) {
    ready();
    const token = randomBytes(32).toString('base64url');
    db.prepare('INSERT OR REPLACE INTO telegram_pending(user_id,token_hash,expires) VALUES (?,?,?)').run(userId, hash(token), now + 10 * 60000);
    return { url: `https://t.me/${config.username}?start=${token}`, expires: now + 10 * 60000 };
  }
  async function webhook(secret, update, now = Date.now()) {
    ready();
    if (!equal(secret, config.secret)) throw fail(403, 'Invalid webhook credentials.');
    const msg = update?.message;
    if (!msg || msg.chat?.type !== 'private' || !Number.isSafeInteger(msg.chat.id) || msg.chat.id <= 0 || msg.from?.id !== msg.chat.id || msg.from?.is_bot) return;
    const chatId = String(msg.chat.id);
    if (/^\/stop(?:@\w+)?$/.test(msg.text || '')) {
      const link = db.prepare('SELECT user_id FROM telegram_links WHERE chat_id=?').get(chatId);
      if (link) { disconnect(link.user_id); log(link.user_id, 'Telegram alerts disconnected using /stop.'); }
      db.prepare('DELETE FROM telegram_pending WHERE chat_id=?').run(chatId);
      return;
    }
    const start = /^\/start(?:@\w+)? ([A-Za-z0-9_-]{43})$/.exec(msg.text || '');
    if (!start) return;
    const pending = db.prepare('SELECT * FROM telegram_pending WHERE token_hash=? AND expires>?').get(hash(start[1]), now);
    if (!pending || pending.chat_id) return;
    const code = String(randomInt(100000, 1000000));
    db.prepare('UPDATE telegram_pending SET chat_id=?,code_hash=? WHERE user_id=? AND chat_id IS NULL').run(chatId, hash(code), pending.user_id);
    try {
      await send(chatId, `Your Nextstep connection code: ${code}\nEnter it in your signed-in Nextstep workspace within 10 minutes. Never share this code. If you did not request this, ignore it. No alerts are enabled until you confirm on the website.`, () => {
        return Boolean(db.prepare('SELECT 1 FROM telegram_pending WHERE user_id=? AND code_hash=? AND expires>?').get(pending.user_id, hash(code), Date.now()));
      });
    } catch (error) {
      db.prepare('DELETE FROM telegram_pending WHERE user_id=? AND code_hash=?').run(pending.user_id, hash(code));
      log(pending.user_id, 'Telegram connection code could not be delivered. Generate a new connection link and try again.');
      throw fail(502, error.message);
    }
  }
  function confirm(userId, code, consent, now = Date.now()) {
    ready();
    if (consent !== true) throw fail(400, 'Please consent to Telegram receiving your chat ID and generic job-search alerts.');
    const pending = db.prepare('SELECT * FROM telegram_pending WHERE user_id=? AND expires>?').get(userId, now);
    if (!pending?.chat_id || !pending.code_hash) throw fail(400, 'Start the bot using a fresh connection link first.');
    if (!equal(hash(String(code)), pending.code_hash)) {
      db.prepare('UPDATE telegram_pending SET attempts=attempts+1 WHERE user_id=?').run(userId);
      if (pending.attempts >= 4) db.prepare('DELETE FROM telegram_pending WHERE user_id=?').run(userId);
      throw fail(400, pending.attempts >= 4 ? 'Too many incorrect codes. Generate a new connection link.' : 'The code is incorrect. Check your Telegram chat.');
    }
    const existing = db.prepare('SELECT user_id FROM telegram_links WHERE chat_id=?').get(pending.chat_id);
    if (existing && existing.user_id !== userId) throw fail(409, 'This Telegram chat is already linked to another account. Disconnect it there first.');
    db.prepare('DELETE FROM telegram_queue WHERE user_id=?').run(userId);
    db.prepare('INSERT OR REPLACE INTO telegram_links(user_id,chat_id,cursor,last_digest) VALUES (?,?,?,?)').run(userId, pending.chat_id, maxCursor(), now);
    db.prepare('DELETE FROM telegram_pending WHERE user_id=?').run(userId);
    log(userId, 'Telegram daily alerts enabled with your consent. Your CV, name, email, notes, and preferences are never included in messages.');
  }
  function preferences(userId, enabled, minScore) {
    if (typeof enabled !== 'boolean' || !Number.isInteger(minScore) || minScore < 40 || minScore > 100) throw fail(400, 'Choose an alert threshold between 40 and 100 and a valid enabled setting.');
    if (!linkFor(userId)) throw fail(400, 'Connect Telegram before changing alert preferences.');
    db.prepare('UPDATE telegram_links SET enabled=?,min_score=?,cursor=?,last_digest=? WHERE user_id=?').run(enabled ? 1 : 0, minScore, maxCursor(), Date.now(), userId);
    db.prepare("DELETE FROM telegram_queue WHERE user_id=? AND status='pending'").run(userId);
  }
  function enqueue(userId, eventKey, text, now) {
    db.prepare('INSERT OR IGNORE INTO telegram_queue(user_id,event_key,text,created_at) VALUES (?,?,?,?)').run(userId, eventKey, text, now);
  }
  function queueTest(userId, now = Date.now()) {
    ready();
    const link = linkFor(userId);
    if (!link?.enabled) throw fail(400, 'Connect and enable Telegram alerts first.');
    const recent = db.prepare("SELECT 1 FROM telegram_queue WHERE user_id=? AND event_key LIKE 'test:%' AND created_at>?").get(userId, now - 15 * 60000);
    if (recent) throw fail(429, 'A test was already queued recently. Check delivery status or try again in 15 minutes.');
    enqueue(userId, `test:${Math.floor(now / (15 * 60000))}`, `Nextstep test: your private job-search alerts are connected.\n${config.origin}\nSend /stop to unsubscribe.`, now);
  }
  function prepareDigests(now = Date.now()) {
    if (!config) return;
    const cursor = maxCursor();
    for (const link of db.prepare('SELECT telegram_links.*,users.profile FROM telegram_links JOIN users ON users.id=telegram_links.user_id WHERE enabled=1 AND last_digest<=?').all(now - day)) {
      const profile = JSON.parse(link.profile);
      const events = db.prepare('SELECT job_events.*,jobs.data FROM job_events JOIN jobs ON jobs.id=job_events.job_id WHERE job_events.id>? AND job_events.id<=?').all(link.cursor, cursor);
      let newMatch = false;
      let trackedChange = false;
      for (const event of events) {
        if (event.kind === 'new') {
          const match = matchJob(JSON.parse(event.data), profile);
          if (match.countryMatch && match.workMatch && match.score >= link.min_score) newMatch = true;
        } else if (db.prepare('SELECT 1 FROM applications WHERE user_id=? AND job_id=?').get(link.user_id, event.job_id)) trackedChange = true;
      }
      const due = db.prepare("SELECT 1 FROM applications WHERE user_id=? AND follow_up<>'' AND follow_up<=? AND status NOT IN ('Offer','Rejected','Withdrawn') LIMIT 1").get(link.user_id, new Date(now).toISOString().slice(0, 10));
      db.exec('BEGIN');
      try {
        if (newMatch || trackedChange || due) {
          const summary = [newMatch && 'New matching positions are available.', trackedChange && 'A tracked job listing has changed.', due && 'An application follow-up is due.'].filter(Boolean).join('\n');
          enqueue(link.user_id, `digest:${new Date(now).toISOString().slice(0, 10)}`, `Nextstep daily update\n${summary}\nReview details privately: ${config.origin}\nManage alerts in Profile & preferences, or send /stop.`, now);
        }
        db.prepare('UPDATE telegram_links SET cursor=?,last_digest=? WHERE user_id=?').run(cursor, now, link.user_id);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    db.prepare('DELETE FROM telegram_pending WHERE expires<=?').run(now);
    db.prepare("DELETE FROM telegram_queue WHERE status<>'pending' AND created_at<?").run(now - 30 * day);
    db.prepare('DELETE FROM job_events WHERE created_at<?').run(now - 90 * day);
  }
  async function drain(now = Date.now()) {
    if (!config || sending) return;
    const blockedUntil = db.prepare("SELECT value FROM telegram_runtime WHERE key='backoff'").get()?.value || 0;
    if (blockedUntil > now) return;
    sending = true;
    try {
      const batch = db.prepare("SELECT telegram_queue.*,telegram_links.chat_id FROM telegram_queue JOIN telegram_links USING(user_id) WHERE status='pending' AND enabled=1 AND next_attempt<=? ORDER BY telegram_queue.id LIMIT 10").all(now);
      for (const item of batch) {
        const current = linkFor(item.user_id);
        if (!current?.enabled || current.chat_id !== item.chat_id) continue;
        try {
          await send(item.chat_id, item.text, () => {
            const link = linkFor(item.user_id);
            return Boolean(link?.enabled && link.chat_id === item.chat_id);
          });
          db.prepare("UPDATE telegram_queue SET status='sent',error=NULL WHERE id=?").run(item.id);
        } catch (error) {
          const attempts = item.attempts + 1;
          const permanent = error.code === 403 || attempts >= 5;
          const message = error.code === 403 ? 'Bot blocked or chat unavailable. Reconnect Telegram to resume.' : error.code === 429 ? 'Telegram rate limit reached. Delivery will be retried.' : permanent ? 'Telegram delivery failed after 5 attempts. Use Send test to retry.' : 'Telegram is temporarily unavailable. Delivery will be retried.';
          console.error(`[telegram] ${message}`);
          const retryAt = now + (error.code === 429 ? error.retryAfter || 60 : Math.min(3600, 60 * 2 ** attempts)) * 1000;
          db.prepare('UPDATE telegram_queue SET status=?,attempts=?,next_attempt=?,error=? WHERE id=?').run(permanent ? 'failed' : 'pending', attempts, retryAt, message, item.id);
          if (error.code === 403) db.prepare('UPDATE telegram_links SET enabled=0 WHERE user_id=?').run(item.user_id);
          if (error.code === 429) {
            db.prepare("INSERT OR REPLACE INTO telegram_runtime VALUES ('backoff',?)").run(retryAt);
            break;
          }
        }
      }
    } finally { sending = false; }
  }
  return { state, beginLink, webhook, confirm, preferences, disconnect, queueTest, prepareDigests, drain };
}
