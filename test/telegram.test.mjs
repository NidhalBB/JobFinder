import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createTelegram, telegramConfig } from '../telegram.mjs';

const config = { token: 'test-token-never-sent', username: 'nextstep_test_bot', secret: 'a'.repeat(40), origin: 'https://jobs.example.test' };
const profile = { name: 'Private Name', role: 'Designer', country: 'Netherlands', skills: 'Figma', workMode: 'Remote' };
function setup(t, transport) {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE users(id INTEGER PRIMARY KEY,profile TEXT);
    CREATE TABLE jobs(id TEXT PRIMARY KEY,data TEXT);
    CREATE TABLE activities(user_id INTEGER,message TEXT,created_at TEXT);
    CREATE TABLE applications(user_id INTEGER,job_id TEXT,follow_up TEXT,status TEXT);
  `);
  for (const id of [1, 2]) db.prepare('INSERT INTO users VALUES (?,?)').run(id, JSON.stringify(profile));
  const messages = [];
  const send = transport || (async (_, chatId, text) => { messages.push({ chatId, text }); });
  const telegram = createTelegram(db, config, send);
  t.after(() => db.close());
  return { db, telegram, messages };
}
const update = (token, id = 123456) => ({ message: { text: `/start ${token}`, chat: { id, type: 'private' }, from: { id, is_bot: false } } });
async function connect(ctx, user = 1, chatId = 123456) {
  const now = Date.now();
  const { url } = ctx.telegram.beginLink(user, now);
  const token = new URL(url).searchParams.get('start');
  await ctx.telegram.webhook(config.secret, update(token, chatId), now);
  const code = ctx.messages.at(-1)?.text.match(/code: (\d{6})/)[1];
  ctx.telegram.confirm(user, code, true, now);
  return now;
}
function addEvent(db, id, kind = 'new', overrides = {}) {
  const job = { id, title: 'Designer', company: 'Public Company', tags: ['Figma'], description: 'Figma design', country: 'Netherlands', remote: true, ...overrides };
  db.prepare('INSERT OR REPLACE INTO jobs VALUES (?,?)').run(id, JSON.stringify(job));
  db.prepare('INSERT INTO job_events(job_id,kind,created_at) VALUES (?,?,?)').run(id, kind, Date.now());
}

test('Telegram stays disabled without secrets and rejects partial configuration', t => {
  const { db } = setup(t);
  const disabled = createTelegram(db, null);
  assert.deepEqual(disabled.state(), { configured: false, linked: false });
  assert.throws(() => disabled.beginLink(1), { status: 503 });
  assert.equal(telegramConfig({}), null);
  assert.throws(() => telegramConfig({ TELEGRAM_BOT_USERNAME: 'example_bot' }), /requires a valid bot token/);
});
test('linking requires authenticated ownership, a private Telegram chat, a one-time code, and consent', async t => {
  const ctx = setup(t);
  const { url } = ctx.telegram.beginLink(1);
  const token = new URL(url).searchParams.get('start');
  assert.notEqual(ctx.db.prepare('SELECT token_hash FROM telegram_pending').get().token_hash, token);
  await assert.rejects(ctx.telegram.webhook('wrong', update(token)), { status: 403 });
  await assert.rejects(ctx.telegram.webhook('\u00e9'.repeat(40), update(token)), { status: 403 });
  const group = update(token); group.message.chat.type = 'group';
  await ctx.telegram.webhook(config.secret, group);
  assert.equal(ctx.messages.length, 0);
  await ctx.telegram.webhook(config.secret, update(token));
  assert.equal(ctx.telegram.state(1).linked, false);
  assert.equal(ctx.telegram.state(1).awaitingCode, true);
  const code = ctx.messages[0].text.match(/code: (\d{6})/)[1];
  assert.throws(() => ctx.telegram.confirm(2, code, true), { status: 400 });
  assert.throws(() => ctx.telegram.confirm(1, code, false), { status: 400 });
  assert.throws(() => ctx.telegram.confirm(1, 'not-a-code', true), { status: 400 });
  ctx.telegram.confirm(1, code, true);
  assert.equal(ctx.telegram.state(1).enabled, true);
  assert.equal(ctx.telegram.state(2).linked, false);
  assert.equal(ctx.telegram.state(1).chat_id, undefined);
  await ctx.telegram.webhook(config.secret, update(token));
  assert.equal(ctx.messages.length, 1);
  assert.throws(() => ctx.telegram.confirm(1, code, true), { status: 400 });
});
test('expired tokens and five wrong codes cannot bind an account', async t => {
  const ctx = setup(t);
  let link = ctx.telegram.beginLink(1);
  await ctx.telegram.webhook(config.secret, update(new URL(link.url).searchParams.get('start')), Date.now() + 11 * 60000);
  assert.equal(ctx.messages.length, 0);
  link = ctx.telegram.beginLink(1);
  await ctx.telegram.webhook(config.secret, update(new URL(link.url).searchParams.get('start')));
  for (let i = 0; i < 5; i++) assert.throws(() => ctx.telegram.confirm(1, '000000', true), { status: 400 });
  assert.equal(ctx.telegram.state(1).pending, false);
  assert.equal(ctx.telegram.state(1).linked, false);
});
test('daily digests enforce threshold and eligibility, deduplicate, and never expose profile data', async t => {
  const ctx = setup(t);
  const linked = await connect(ctx);
  addEvent(ctx.db, 'wrong-country', 'new', { country: 'Brazil' });
  addEvent(ctx.db, 'low-score', 'new', { title: 'Accountant', description: 'Tax work', tags: [] });
  ctx.telegram.prepareDigests(linked + 86400000);
  assert.equal(ctx.db.prepare('SELECT count(*) AS n FROM telegram_queue').get().n, 0);
  addEvent(ctx.db, 'match');
  ctx.telegram.prepareDigests(linked + 2 * 86400000 - 1);
  assert.equal(ctx.db.prepare('SELECT count(*) AS n FROM telegram_queue').get().n, 0);
  ctx.telegram.prepareDigests(linked + 2 * 86400000);
  ctx.telegram.prepareDigests(linked + 2 * 86400000);
  assert.equal(ctx.db.prepare('SELECT count(*) AS n FROM telegram_queue').get().n, 1);
  await ctx.telegram.drain(linked + 2 * 86400000);
  await ctx.telegram.drain(linked + 2 * 86400000);
  assert.equal(ctx.messages.length, 2);
  const digest = ctx.messages[1].text;
  assert.match(digest, /New matching positions/);
  assert.doesNotMatch(digest, /Private Name|Figma|Netherlands|Designer|Public Company/);
  assert.equal(ctx.telegram.state(1).delivery.status, 'sent');
});
test('rate-limit retries persist without duplicating successful deliveries', async t => {
  let sends = 0;
  const ctx = setup(t);
  const linked = await connect(ctx);
  const resumed = createTelegram(ctx.db, config, async () => {
    sends++;
    if (sends === 1) throw Object.assign(new Error('Rate limited'), { code: 429, retryAfter: 120 });
  });
  resumed.queueTest(1, linked);
  await resumed.drain(linked);
  assert.equal(resumed.state(1).delivery.status, 'pending');
  await resumed.drain(linked + 119999);
  assert.equal(sends, 1);
  await resumed.drain(linked + 120000);
  assert.equal(sends, 2);
  assert.equal(resumed.state(1).delivery.status, 'sent');
  await resumed.drain(linked + 240000);
  assert.equal(sends, 2);
});
test('tracked changes and follow-ups trigger alerts; disconnect and /stop clear queued data', async t => {
  const ctx = setup(t);
  const linked = await connect(ctx);
  addEvent(ctx.db, 'tracked', 'updated', { country: 'Brazil' });
  ctx.db.prepare('INSERT INTO applications VALUES (?,?,?,?)').run(1, 'tracked', '2020-01-01', 'Interview');
  ctx.telegram.prepareDigests(linked + 86400000);
  const queued = ctx.db.prepare('SELECT text FROM telegram_queue').get().text;
  assert.match(queued, /tracked job listing has changed/);
  assert.match(queued, /follow-up is due/);
  await ctx.telegram.webhook(config.secret, { message: { chat: { id: 123456, type: 'private' }, from: { id: 123456 }, text: '/stop' } });
  assert.equal(ctx.telegram.state(1).linked, false);
  assert.equal(ctx.db.prepare('SELECT count(*) AS n FROM telegram_queue').get().n, 0);
  await ctx.telegram.drain(linked + 86400000);
  assert.equal(ctx.messages.length, 1);
});
test('disconnecting while a paced delivery waits prevents sending that alert', async t => {
  const ctx = setup(t);
  const linked = await connect(ctx);
  ctx.telegram.queueTest(1, linked);
  const delivering = ctx.telegram.drain(linked);
  ctx.telegram.disconnect(1);
  await delivering;
  assert.equal(ctx.messages.length, 1);
  assert.equal(ctx.telegram.state(1).linked, false);
});
