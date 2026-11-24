import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countries, statuses, feeds, sourceNames, feedRecords, hashPassword, verifyPassword, normalizeJob, validateProfile, matchJob, countryMatches, dailyRefreshDue } from './lib.mjs';
import { securityConfig, requestSecurity, cookie, sessionToken } from './security.mjs';
import { createLocalEmail, emailConfig } from './email.mjs';
import { extractDocument } from './documents.mjs';
import { careerRequest, proposeLinkedIn } from './career.mjs';
import { discoveryLinks } from './discovery.mjs';
import { checkAvailability } from './availability.mjs';
import { createLocalRecruitment, accountType, companyInput, postingInput, submissionInput, consentInput, reviewInput } from './recruitment.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const security = securityConfig();
const dummyPasswordHash = await hashPassword(randomBytes(32).toString('hex'));
const dataDir = resolve(process.env.DATA_DIR || join(root, 'data'));
mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(join(dataDir, 'nextstep.sqlite'));
db.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA foreign_keys=ON;
  PRAGMA secure_delete=ON;
  CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL, profile TEXT NOT NULL, cv_name TEXT, cv_type TEXT, cv BLOB, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL, fingerprint TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS applications (user_id INTEGER REFERENCES users(id), job_id TEXT, status TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', follow_up TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL, PRIMARY KEY(user_id, job_id));
  CREATE TABLE IF NOT EXISTS saved (user_id INTEGER REFERENCES users(id), job_id TEXT, PRIMARY KEY(user_id, job_id));
  CREATE TABLE IF NOT EXISTS activities (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id), message TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS job_events (id INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT NOT NULL,kind TEXT NOT NULL,created_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS job_event_cursor ON job_events(job_id,id);
`);
const emailAlerts = createLocalEmail(db, emailConfig());
const recruitment = createLocalRecruitment(db);

let syncPromise;
const meta = key => db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value;
const setMeta = (key, value) => db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(key, value);
const activity = (id, message) => db.prepare('INSERT INTO activities(user_id,message,created_at) VALUES (?,?,?)').run(id, message, new Date().toISOString());
const jobs = () => db.prepare('SELECT data FROM jobs').all().map(row => JSON.parse(row.data));
const publicUser = row => {
  const { cvText, cvVersion, ...profile } = JSON.parse(row.profile);
  return { id: row.id, email: row.email, ...profile, accountType:profile.accountType || 'jobseeker', hasCvText: Boolean(cvText?.trim()), cvName: row.cv_name || null };
};
const tokenDigest = token => createHash('sha256').update(token).digest('hex');

async function syncFeeds() {
  if (syncPromise) return syncPromise;
  const previous = Number(meta('lastAttempt') || 0);
  if (Date.now() - previous < 15 * 60 * 1000) {
    return { cached: true, ...(JSON.parse(meta('syncResult') || '{"sources":[]}')), message: 'Using the latest cache. Public feeds refresh at most once every 15 minutes.' };
  }
  syncPromise = (async () => {
    setMeta('lastAttempt', String(Date.now()));
    const sources = [];
    let added = 0;
    let updated = 0;
    for (const feed of feeds) {
      try {
        const cached=JSON.parse(meta(`source:${feed.name}`) || 'null');
        if(feed.cooldown && cached && Date.now()-Date.parse(cached.at)<feed.cooldown) { sources.push({name:feed.name,ok:cached.ok,count:cached.count,error:cached.error,cached:true}); continue; }
        if(feed.cooldown) setMeta(`source:${feed.name}`,JSON.stringify({at:new Date().toISOString(),ok:false,count:cached?.count || 0,error:'The last source refresh did not complete. Waiting for the 6-hour retry window.'}));
        const response = await fetch(feed.url, { signal: AbortSignal.timeout(25000), headers: { Accept: 'application/json', 'User-Agent': 'Nextstep/1.0 personal job dashboard' } });
        if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}`);
        const payload = await response.json();
        const records = feedRecords(payload, feed.name);
        if (!Array.isArray(records)) throw new Error('Provider returned an unexpected response');
        let count = 0;
        for (const raw of records) {
          const job = normalizeJob(raw, feed.name);
          if (!job) continue;
          count++;
          const { updatedAt, ...content } = job;
          const fingerprint = createHash('sha256').update(JSON.stringify(content)).digest('hex');
          const old = db.prepare('SELECT fingerprint,data FROM jobs WHERE id=?').get(job.id);
          if (old && JSON.parse(old.data).closed) continue;
          if (!old || old.fingerprint !== fingerprint) {
            db.exec('BEGIN');
            try {
              db.prepare('INSERT OR REPLACE INTO jobs VALUES (?,?,?)').run(job.id, JSON.stringify(job), fingerprint);
              db.prepare('INSERT INTO job_events(job_id,kind,created_at) VALUES (?,?,?)').run(job.id, old ? 'updated' : 'new', Date.now());
              if (old) {
                for (const app of db.prepare('SELECT user_id FROM applications WHERE job_id=?').all(job.id)) {
                  activity(app.user_id, `Listing updated: ${job.title} at ${job.company}. Review the source for changes.`);
                }
              }
              db.exec('COMMIT');
            } catch (error) { db.exec('ROLLBACK'); throw error; }
            if (old) updated++;
            else added++;
          }
        }
        sources.push({ name: feed.name, ok: true, count });
        if(feed.cooldown) setMeta(`source:${feed.name}`,JSON.stringify({at:new Date().toISOString(),ok:true,count}));
      } catch (error) {
        console.error(`[feed:${feed.name}] ${error.message}`);
        sources.push({ name: feed.name, ok: false, error: error.message });
      }
    }
    const result = { sources, added, updated, at: new Date().toISOString() };
    if (sources.some(s => s.ok)) setMeta('lastSuccess', result.at);
    setMeta('syncResult', JSON.stringify(result));
    return result;
  })();
  try { return await syncPromise; } finally { syncPromise = undefined; }
}

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
function fail(status, message) {
  return Object.assign(new Error(message), { status });
}
async function body(req) {
  const parts = [];
  let size = 0;
  for await (const part of req) {
    size += part.length;
    const limit = ['/api/cv','/api/profile/import'].includes(req.url) ? 7_100_000 : req.url === '/api/profile/evidence' ? 250000 : req.url.startsWith('/api/career/') || req.url.startsWith('/api/recruitment') ? 90000 : 32768;
    if (size > limit) throw fail(413, req.url === '/api/cv' ? 'File is too large. Maximum CV size is 5 MB.' : 'Request body is too large.');
    parts.push(part);
  }
  try {
    const value = JSON.parse(Buffer.concat(parts).toString() || '{}');
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Expected object');
    return value;
  } catch { throw fail(400, 'Invalid JSON request. Expected an object.'); }
}
function currentUser(req) {
  const token = sessionToken(req, security);
  if (!token) return null;
  return db.prepare('SELECT users.id,users.email,users.password,users.profile,users.cv_name FROM sessions JOIN users ON sessions.user_id=users.id WHERE token=? AND expires>?').get(tokenDigest(token), Date.now()) || null;
}
function session(res, userId) {
  const token = randomBytes(32).toString('hex');
  db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
  db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(tokenDigest(token), userId, Date.now() + 7 * 86400000);
  res.setHeader('Set-Cookie', cookie(security, token));
}
const attempts = new Map();
function closeListing(job) {
  const row = db.prepare('SELECT data FROM jobs WHERE id=?').get(job.id);
  if (!row) throw fail(404, 'Job not found.');
  job = JSON.parse(row.data);
  if (job.closed) return job;
  const closed = { ...job, closed: true, closedAt: new Date().toISOString(), description: '' };
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify(closed), job.id);
    db.prepare("INSERT INTO job_events(job_id,kind,created_at) VALUES (?,'closed',?)").run(job.id, Date.now());
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return closed;
}
async function localAvailability(job) {
  if (job.source !== 'Himalayas') return job;
  if (!job.closed && Date.parse(job.expiresAt) > Date.now() && Date.now() - Date.parse(job.availabilityCheckedAt) < 900000) return job;
  let status;
  try { status = await checkAvailability(job); } catch { throw fail(503, 'The listing could not be verified with its source. Try again later.'); }
  const row = db.prepare('SELECT data FROM jobs WHERE id=?').get(job.id);
  if (!row) throw fail(404, 'Job not found.');
  const current = JSON.parse(row.data);
  if (current.closed) return current;
  const checked = status.closed ? closeListing(current) : { ...current, ...status };
  checked.availabilityCheckedAt = new Date().toISOString();
  db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify(checked), job.id);
  return checked;
}
function rateLimit(key, maximum = 30) {
  const now = Date.now();
  for (const [ip, data] of attempts) if (now > data.until) attempts.delete(ip);
  const record = attempts.get(key) || { count: 0, until: now + 15 * 60000 };
  record.count++;
  attempts.set(key, record);
  if (record.count > maximum) throw fail(429, 'Too many requests. Try again in 15 minutes.');
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  try {
    const clientIp = requestSecurity(req, security);
    if (security.production) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    if (req.method === 'GET' && path === '/healthz') return json(res, 200, { ok: true });
    if (path.startsWith('/api/')) {
      rateLimit(`api:${clientIp}`, 1200);
      if (path.startsWith('/api/telegram/')) throw fail(410, 'Telegram alerts are retired. Use email preferences instead.');
      const user = currentUser(req);
      if (req.method === 'GET' && path === '/api/state') {
        const profile = user ? publicUser(user) : null;
        const list = jobs().filter(job => {
          const age = Date.now() - Date.parse(job.publishedAt);
          if (job.source === 'Himalayas' && !job.closed && Date.parse(job.expiresAt) <= Date.now()) Object.assign(job, closeListing(job));
          return (!job.closed && age < 45 * 86400000 && (!job.expiresAt || Date.parse(job.expiresAt) > Date.now())) || (user && db.prepare('SELECT 1 FROM applications WHERE user_id=? AND job_id=?').get(user.id, job.id)) || (user && db.prepare('SELECT 1 FROM saved WHERE user_id=? AND job_id=?').get(user.id, job.id));
        });
        return json(res, 200, {
          user: profile, countries, jobs: list.map(job => ({ ...job, eligibleCountries: countries.filter(c => countryMatches(job, c)), ...(profile ? matchJob(job, profile) : {}) })),
          applications: user ? db.prepare('SELECT job_id AS jobId,status,notes,follow_up AS followUp,updated_at AS updatedAt FROM applications WHERE user_id=?').all(user.id) : [],
          saved: user ? db.prepare('SELECT job_id FROM saved WHERE user_id=?').all(user.id).map(x => x.job_id) : [],
          activities: user ? db.prepare('SELECT * FROM activities WHERE user_id=? ORDER BY id DESC LIMIT 20').all(user.id) : [],
          sync: JSON.parse(meta('syncResult') || '{"sources":[]}'), lastSync: meta('lastSuccess') || null,
          email: emailAlerts.state(user?.id), sourceNames,
        });
      }
      if (req.method === 'GET' && path === '/api/discovery') {
        const q = new URL(req.url, 'http://localhost').searchParams;
        return json(res, 200, { links: discoveryLinks(q.get('country') || 'Tunisia', q.get('role') || '') });
      }
      if (req.method === 'GET' && path.startsWith('/api/jobs/')) {
        const row = db.prepare('SELECT data FROM jobs WHERE id=?').get(decodeURIComponent(path.slice('/api/jobs/'.length)));
        if (!row) throw fail(404, 'Job not found.');
        const job = await localAvailability(JSON.parse(row.data));
        return json(res, 200, { job: { ...job, ...(user ? matchJob(job, publicUser(user)) : {}) } });
      }
      if (req.method === 'POST' && ['/api/register', '/api/login'].includes(path)) {
        rateLimit(`auth:${clientIp}`);
        const input = await body(req);
        const email = String(input.email || '').trim().toLowerCase();
        const password = input.password;
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw fail(400, 'Please enter a valid email address.');
        rateLimit(`email:${tokenDigest(email)}`, 15);
        if (typeof password !== 'string' || password.length < 10 || password.length > 128) throw fail(400, 'Use a password between 10 and 128 characters.');
        let row = db.prepare('SELECT * FROM users WHERE email=?').get(email);
        if (path === '/api/register') {
          if (row) throw fail(409, 'An account already exists with this email. Please sign in.');
          let profile;
          try { profile = { ...validateProfile(input),accountType:accountType(input.accountType) }; if(profile.accountType==='recruiter') profile.agentEnabled=false; } catch (e) { throw fail(400, e.message); }
          const passwordHash = await hashPassword(password);
          if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) throw fail(409, 'An account already exists with this email. Please sign in.');
          const id = db.prepare('INSERT INTO users(email,password,profile,created_at) VALUES (?,?,?,?)').run(email, passwordHash, JSON.stringify(profile), new Date().toISOString()).lastInsertRowid;
          row = db.prepare('SELECT * FROM users WHERE id=?').get(id);
          activity(row.id, 'Your next chapter starts here. Your search profile is ready.');
        } else {
          const valid = await verifyPassword(password, row?.password || dummyPasswordHash);
          if (!row || !valid) throw fail(401, 'Email or password is incorrect.');
          if (!row.password.startsWith('scrypt-v2:')) db.prepare('UPDATE users SET password=? WHERE id=?').run(await hashPassword(password), row.id);
        }
        session(res, row.id);
        return json(res, 200, { user: publicUser(row) });
      }
      if (req.method === 'POST' && path === '/api/refresh') {
        const result = await syncFeeds();
        return json(res, result.sources.some(s => s.ok) ? 200 : 502, result);
      }
      if (!user) throw fail(401, 'Create an account or sign in to save your progress.');
      if (path === '/api/recruitment' && req.method==='GET') return json(res,200,recruitment.state(user));
      if (path.startsWith('/api/recruitment/cv/') && req.method==='GET') {
        const row = recruitment.cv(user,decodeURIComponent(path.slice('/api/recruitment/cv/'.length)));
        res.writeHead(200,{'Content-Type':row.cv_type,'Content-Disposition':`attachment; filename="${row.cv_name}"`,'Cache-Control':'no-store'});
        return res.end(Buffer.from(row.cv));
      }
      if (path.startsWith('/api/recruitment/') && req.method==='POST') {
        const action=path.slice('/api/recruitment/'.length), validators={company:companyInput,posting:postingInput,apply:submissionInput,consent:consentInput,review:reviewInput};
        if (!Object.hasOwn(validators,action)) throw fail(404,'Recruitment endpoint not found.');
        return json(res,200,recruitment[action](user,validators[action](await body(req))));
      }
      if (path === '/api/email/link' && req.method === 'POST') { rateLimit(`email-confirm:${user.id}`, 3); await emailAlerts.begin(user); return json(res, 200, { ok: true }); }
      if (path === '/api/email/confirm' && req.method === 'POST') { const input = await body(req); emailAlerts.confirm(user.id, input.code, input.consent); return json(res, 200, { ok: true }); }
      if (path === '/api/email/preferences' && req.method === 'PUT') { emailAlerts.preferences(user.id, await body(req)); return json(res, 200, { ok: true }); }
      if (path === '/api/profile/evidence') {
        if (req.method === 'GET') return json(res, 200, { text: JSON.parse(user.profile).cvText || '' });
        if (req.method === 'PUT') {
          const input = await body(req);
          if (typeof input.text !== 'string' || input.text.length > 60000) throw fail(400, 'CV text must be at most 60,000 characters.');
          db.prepare('UPDATE users SET profile=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(user.profile), cvText: input.text }), user.id);
          return json(res, 200, { ok: true });
        }
      }
      if (path === '/api/profile/import' && req.method === 'POST') {
        rateLimit(`document:${user.id}`, 10);
        const input = await body(req), bytes = Buffer.from(String(input.content || ''), 'base64');
        if (!bytes.length || bytes.length > 5 * 1024 * 1024 || !['application/pdf','text/plain','text/csv'].includes(input.type)) throw fail(400, 'Choose your own LinkedIn PDF, Profile.csv, Skills.csv or TXT export up to 5 MB.');
        const result = await extractDocument(bytes, input.type);
        if (result.warning) throw fail(400, result.warning);
        return json(res, 200, { proposal: proposeLinkedIn(result.text), notice: 'Review suggestions. No changes have been saved.' });
      }
      if (path.startsWith('/api/career/') && req.method === 'POST') {
        try {
          const result = await careerRequest(path.slice('/api/career/'.length), await body(req), JSON.parse(user.profile),
            async id => { const row = db.prepare('SELECT data FROM jobs WHERE id=?').get(id); return row ? JSON.parse(row.data) : null; });
          return json(res, 200, result);
        } catch (error) { throw fail(error.status || 400, error.message); }
      }
      if (req.method === 'POST' && path === '/api/logout') {
        const token = sessionToken(req, security);
        db.prepare('DELETE FROM sessions WHERE token=?').run(tokenDigest(token || ''));
        res.setHeader('Set-Cookie', cookie(security, '', 0));
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && path === '/api/logout-all') {
        db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
        res.setHeader('Set-Cookie', cookie(security, '', 0));
        return json(res, 200, { ok: true });
      }
      if (req.method === 'PUT' && path === '/api/profile') {
        let profile;
        try { profile = validateProfile(await body(req)); } catch (e) { throw fail(e.status || 400, e.message); }
        const previous=JSON.parse(user.profile);
        db.prepare('UPDATE users SET profile=? WHERE id=?').run(JSON.stringify({ ...profile, cvText: previous.cvText || '',cvVersion:previous.cvVersion,accountType:previous.accountType || 'jobseeker' }), user.id);
        emailAlerts.reset(user.id);
        activity(user.id, 'Search preferences updated. Your matches have been recalculated.');
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && path === '/api/cv') {
        const input = await body(req);
        const buffer = Buffer.from(String(input.content || ''), 'base64');
        if (buffer.length === 0 || buffer.length > 5 * 1024 * 1024) throw fail(400, 'Choose a CV file between 1 byte and 5 MB.');
        if (!['application/pdf', 'text/plain'].includes(input.type)) throw fail(400, 'Please use a PDF or TXT CV.');
        if (input.type === 'application/pdf' && buffer.subarray(0, 5).toString() !== '%PDF-') throw fail(400, 'This file is not a valid PDF.');
        const name = String(input.name || 'CV').replace(/[^\w .()-]/g, '_').slice(0, 150);
        const extracted = await extractDocument(buffer, input.type);
        const latest = db.prepare('SELECT profile FROM users WHERE id=?').get(user.id);
        if (!latest) throw fail(401, 'Your session expired.');
        db.prepare('UPDATE users SET cv_name=?,cv_type=?,cv=?,profile=? WHERE id=?').run(name, input.type, buffer, JSON.stringify({ ...JSON.parse(latest.profile), cvText: extracted.text,cvVersion:randomBytes(16).toString('hex') }), user.id);
        activity(user.id, `CV uploaded: ${name}. Your CV stays private in this workspace.`);
        return json(res, 200, { ok: true, warning: extracted.warning });
      }
      if (req.method === 'GET' && path === '/api/cv') {
        const cv = db.prepare('SELECT cv,cv_type,cv_name FROM users WHERE id=?').get(user.id);
        if (!cv.cv) throw fail(404, 'No CV uploaded yet.');
        res.writeHead(200, { 'Content-Type': cv.cv_type, 'Content-Disposition': `attachment; filename="${cv.cv_name}"`, 'Cache-Control': 'no-store' });
        return res.end(Buffer.from(cv.cv));
      }
      if (req.method === 'DELETE' && path === '/api/cv') {
        db.prepare('UPDATE users SET cv_name=NULL,cv_type=NULL,cv=NULL,profile=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(user.profile), cvText: '' }), user.id);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && path === '/api/saved') {
        const input = await body(req);
        if (!db.prepare('SELECT id FROM jobs WHERE id=?').get(String(input.jobId))) throw fail(404, 'This job was not found.');
        const exists = db.prepare('SELECT 1 FROM saved WHERE user_id=? AND job_id=?').get(user.id, input.jobId);
        if (exists) db.prepare('DELETE FROM saved WHERE user_id=? AND job_id=?').run(user.id, input.jobId);
        else db.prepare('INSERT INTO saved VALUES (?,?)').run(user.id, input.jobId);
        return json(res, 200, { saved: !exists });
      }
      if (req.method === 'PUT' && path === '/api/application') {
        const input = await body(req);
        const row = db.prepare('SELECT data FROM jobs WHERE id=?').get(String(input.jobId));
        if (!row) throw fail(404, 'This job was not found.');
        if (!statuses.includes(input.status)) throw fail(400, 'Please choose a valid application status.');
        const notes = String(input.notes || '');
        const followUp = String(input.followUp || '');
        if (notes.length > 5000) throw fail(400, 'Notes must be under 5,000 characters.');
        if (followUp && (!/^\d{4}-\d{2}-\d{2}$/.test(followUp) || Number.isNaN(Date.parse(followUp)) || new Date(followUp).toISOString().slice(0, 10) !== followUp)) throw fail(400, 'Please enter a valid follow-up date.');
        db.prepare('INSERT OR REPLACE INTO applications VALUES (?,?,?,?,?,?)').run(user.id, input.jobId, input.status, notes, followUp, new Date().toISOString());
        const job = JSON.parse(row.data);
        activity(user.id, `${input.status}: ${job.title} at ${job.company}`);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'DELETE' && path === '/api/account') {
        rateLimit(`reauth:${user.id}`, 10);
        const input = await body(req);
        if (typeof input.password !== 'string' || input.password.length > 128 || !await verifyPassword(input.password, user.password)) throw fail(401, 'Enter your current password to delete this account.');
        db.exec('BEGIN');
        try {
          recruitment.remove(user);
          for (const table of ['telegram_links','telegram_pending','telegram_queue']) {
            if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) db.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(user.id);
          }
          for (const table of ['activities', 'saved', 'applications', 'sessions']) db.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(user.id);
          db.prepare('DELETE FROM users WHERE id=?').run(user.id);
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        res.setHeader('Set-Cookie', cookie(security, '', 0));
        return json(res, 200, { ok: true });
      }
      throw fail(404, 'Endpoint not found.');
    }
    if (!['GET', 'HEAD'].includes(req.method)) throw fail(405, 'Method not allowed.');
    const allowed = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/styles.css': 'styles.css', '/icons.js': 'icons.js', '/favicon.svg': 'favicon.svg' };
    const file = allowed[path];
    if (!file) throw fail(404, 'Page not found.');
    const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
    res.writeHead(200, { 'Content-Type': `${types[extname(file)]}; charset=utf-8`, 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : readFileSync(join(root, 'public', file)));
  } catch (error) {
    if (!error.status) console.error(error);
    if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : 'Something went wrong on the server. Please try again.' });
    else res.end();
  }
});

const port = Number(process.env.PORT || 3000);
server.requestTimeout = 30000;
server.headersTimeout = 10000;
server.maxConnections = 100;
server.listen(port, security.host, () => {
  console.log(`Nextstep is running at http://localhost:${server.address().port}`);
  if (process.env.DISABLE_FEEDS !== 'true') syncFeeds().catch(console.error);
});
let ticking = false;
const timer = setInterval(async () => {
  if (ticking) return;
  ticking = true;
  try {
    if (process.env.DISABLE_FEEDS !== 'true') {
      const profiles = db.prepare('SELECT profile FROM users').all().map(row => JSON.parse(row.profile));
      if (dailyRefreshDue(profiles, Number(meta('lastAttempt') || 0))) await syncFeeds();
    }
    if (syncPromise) await syncPromise;
    if (process.env.DISABLE_FEEDS !== 'true') {
      for (const job of jobs()) if (job.source === 'Himalayas' && !job.closed && Date.parse(job.expiresAt) <= Date.now()) closeListing(job);
      const candidates = jobs().filter(j => j.source === 'Himalayas' && !j.closed && (!j.availabilityCheckedAt || Date.now() - Date.parse(j.availabilityCheckedAt) >= 3600000)).sort((a,b) => (a.availabilityCheckedAt || '').localeCompare(b.availabilityCheckedAt || '')).slice(0, 5);
      for (const job of candidates) {
        try { await localAvailability(job); } catch (error) { console.error('[availability]', error.message); }
      }
    }
    emailAlerts.prepare();
    await emailAlerts.drain();
  } catch (error) { console.error('[scheduler]', error.message); }
  finally { ticking = false; }
}, 60000);
timer.unref();
function stop() { clearInterval(timer); server.close(() => { db.close(); process.exit(0); }); }
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
