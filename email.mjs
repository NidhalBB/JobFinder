import nodemailer from 'nodemailer';
import { randomInt, createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { matchJob } from './lib.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (status, message) => Object.assign(new Error(message), { status });
export function emailConfig(env = process.env) {
  const fields = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'NOTIFICATION_FROM'];
  if (fields.every(k => !env[k])) return null;
  const port = Number(env.SMTP_PORT);
  if (fields.some(k => !env[k]) || ![465, 587].includes(port) || !/^[a-z0-9.-]+$/i.test(env.SMTP_HOST) || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(env.NOTIFICATION_FROM)) throw new Error('Email alerts require SMTP_HOST, SMTP_PORT (465 or 587), SMTP_USER, SMTP_PASS and a verified NOTIFICATION_FROM email.');
  const origin = new URL(env.PUBLIC_ORIGIN || env.URL || '');
  if (origin.protocol !== 'https:' || origin.origin !== (env.PUBLIC_ORIGIN || env.URL)) throw new Error('Email notifications require an exact HTTPS PUBLIC_ORIGIN.');
  return { host: env.SMTP_HOST, port, secure: port === 465, user: env.SMTP_USER, pass: env.SMTP_PASS, from: env.NOTIFICATION_FROM, origin: origin.origin };
}
export function emailTransport(config) {
  const transport = nodemailer.createTransport({
    host: config.host, port: config.port, secure: config.secure, requireTLS: true,
    auth: { user: config.user, pass: config.pass }, disableFileAccess: true, disableUrlAccess: true,
    connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 8000, logger: false, debug: false,
  });
  return async (to, text) => {
    const result = await transport.sendMail({ from: config.from, to, subject: 'Nextstep: your job-search update', text, disableFileAccess: true, disableUrlAccess: true });
    if (!result.accepted?.length) throw new Error('SMTP did not accept the notification.');
  };
}
export async function drainEmail(store, config, send = config ? emailTransport(config) : null) {
  if (!config) return { configured: false };
  const started = Date.now(); let sent = 0;
  for (let i = 0; i < 5 && Date.now() - started < 12000; i++) {
    const lease = randomUUID();
    const item = await store.claim(lease);
    if (!item) break;
    if (!await store.allowed(item)) { await store.finish(item, lease, 'cancelled'); continue; }
    let error = null;
    try { await send(item.email, item.text); sent++; }
    catch (e) { error = e.code === 'EAUTH' ? 'SMTP authentication failed. Administrator action required.' : 'Email delivery could not be confirmed. Retrying, up to five attempts.'; console.error('[email]', error); }
    await store.finish(item, lease, error ? 'retry' : 'sent', error);
    if (error) break;
  }
  return { configured: true, sent };
}
export function createLocalEmail(db, config, transport) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS email_preferences(user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,enabled INTEGER NOT NULL DEFAULT 0,verified INTEGER NOT NULL DEFAULT 0,min_score INTEGER NOT NULL DEFAULT 60,cursor INTEGER NOT NULL,last_digest INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS email_pending(user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,code_hash TEXT NOT NULL,expires INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS email_queue(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,event_key TEXT NOT NULL,text TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,lease TEXT,lease_expires INTEGER,error TEXT,created_at INTEGER NOT NULL,UNIQUE(user_id,event_key));
  `);
  const send = config ? transport || emailTransport(config) : null;
  const cursor = () => db.prepare('SELECT COALESCE(MAX(id),0) id FROM job_events').get().id;
  const ready = () => { if (!config) throw fail(503, 'Email alerts are not configured. Your in-app updates still work.'); };
  function state(id) {
    const p = db.prepare('SELECT * FROM email_preferences WHERE user_id=?').get(id || 0);
    const pending = db.prepare('SELECT 1 FROM email_pending WHERE user_id=? AND expires>?').get(id || 0, Date.now());
    const delivery = db.prepare('SELECT status,error FROM email_queue WHERE user_id=? ORDER BY id DESC LIMIT 1').get(id || 0);
    return { configured: Boolean(config), enabled: Boolean(p?.enabled), verified: Boolean(p?.verified), minScore: p?.min_score ?? 60, pending: Boolean(pending), delivery: delivery || null };
  }
  async function begin(user) {
    ready();
    const previous = db.prepare('SELECT expires FROM email_pending WHERE user_id=?').get(user.id);
    if (previous?.expires > Date.now()) throw fail(429, 'A confirmation code was already sent. Use it or wait 10 minutes.');
    const code = String(randomInt(100000, 1000000));
    db.prepare('INSERT OR REPLACE INTO email_pending(user_id,code_hash,expires) VALUES (?,?,?)').run(user.id, hash(code), Date.now() + 600000);
    try { await send(user.email, `Confirm your Nextstep email alerts with code ${code} in your signed-in workspace within 10 minutes. No alerts are enabled until you confirm. Ignore this email if you did not request it.\n${config.origin}`); }
    catch { db.prepare('DELETE FROM email_pending WHERE user_id=?').run(user.id); throw fail(502, 'The confirmation email could not be delivered. Check SMTP configuration and try again later.'); }
  }
  function confirm(id, code, consent) {
    ready();
    if (consent !== true || !/^\d{6}$/.test(code || '')) throw fail(400, 'Enter the six-digit email code and consent to daily alerts.');
    const p = db.prepare('SELECT * FROM email_pending WHERE user_id=? AND expires>?').get(id, Date.now());
    if (!p) throw fail(400, 'Request a fresh confirmation code.');
    if (!timingSafeEqual(Buffer.from(hash(code)), Buffer.from(p.code_hash))) {
      if (p.attempts >= 4) db.prepare('DELETE FROM email_pending WHERE user_id=?').run(id);
      else db.prepare('UPDATE email_pending SET attempts=attempts+1 WHERE user_id=?').run(id);
      throw fail(400, 'Incorrect code. Five incorrect attempts invalidate it.');
    }
    db.prepare('INSERT OR REPLACE INTO email_preferences(user_id,enabled,verified,cursor,last_digest) VALUES (?,1,1,?,?)').run(id, cursor(), Date.now());
    db.prepare('DELETE FROM email_pending WHERE user_id=?').run(id);
  }
  function preferences(id, input) {
    ready();
    if (typeof input.enabled !== 'boolean' || !Number.isInteger(input.minScore) || input.minScore < 40 || input.minScore > 100) throw fail(400, 'Choose a threshold from 40 to 100 and an enabled setting.');
    const p = state(id);
    if (!p.verified) throw fail(400, 'Confirm your notification email first.');
    if (input.enabled && !p.verified) throw fail(400, 'Confirm your notification email first.');
    db.prepare('UPDATE email_preferences SET enabled=?,min_score=?,cursor=?,last_digest=? WHERE user_id=?').run(input.enabled ? 1 : 0, input.minScore, cursor(), Date.now(), id);
    db.prepare("DELETE FROM email_queue WHERE user_id=? AND status IN ('pending','sending')").run(id);
  }
  function reset(id) {
    db.prepare('UPDATE email_preferences SET cursor=?,last_digest=? WHERE user_id=?').run(cursor(), Date.now(), id);
    db.prepare("DELETE FROM email_queue WHERE user_id=? AND status IN ('pending','sending')").run(id);
  }
  function prepare(now = Date.now()) {
    if (!config) return;
    const top = cursor();
    for (const p of db.prepare('SELECT e.*,u.profile FROM email_preferences e JOIN users u ON u.id=e.user_id WHERE e.enabled=1 AND e.verified=1 AND e.last_digest<=?').all(now - 86400000)) {
      const profile = JSON.parse(p.profile);
      const events = db.prepare('SELECT e.kind,e.job_id,j.data FROM job_events e JOIN jobs j ON j.id=e.job_id WHERE e.id>? AND e.id<=?').all(p.cursor, top);
      const fresh = profile.agentEnabled && events.some(e => { const j = JSON.parse(e.data); const m = matchJob(j, profile); return e.kind === 'new' && !j.closed && (!j.expiresAt || Date.parse(j.expiresAt) > now) && m.countryMatch && m.workMatch && m.score >= p.min_score; });
      const closed = events.some(e => e.kind === 'closed' && (db.prepare('SELECT 1 FROM applications WHERE user_id=? AND job_id=?').get(p.user_id, e.job_id) || db.prepare('SELECT 1 FROM saved WHERE user_id=? AND job_id=?').get(p.user_id, e.job_id)));
      db.exec('BEGIN');
      try {
        if (fresh || closed) db.prepare('INSERT OR IGNORE INTO email_queue(user_id,event_key,text,created_at) VALUES (?,?,?,?)').run(p.user_id, `digest:${new Date(now).toISOString().slice(0, 10)}`, `Nextstep daily update\n${fresh ? 'New matching jobs are available.\n' : ''}${closed ? 'A saved or tracked job has been confirmed closed.\n' : ''}Review privately: ${config.origin}\nManage or disable emails in Profile & preferences.`, now);
        db.prepare('UPDATE email_preferences SET cursor=?,last_digest=? WHERE user_id=?').run(top, now, p.user_id);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    }
    db.prepare('DELETE FROM email_pending WHERE expires<=?').run(now);
    db.prepare("DELETE FROM email_queue WHERE status IN ('sent','failed','cancelled') AND created_at<?").run(now - 30 * 86400000);
  }
  const store = {
    claim(lease) {
      db.prepare("UPDATE email_queue SET status='failed',error='Delivery stopped after five attempts.' WHERE attempts>=5 AND (status='pending' OR (status='sending' AND lease_expires<=?))").run(Date.now());
      const item = db.prepare("SELECT q.*,u.email FROM email_queue q JOIN email_preferences p USING(user_id) JOIN users u ON u.id=q.user_id WHERE p.enabled=1 AND p.verified=1 AND q.attempts<5 AND ((q.status='pending' AND q.next_attempt<=?) OR (q.status='sending' AND q.lease_expires<=?)) ORDER BY q.id LIMIT 1").get(Date.now(), Date.now());
      if (!item) return null;
      db.prepare("UPDATE email_queue SET status='sending',lease=?,lease_expires=?,attempts=attempts+1 WHERE id=?").run(lease, Date.now() + 120000, item.id);
      return item;
    },
    allowed: item => Boolean(db.prepare("SELECT 1 FROM email_preferences p JOIN email_queue q USING(user_id) WHERE p.user_id=? AND p.enabled=1 AND p.verified=1 AND q.id=? AND q.status='sending'").get(item.user_id, item.id)),
    finish: (item, lease, result, error = null) => db.prepare("UPDATE email_queue SET status=?,error=?,next_attempt=?,lease=NULL WHERE id=? AND lease=?").run(result === 'retry' ? 'pending' : result, error, Date.now() + 3600000, item.id, lease),
  };
  let draining = false;
  async function drain() { if (draining) return; draining = true; try { return await drainEmail(store, config, send); } finally { draining = false; } }
  return { state, begin, confirm, preferences, reset, prepare, drain };
}
