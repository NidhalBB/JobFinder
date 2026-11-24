import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { emailConfig } from '../email.mjs';

export const fail = (status, message) => Object.assign(new Error(message), { status });
export const digest = value => createHash('sha256').update(value).digest('hex');
export const cvLimit = 4 * 1024 * 1024;
export const sessionDays = 7;
export function scheduledFetch() {
  const deadline = AbortSignal.timeout(25000);
  return (url, options = {}) => fetch(url, { ...options, signal: options.signal ? AbortSignal.any([deadline, options.signal]) : deadline });
}

export function hostedConfig(env = process.env) {
  const origin = new URL(env.PUBLIC_ORIGIN || env.URL || '');
  const local = env.NETLIFY_DEV === 'true' && origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname);
  if ((!local && origin.protocol !== 'https:') || origin.origin !== (env.PUBLIC_ORIGIN || env.URL)) throw new Error('PUBLIC_ORIGIN must be the exact HTTPS site origin, without a trailing slash.');
  const supabase = new URL(env.SUPABASE_URL || '');
  if (supabase.protocol !== 'https:' || supabase.origin !== env.SUPABASE_URL) throw new Error('SUPABASE_URL must be the exact HTTPS project origin.');
  const anon = env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY;
  const service = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  if (!anon || !service || anon === service) throw new Error('Set separate Supabase publishable/anon and server-only secret/service-role keys.');
  const key = Buffer.from(env.SESSION_ENCRYPTION_KEY || '', 'base64');
  if (key.length !== 32 || key.toString('base64') !== env.SESSION_ENCRYPTION_KEY) throw new Error('SESSION_ENCRYPTION_KEY must be 32 random bytes, encoded as base64.');
  return { origin: origin.origin, supabase: supabase.origin, anon, service, key, local,
    cookieName: local ? 'nextstep-hosted' : '__Host-nextstep',
    email: emailConfig({ ...env, PUBLIC_ORIGIN: origin.origin }) };
}

export function seal(value, key, hash) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(hash));
  const content = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), content.toString('base64url')].join('.');
}
export function unseal(value, key, hash) {
  const [version, iv, tag, content, extra] = value.split('.');
  if (version !== 'v1' || extra || !iv || !tag || !content) throw new Error('Invalid encrypted session.');
  const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  cipher.setAAD(Buffer.from(hash));
  cipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return JSON.parse(Buffer.concat([cipher.update(Buffer.from(content, 'base64url')), cipher.final()]).toString());
}
export function sessionCookie(config, token = '', maxAge = sessionDays * 86400) {
  return `${config.cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${token ? maxAge : 0}${config.local ? '' : '; Secure'}`;
}
export function readSessionCookie(request, config) {
  const token = (request.headers.get('cookie') || '').split(';').map(x => x.trim()).find(x => x.startsWith(`${config.cookieName}=`))?.slice(config.cookieName.length + 1);
  return /^[a-f0-9]{64}$/.test(token || '') ? token : null;
}

export function createSupabase(config, fetcher = fetch) {
  async function request(path, { method = 'GET', body, token = 'service', raw = false, headers: extra = {} } = {}) {
    const key = token === 'service' ? config.service : config.anon;
    const headers = { apikey: key, ...extra };
    if (token !== 'service' && token !== 'anon') headers.Authorization = `Bearer ${token}`;
    else if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;
    if (body !== undefined && !raw) headers['Content-Type'] = 'application/json';
    let response;
    try {
      response = await fetcher(`${config.supabase}${path}`, {
        method, headers, body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(10000), redirect: 'error',
      });
    } catch (error) {
      console.error('[hosted-provider]', error.name);
      throw fail(503, 'The hosted data service could not be reached. Please try again.');
    }
    let data;
    try { data = response.status === 204 ? null : await response.json(); }
    catch { throw fail(502, 'The hosted data service returned an unreadable response.'); }
    if (!response.ok) {
      if (path.startsWith('/auth/v1/') && response.status < 500) throw fail(response.status === 429 ? 429 : 401, response.status === 429 ? 'Too many authentication requests. Please try again later.' : 'Authentication failed. Check your credentials, confirmation email, or recovery link.');
      if (/^PT(400|404|409|429)$/.test(data?.code || '')) throw fail(Number(data.code.slice(2)), data.message);
      console.error('[hosted-provider]', path.split('/').slice(1, 3).join('/'), response.status, String(data?.code || 'provider_error').slice(0, 60));
      throw fail(502, 'A hosted data operation failed. The administrator should check database setup and function logs.');
    }
    return data;
  }
  const rows = (table, query = {}, options = {}) => request(`/rest/v1/${table}?${new URLSearchParams(query)}`, options);
  const rpc = (name, body = {}, token = 'service') => request(`/rest/v1/rpc/${name}`, { method: 'POST', body, token });
  const auth = (path, body, token = 'anon', method = 'POST') => request(`/auth/v1/${path}`, { method, token, body });
  return { request, rows, rpc, auth };
}
