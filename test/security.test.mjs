import { test } from 'node:test';
import assert from 'node:assert/strict';
import { securityConfig, requestSecurity, cookie } from '../security.mjs';

const env = { NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://jobs.example.test', TRUST_PROXY: 'true' };
const secure = securityConfig(env);
const request = headers => ({ headers: { host: 'jobs.example.test', 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.1', ...headers }, socket: { remoteAddress: '127.0.0.1' } });

test('public deployment fails closed without HTTPS and trusted loopback proxy configuration', () => {
  assert.throws(() => securityConfig({ NODE_ENV: 'production' }), /Production requires/);
  assert.throws(() => securityConfig({ ...env, PUBLIC_ORIGIN: 'http://jobs.example.test' }), /HTTPS origin/);
  assert.throws(() => securityConfig({ ...env, PUBLIC_ORIGIN: 'https://jobs.example.test/path' }), /without a path/);
  assert.throws(() => securityConfig({ ...env, HOST: '0.0.0.0' }), /loopback/);
  assert.throws(() => securityConfig({ HOST: '0.0.0.0' }), /loopback/);
});
test('only trusted HTTPS requests reach the production app', () => {
  assert.equal(requestSecurity(request(), secure), '203.0.113.1');
  assert.throws(() => requestSecurity(request({ 'x-forwarded-proto': 'http' }), secure), { status: 426 });
  assert.throws(() => requestSecurity(request({ 'x-forwarded-proto': undefined }), secure), { status: 426 });
  assert.throws(() => requestSecurity({ ...request(), socket: { remoteAddress: '203.0.113.2' } }, secure), { status: 403 });
  assert.throws(() => requestSecurity(request({ host: 'attacker.test' }), secure), { status: 421 });
  assert.throws(() => requestSecurity(request({ origin: 'http://jobs.example.test' }), secure), { status: 403 });
  assert.throws(() => requestSecurity(request({ 'x-forwarded-for': 'attacker, 203.0.113.1' }), secure), { status: 400 });
  assert.equal(requestSecurity({ ...request({ 'sec-fetch-site': 'cross-site' }), method: 'GET' }, secure), '203.0.113.1');
});
test('production sessions always use host-only Secure cookies, including deletion', () => {
  assert.match(cookie(secure, 'abc'), /^__Host-nextstep=abc;/);
  assert.match(cookie(secure, 'abc'), /; Secure$/);
  assert.match(cookie(secure, '', 0), /Max-Age=0; Secure$/);
  assert.doesNotMatch(cookie(secure, 'abc'), /Domain=/);
  assert.doesNotMatch(cookie(securityConfig({}), 'abc'), /; Secure/);
});
