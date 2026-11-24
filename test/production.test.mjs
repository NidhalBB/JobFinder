import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';

function proxyFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, options, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

test('production HTTP listener refuses insecure traffic and issues secure sessions only through its configured proxy', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'nextstep-production-'));
  const child = spawn(process.execPath, ['server.mjs'], {
    env: { ...process.env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '0', PUBLIC_ORIGIN: 'https://jobs.example.test', TRUST_PROXY: 'true', DATA_DIR: dir, DISABLE_FEEDS: 'true', TELEGRAM_BOT_TOKEN: '', TELEGRAM_BOT_USERNAME: '', TELEGRAM_WEBHOOK_SECRET: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null) {
      const done = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await done;
    }
    for (const name of readdirSync(dir)) rmSync(join(dir, name));
    rmdirSync(dir);
  });
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Production test server did not start')), 15000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.stdout.on('data', chunk => {
      const port = chunk.toString().match(/localhost:(\d+)/)?.[1];
      if (port) { clearTimeout(timer); resolve(`http://127.0.0.1:${port}`); }
    });
  });
  assert.equal((await fetch(`${base}/api/state`)).status, 426);
  const headers = { host: 'jobs.example.test', 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.1' };
  const health = await proxyFetch(`${base}/healthz`, { headers });
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('strict-transport-security'), 'max-age=31536000');
  assert.equal((await proxyFetch(`${base}/api/state`, { headers: { ...headers, host: 'evil.test' } })).status, 421);
  assert.equal((await proxyFetch(`${base}/api/register`, { method: 'POST', headers: { ...headers, Origin: 'https://evil.test' } })).status, 403);
  const signup = await proxyFetch(`${base}/api/register`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', Origin: 'https://jobs.example.test' },
    body: JSON.stringify({ email: 'production@example.test', password: 'production-test-only', name: 'Production Test', country: 'Netherlands', role: 'Designer', workMode: 'Any' }),
  });
  assert.equal(signup.status, 200);
  const cookie = signup.headers.get('set-cookie');
  assert.match(cookie, /^__Host-nextstep=/);
  assert.match(cookie, /HttpOnly; SameSite=Strict; Path=\/; Max-Age=604800; Secure/);
  const state = await (await proxyFetch(`${base}/api/state`, { headers: { ...headers, Cookie: cookie.split(';')[0] } })).json();
  assert.equal(state.user.email, 'production@example.test');
});
