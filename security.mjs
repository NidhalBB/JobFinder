import { isIP } from 'node:net';

const loopbackHosts = new Set(['127.0.0.1', '::1', 'localhost']);

export function securityConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const host = env.HOST || '127.0.0.1';
  if (!loopbackHosts.has(host)) throw new Error('Bind HOST to loopback. Public access must go through a local HTTPS reverse proxy.');
  let origin;
  if (env.PUBLIC_ORIGIN) {
    const url = new URL(env.PUBLIC_ORIGIN);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('PUBLIC_ORIGIN must be an HTTPS origin without a path, credentials, query, or fragment.');
    }
    origin = url.origin;
  }
  if (production && (!origin || env.TRUST_PROXY !== 'true')) {
    throw new Error('Production requires PUBLIC_ORIGIN=https://your-domain and TRUST_PROXY=true behind a local HTTPS reverse proxy.');
  }
  return { production, host, origin, secureCookies: production || env.COOKIE_SECURE === 'true', cookieName: production ? '__Host-nextstep' : 'nextstep' };
}

export function requestSecurity(req, config) {
  const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
  if (config.production) {
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) fail(403, 'Only the local HTTPS proxy may access this service.');
    if (req.headers['x-forwarded-proto'] !== 'https') fail(426, 'HTTPS is required. Connect through the configured HTTPS site.');
    if (req.headers.host !== new URL(config.origin).host) fail(421, 'Unrecognized site address.');
  } else {
    let hostname;
    try { hostname = new URL(`http://${req.headers.host}`).hostname; } catch { fail(400, 'Invalid host.'); }
    if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname)) fail(421, 'Unrecognized local site address.');
  }
  let clientIp = req.socket.remoteAddress;
  if (config.production) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded !== 'string' || !isIP(forwarded.trim())) fail(400, 'The HTTPS proxy must supply a single client IP address.');
    clientIp = forwarded.trim();
  }
  const origin = config.origin || `http://${req.headers.host}`;
  const mutation = !['GET', 'HEAD'].includes(req.method);
  if (mutation && req.headers.origin && req.headers.origin !== origin) fail(403, 'Cross-origin requests are not allowed.');
  if (mutation && req.headers['sec-fetch-site'] === 'cross-site') fail(403, 'Cross-site requests are not allowed.');
  return clientIp;
}

export function cookie(config, token, maxAge = 604800) {
  return `${config.cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${config.secureCookies ? '; Secure' : ''}`;
}

export function sessionToken(req, config) {
  return req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith(`${config.cookieName}=`))?.slice(config.cookieName.length + 1);
}
