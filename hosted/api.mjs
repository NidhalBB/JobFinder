import { randomBytes, randomUUID } from 'node:crypto';
import { countries, sourceNames, matchJob, statuses, validateProfile } from '../lib.mjs';
import { createSupabase, cvLimit, digest, fail, hostedConfig, readSessionCookie, seal, sessionCookie, sessionDays, unseal } from './supabase.mjs';
import { syncHostedFeeds, hostedAvailability } from './jobs.mjs';
import { careerRequest, proposeLinkedIn } from '../career.mjs';
import { extractDocument } from '../documents.mjs';
import { discoveryLinks } from '../discovery.mjs';
import { accountType, companyInput, postingInput, submissionInput, consentInput, reviewInput } from '../recruitment.mjs';

const jsonHeaders = {
  'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store',
  'Netlify-CDN-Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Strict-Transport-Security': 'max-age=31536000',
};
async function readBody(request, limit = 32768) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw fail(415, 'Use an application/json request.');
  if (Number(request.headers.get('content-length')) > limit) throw fail(413, 'Request body is too large.');
  const reader = request.body?.getReader();
  const parts = [];
  let length = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) { await reader.cancel(); throw fail(413, 'Request body is too large. Hosted CVs may be at most 4 MB.'); }
      parts.push(value);
    }
  }
  try {
    const data = JSON.parse(Buffer.concat(parts).toString() || '{}');
    if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error('Expected object');
    return data;
  } catch { throw fail(400, 'Invalid JSON request. Expected an object.'); }
}
function credentials(input) {
  const email = String(input.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw fail(400, 'Please enter a valid email address.');
  return email;
}
function password(value) {
  if (typeof value !== 'string' || value.length < 10 || value.length > 128) throw fail(400, 'Use a password between 10 and 128 characters.');
  return value;
}
function profileInput(input) {
  try { return validateProfile(input); } catch (error) { throw fail(400, error.message); }
}
function tokensFrom(data) {
  if (typeof data.access_token !== 'string' || typeof data.refresh_token !== 'string' || !Number.isFinite(data.expires_in)) throw fail(502, 'Authentication returned an invalid session.');
  return { access: data.access_token, refresh: data.refresh_token, expiresAt: Date.now() + data.expires_in * 1000 };
}
function routePath(path) {
  const prefix = '/.netlify/functions/api';
  if (!path.startsWith(`${prefix}/`)) return path;
  const suffix = path.slice(prefix.length);
  return ['/healthz', '/auth/callback'].includes(suffix) ? suffix : `/api${suffix}`;
}

export function createHostedHandler({ config: suppliedConfig, fetcher = fetch } = {}) {
  return async function handler(request, context = {}) {
    const headers = new Headers(jsonHeaders);
    const send = (status, data) => new Response(JSON.stringify(data), { status, headers });
    const redirect = location => { headers.set('Location', location); return new Response(null, { status: 303, headers }); };
    try {
      const config = suppliedConfig || hostedConfig();
      const db = createSupabase(config, fetcher);
      const url = new URL(request.url);
      const path = routePath(url.pathname);
      if (context.deploy?.published === false) throw fail(503, 'Private hosted APIs are available only on the published production deployment.');
      if (url.origin !== config.origin) throw fail(421, 'Use the configured public site address.');
      if (path.startsWith('/api/telegram/')) throw fail(410, 'Telegram alerts have been retired. Use email preferences instead.');
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
        if (request.headers.get('origin') !== config.origin || request.headers.get('sec-fetch-site') === 'cross-site') throw fail(403, 'Cross-site requests are not allowed.');
      }
      if (path === '/healthz' && request.method === 'GET') return send(200, { ok: true, mode: 'netlify' });
      if (typeof context.ip !== 'string' || !context.ip) throw fail(503, 'Trusted platform client metadata is unavailable.');
      const rate = async (key, max, seconds = 900) => {
        if (!await db.rpc('ns_rate_limit', { p_key: digest(key), p_max: max, p_seconds: seconds })) throw fail(429, 'Too many requests. Please try again later.');
      };
      await rate(`api:${context.ip}`, 1200);
      const clearCookie = () => headers.set('Set-Cookie', sessionCookie(config));
      const token = readSessionCookie(request, config);
      const hash = token ? digest(token) : null;
      async function startSession(data, recovery = false) {
        if (!data.user?.id || !data.user.email_confirmed_at) throw fail(403, 'Confirm your email address before signing in.');
        const value = randomBytes(32).toString('hex');
        const tokenHash = digest(value);
        const tokens = tokensFrom(data);
        const profiles = await db.rows('ns_profiles', { id: `eq.${data.user.id}`, select: 'id' }, { token: tokens.access });
        if (!profiles.length) throw fail(409, 'This account has no Nextstep profile. Use a dedicated project and register through this dashboard.');
        const lifetime = recovery ? 600 : sessionDays * 86400;
        await db.rows('ns_sessions', {}, { method: 'POST', body: {
          token_hash: tokenHash, user_id: data.user.id, payload: seal(tokens, config.key, tokenHash),
          expires_at: new Date(Date.now() + lifetime * 1000).toISOString(),
          recovery, recovery_expires: recovery ? new Date(Date.now() + 600000).toISOString() : null,
        } });
        headers.set('Set-Cookie', sessionCookie(config, value, lifetime));
      }
      if (path === '/auth/callback' && request.method === 'GET') {
        await rate(`callback:${context.ip}`, 30);
        const type = url.searchParams.get('type');
        const tokenHash = url.searchParams.get('token_hash');
        if (!['email', 'signup', 'recovery'].includes(type) || !/^[a-f0-9]{32,128}$/.test(tokenHash || '')) throw fail(400, 'This confirmation link is invalid. Request a new email.');
        const data = await db.auth('verify', { token_hash: tokenHash, type });
        if (type === 'recovery') await startSession(data, true);
        return redirect(type === 'recovery' ? '/?reset=1' : '/?confirmed=1');
      }
      if (request.method === 'POST' && ['/api/register', '/api/login', '/api/password-reset', '/api/resend-confirmation'].includes(path)) {
        await rate(`auth:${context.ip}`, 30);
        const input = await readBody(request);
        const email = credentials(input);
        await rate(`email:${email}`, 15);
        if (path === '/api/register') {
          const profile = profileInput(input);
          profile.accountType=accountType(input.accountType);
          if(profile.accountType==='recruiter') profile.agentEnabled=false;
          await db.auth(`signup?redirect_to=${encodeURIComponent(`${config.origin}/auth/callback`)}`, { email, password: password(input.password), data: profile });
          return send(202, { confirmationRequired: true, message: 'Check your email to confirm your account, then upload your CV in Profile & preferences.' });
        }
        if (path === '/api/password-reset' || path === '/api/resend-confirmation') {
          const recovery = path === '/api/password-reset';
          await db.auth(`${recovery ? 'recover' : 'resend'}?redirect_to=${encodeURIComponent(`${config.origin}/auth/callback`)}`,
            { email, ...(!recovery ? { type: 'signup' } : {}) });
          return send(200, { message: 'If this address is eligible, an email will arrive shortly. Check spam too.' });
        }
        const data = await db.auth('token?grant_type=password', { email, password: password(input.password) });
        await startSession(data);
        return send(200, { ok: true });
      }
      if (path === '/api/logout' && request.method === 'POST') {
        if (hash) await db.rows('ns_sessions', { token_hash: `eq.${hash}` }, { method: 'DELETE' });
        clearCookie();
        return send(200, { ok: true });
      }
      async function getSession() {
        if (!hash) return null;
        const rows = await db.rows('ns_sessions', { token_hash: `eq.${hash}`, select: '*' });
        const row = rows[0];
        if (!row || Date.parse(row.expires_at) <= Date.now() || (row.recovery && Date.parse(row.recovery_expires) <= Date.now())) {
          if (row) await db.rows('ns_sessions', { token_hash: `eq.${hash}` }, { method: 'DELETE' });
          clearCookie(); return null;
        }
        let tokens = unseal(row.payload, config.key, hash);
        if (tokens.expiresAt <= Date.now() + 60000) {
          if (!await db.rpc('ns_claim_session_refresh', { p_hash: hash })) throw fail(503, 'Your session is refreshing in another request. Try again shortly.');
          let refreshed;
          try { refreshed = await db.auth('token?grant_type=refresh_token', { refresh_token: tokens.refresh }); }
          catch (error) {
            if (error.status !== 401) throw error;
            await db.rows('ns_sessions', { token_hash: `eq.${hash}` }, { method: 'DELETE' });
            clearCookie(); return null;
          }
          tokens = tokensFrom(refreshed);
          const updated = await db.rows('ns_sessions', { token_hash: `eq.${hash}`, expires_at: `gt.${new Date().toISOString()}` }, {
            method: 'PATCH', body: { payload: seal(tokens, config.key, hash), refresh_lock_until: '-infinity' }, headers: { Prefer: 'return=representation' },
          });
          if (!updated.length) { clearCookie(); return null; }
        }
        let user;
        try { user = await db.auth('user', undefined, tokens.access, 'GET'); }
        catch (error) {
          if (error.status !== 401) throw error;
          await db.rows('ns_sessions', { token_hash: `eq.${hash}` }, { method: 'DELETE' });
          clearCookie(); return null;
        }
        if (user.id !== row.user_id || !user.email_confirmed_at) throw fail(401, 'Your session is no longer valid. Sign in again.');
        return { ...row, tokens, user };
      }
      const session = await getSession();
      if (session?.recovery && !['/api/state', '/api/password-reset/complete'].includes(path)) throw fail(403, 'Finish password recovery or sign out before opening your workspace.');
      const access = session && !session.recovery ? session.tokens.access : 'anon';
      const getPage = () => {
        const offset = Number(url.searchParams.get('offset') || 0);
        const selected = url.searchParams.get('country') || 'Tunisia';
        const tab = url.searchParams.get('tab') || 'all';
        const sort = url.searchParams.get('sort') || 'match';
        const source = url.searchParams.get('source') || 'all';
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000 || !['All countries', ...countries].includes(selected)
          || !['all', 'best', 'new', 'remote'].includes(tab) || !['match', 'new', 'company'].includes(sort)
          || !['all', ...sourceNames].includes(source)) throw fail(400, 'Invalid job filters or page.');
        return db.rpc('ns_job_page', { p_country: selected, p_query: (url.searchParams.get('q') || '').slice(0, 200),
          p_tab: tab, p_sort: sort, p_source: source, p_offset: offset, p_limit: 60 }, access);
      };
      if (request.method === 'GET' && path === '/api/state') {
        const data = await db.rpc('ns_state', {}, access);
        if (data.user) data.user.email = session.user.email;
        const page = url.searchParams.get('summary') === '1' ? null : await getPage();
        return send(200, { ...data, hosted: true, countries, ...(page ? { jobs: page.jobs, paging: { ...page, jobs: undefined } } : {}),
          email: { ...data.email, configured: Boolean(config.email) }, cvMaxBytes: cvLimit,
          sourceNames,
          recoveryEmail: session?.recovery ? session.user.email : null,
          passwordRecovery: Boolean(session?.recovery && Date.parse(session.recovery_expires) > Date.now()) });
      }
      if (request.method === 'GET' && path === '/api/discovery') return send(200, { links: discoveryLinks(url.searchParams.get('country') || 'Tunisia', url.searchParams.get('role') || '') });
      if (request.method === 'GET' && path === '/api/jobs') return send(200, await getPage());
      if (request.method === 'GET' && path.startsWith('/api/jobs/')) {
        const id = decodeURIComponent(path.slice('/api/jobs/'.length));
        const rows = await db.rows('ns_jobs', { id: `eq.${id}`, select: 'data' }, { token: access });
        if (!rows.length) throw fail(404, 'This job was not found.');
        const job = await hostedAvailability(db, rows[0].data, fetcher);
        const profiles = session ? await db.rows('ns_profiles', { id: `eq.${session.user.id}`, select: '*' }, { token: access }) : [];
        const p = profiles[0];
        return send(200, { job: { ...job, ...(p ? matchJob(job, { ...p, workMode: p.work_mode }) : {}) } });
      }
      if (!session) throw fail(401, 'Create an account or sign in to save your progress.');
      const user = session.user;
      if (path==='/api/recruitment' && request.method==='GET') return send(200,await db.rpc('ns_recruitment',{p_action:'state'},access));
      if (path.startsWith('/api/recruitment/cv/') && request.method==='GET') {
        const result=await db.rpc('ns_recruitment',{p_action:'cv',p_data:{id:decodeURIComponent(path.slice('/api/recruitment/cv/'.length))}},access);
        const signed=await db.request(`/storage/v1/object/sign/nextstep-cvs/${result.path}`,{method:'POST',body:{expiresIn:60}});
        const location=new URL(`${config.supabase}/storage/v1${signed.signedURL}`);
        if(location.origin!==config.supabase) throw fail(502,'Invalid private download URL.');
        location.searchParams.set('download','CV');
        return redirect(location.href);
      }
      if (path.startsWith('/api/recruitment/') && request.method==='POST') {
        const action=path.slice('/api/recruitment/'.length), validators={company:companyInput,posting:postingInput,apply:submissionInput,consent:consentInput,review:reviewInput};
        if(!Object.hasOwn(validators,action)) throw fail(404,'Recruitment endpoint not found.');
        return send(200,await db.rpc('ns_recruitment',{p_action:action,p_data:validators[action](await readBody(request,90000))},access));
      }
      if (path === '/api/logout-all' && request.method === 'POST') {
        await db.rows('ns_sessions', { user_id: `eq.${user.id}` }, { method: 'DELETE' });
        clearCookie();
        await db.auth('logout?scope=global', undefined, session.tokens.access);
        return send(200, { ok: true });
      }
      if (path === '/api/password-reset/complete' && request.method === 'POST') {
        if (!session.recovery || Date.parse(session.recovery_expires) <= Date.now()) throw fail(403, 'Request a fresh password recovery email first.');
        const input = await readBody(request);
        await db.auth('user', { password: password(input.password) }, session.tokens.access, 'PUT');
        await db.rows('ns_sessions', { user_id: `eq.${user.id}` }, { method: 'DELETE' });
        clearCookie();
        await db.auth('logout?scope=global', undefined, session.tokens.access);
        return send(200, { ok: true });
      }
      if (path === '/api/profile' && request.method === 'PUT') {
        const p = profileInput(await readBody(request));
        await db.rows('ns_profiles', { id: `eq.${user.id}` }, { method: 'PATCH', token: access,
          body: { name: p.name, role: p.role, country: p.country, skills: p.skills, work_mode: p.workMode, agent_enabled: p.agentEnabled, linkedin: p.linkedin, github: p.github, gitlab: p.gitlab } });
        return send(200, { ok: true });
      }
      if (path === '/api/refresh' && request.method === 'POST') {
        await rate(`refresh:${user.id}`, 10);
        const result = await syncHostedFeeds(db, fetcher);
        return send(result.cached || result.sources.some(s => s.ok) ? 200 : 502, result);
      }
      if (path === '/api/saved' && request.method === 'POST') {
        const input = await readBody(request);
        return send(200, { saved: await db.rpc('ns_toggle_saved', { p_job: String(input.jobId || '') }, access) });
      }
      if (path === '/api/application' && request.method === 'PUT') {
        const input = await readBody(request);
        const notes = String(input.notes || ''), date = String(input.followUp || '');
        if (!statuses.includes(input.status) || notes.length > 5000) throw fail(400, 'Choose a valid status and notes under 5,000 characters.');
        if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)) throw fail(400, 'Please enter a valid follow-up date.');
        await db.rpc('ns_save_application', { p_job: String(input.jobId || ''), p_status: input.status, p_notes: notes, p_follow_up: date || null }, access);
        return send(200, { ok: true });
      }
      const profile = async () => (await db.rows('ns_profiles', { id: `eq.${user.id}`, select: '*' }, { token: access }))[0];
      if (path === '/api/email/preferences' && request.method === 'PUT') {
        if (!config.email) throw fail(503, 'Email alerts are not configured by the administrator yet.');
        const input = await readBody(request);
        if (typeof input.enabled !== 'boolean' || !Number.isInteger(input.minScore) || input.minScore < 40 || input.minScore > 100) throw fail(400, 'Choose a threshold from 40 to 100 and an enabled setting.');
        await db.rpc('ns_email_settings', { p_enabled: input.enabled, p_min_score: input.minScore }, access);
        return send(200, { ok: true });
      }
      if (path === '/api/profile/evidence') {
        if (request.method === 'GET') return send(200, { text: (await profile()).cv_text });
        if (request.method === 'PUT') {
          const input = await readBody(request, 250000);
          if (typeof input.text !== 'string' || input.text.length > 60000) throw fail(400, 'CV text must be at most 60,000 characters.');
          await db.rpc('ns_set_evidence', { p_text: input.text }, access);
          return send(200, { ok: true });
        }
      }
      if (path === '/api/profile/import' && request.method === 'POST') {
        await rate(`document:${user.id}`, 10);
        const input = await readBody(request, 5_600_000), bytes = Buffer.from(String(input.content || ''), 'base64');
        if (!bytes.length || bytes.length > cvLimit || !['application/pdf','text/plain','text/csv'].includes(input.type)) throw fail(400, 'Choose your own LinkedIn PDF, Profile.csv, Skills.csv or TXT export, up to 4 MB.');
        const result = await extractDocument(bytes, input.type);
        if (result.warning) throw fail(400, result.warning);
        return send(200, { proposal: proposeLinkedIn(result.text), notice: 'Review these suggestions. Nothing has been saved.' });
      }
      if (path.startsWith('/api/career/') && request.method === 'POST') {
        const p = await profile(), input = await readBody(request, 90000);
        try {
          const result = await careerRequest(path.slice('/api/career/'.length), input, { ...p, cvText: p.cv_text, workMode: p.work_mode }, async id => (await db.rows('ns_jobs', { id: `eq.${id}`, select: 'data' }, { token: access }))[0]?.data);
          return send(200, result);
        } catch (error) { if (error.status) throw error; throw fail(400, error.message); }
      }
      const removeFiles = async paths => {
        if (paths.some(p => typeof p !== 'string' || !p.startsWith(`${user.id}/`) || p.includes('..'))) throw fail(400, 'Invalid private file ownership.');
        if (paths.length) await db.request('/storage/v1/object/nextstep-cvs', { method: 'DELETE', body: { prefixes: paths } });
      };
      if (path === '/api/cv') {
        const p = await profile();
        if (request.method === 'POST') {
          await rate(`cv:${user.id}`, 10);
          const input = await readBody(request, 5_600_000);
          if (typeof input.content !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.content)) throw fail(400, 'Invalid CV encoding.');
          const bytes = Buffer.from(input.content, 'base64');
          if (!bytes.length || bytes.length > cvLimit) throw fail(413, 'Hosted CVs must be between 1 byte and 4 MB.');
          if (!['application/pdf', 'text/plain'].includes(input.type)) throw fail(400, 'Please use a PDF or TXT CV.');
          if (input.type === 'application/pdf' && bytes.subarray(0, 5).toString() !== '%PDF-') throw fail(400, 'This file is not a valid PDF.');
          const name = String(input.name || 'CV').replace(/[^\w .()-]/g, '_').slice(0, 150);
          const extracted = await extractDocument(bytes, input.type);
          const filePath = `${user.id}/${randomUUID()}.${input.type === 'application/pdf' ? 'pdf' : 'txt'}`;
          await db.request(`/storage/v1/object/nextstep-cvs/${filePath}`, { method: 'POST', raw: true, body: bytes,
            headers: { 'Content-Type': input.type, 'x-upsert': 'false', 'cache-control': 'max-age=0' } });
          await db.rpc('ns_replace_cv', { p_user: user.id, p_path: filePath, p_name: name, p_type: input.type, p_expected: p.cv_path });
          await db.rpc('ns_set_evidence', { p_text: extracted.text, p_expected: filePath, p_check_path: true }, access);
          if (p.cv_path) await removeFiles([p.cv_path]);
          return send(200, { ok: true, warning: extracted.warning });
        }
        if (request.method === 'GET') {
          if (!p.cv_path) throw fail(404, 'No CV uploaded yet.');
          const signed = await db.request(`/storage/v1/object/sign/nextstep-cvs/${p.cv_path}`, { method: 'POST', body: { expiresIn: 60 } });
          const location = new URL(`${config.supabase}/storage/v1${signed.signedURL}`);
          if (location.origin !== config.supabase) throw fail(502, 'Invalid private download URL.');
          location.searchParams.set('download', p.cv_name);
          return redirect(location.href);
        }
        if (request.method === 'DELETE') {
          if (p.cv_path) await removeFiles([p.cv_path]);
          await db.rpc('ns_replace_cv', { p_user: user.id, p_path: null, p_name: null, p_type: null, p_expected: p.cv_path });
          return send(200, { ok: true });
        }
      }
      if (path === '/api/account' && request.method === 'DELETE') {
        await rate(`reauth:${user.id}`, 10);
        const input = await readBody(request);
        const confirmed = await db.auth('token?grant_type=password', { email: user.email, password: password(input.password) });
        if (confirmed.user?.id !== user.id) throw fail(403, 'Account verification failed.');
        for (let batch = 0; batch < 5; batch++) {
          const files = await db.request('/storage/v1/object/list/nextstep-cvs', { method: 'POST', body: { prefix: `${user.id}/`, limit: 100 } });
          if (!files.length) {
            await db.request(`/auth/v1/admin/users/${user.id}`, { method: 'DELETE', body: { should_soft_delete: false } });
            clearCookie();
            return send(200, { ok: true });
          }
          await removeFiles(files.map(f => `${user.id}/${f.name}`));
        }
        throw fail(409, 'Private files are still being removed. Repeat account deletion to finish.');
      }
      throw fail(404, 'API endpoint not found.');
    } catch (error) {
      if (!error.status) console.error('[hosted-api]', error.name);
      return send(error.status || 503, { error: error.status ? error.message : 'Hosted setup is incomplete or unavailable. The administrator should check configuration and function logs.' });
    }
  };
}
