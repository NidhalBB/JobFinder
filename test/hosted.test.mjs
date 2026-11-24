import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { countries, countryMatches, matchJob, feeds } from '../lib.mjs';
import { createHostedHandler } from '../hosted/api.mjs';
import { createSupabase, digest, hostedConfig, seal, sessionCookie, unseal } from '../hosted/supabase.mjs';
import { createHostedTelegram } from '../hosted/telegram.mjs';
import { syncHostedFeeds } from '../hosted/jobs.mjs';

const config = hostedConfig({
  PUBLIC_ORIGIN: 'https://nextstep.example', SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', SUPABASE_SECRET_KEY: 'sb_secret_test',
  SESSION_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
});
const alice = '11111111-1111-4111-8111-111111111111', bob = '22222222-2222-4222-8222-222222222222';
const profile = { name: 'Test User', country: 'Tunisia', role: 'Software Engineer', skills: 'JavaScript, SQL', workMode: 'Remote', agentEnabled: true };
const job = { id: 'fixture-1', company: 'Fixture', title: 'Software Engineer', tags: ['SQL'],
  country: 'EMEA', location: 'Remote EMEA', description: 'JavaScript SQL', remote: true,
  source: 'Jobicy', publishedAt: new Date().toISOString(), url: 'https://example.com/job' };
const eligible = countries.filter(c => countryMatches(job, c));

test('hosted sessions are encrypted, bound to their cookie digest, and never cacheable', async () => {
  const hash = digest('session-a'), data = { access: 'private-access', refresh: 'private-refresh', expiresAt: Date.now() };
  const encrypted = seal(data, config.key, hash);
  assert.ok(!encrypted.includes(data.refresh));
  assert.deepEqual(unseal(encrypted, config.key, hash), data);
  assert.throws(() => unseal(encrypted, config.key, digest('session-b')));
  assert.throws(() => unseal(encrypted, randomBytes(32), hash));
  assert.match(sessionCookie(config, 'a'), /__Host-nextstep=a; Path=\/; HttpOnly; SameSite=Strict; Max-Age=604800; Secure/);
  let calls = 0;
  const handler = createHostedHandler({ config, fetcher: async () => { calls++; throw new Error('Must not call provider'); } });
  const response = await handler(new Request(`${config.origin}/api/profile`, { method: 'PUT', headers: { Origin: 'https://evil.example' } }), { ip: '192.0.2.1' });
  assert.equal(response.status, 403);
  assert.equal(response.headers.get('netlify-cdn-cache-control'), 'no-store');
  assert.equal(calls, 0);
  const wrongOrigin = await handler(new Request('https://preview.example/api/state'), { ip: '192.0.2.1' });
  assert.equal(wrongOrigin.status, 421);
});

test('hosted database enforces ownership, pagination, atomic changes and durable notification retries', async t => {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema storage;
    grant usage on schema public,auth,storage to anon,authenticated,service_role;
    create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb,email_confirmed_at timestamptz default now());
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);
    alter table storage.objects enable row level security;
    grant select,insert,update,delete on storage.objects to authenticated;
    grant all on storage.objects to service_role;
    create function storage.foldername(text) returns text[] language sql immutable as $$ select string_to_array($1,'/') $$;
  `);
  for (const migration of ['001_nextstep.sql', '002_telegram.sql', '003_career_email.sql', '004_recruitment.sql']) {
    const sql = await readFile(new URL(`../supabase/migrations/${migration}`, import.meta.url), 'utf8');
    await db.exec(sql);
    await db.exec(sql);
  }
  const query = async (sql, params = []) => (await db.query(sql, params)).rows;
  const rpc = async (name, args = {}) => {
    const entries = Object.entries(args);
    const parameters = entries.map(([, value]) => typeof value === 'object' && value !== null ? JSON.stringify(value) : value);
    const rows = await query(`select public.${name}(${entries.map(([key], i) => `${key} => $${i + 1}`).join(',')}) result`, parameters);
    return rows[0].result;
  };
  const identity = async (id, role = 'authenticated') => {
    await db.exec('reset role');
    await query("select set_config('request.jwt.claim.sub',$1,false)", [id || '']);
    await db.exec(`set role ${role}`);
  };
  try {
    await query('insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3),($4,$5,$6)', [alice, 'alice@example.test', profile, bob, 'bob@example.test', { ...profile, name: 'Other User' }]);
    await rpc('ns_import_jobs', { p_jobs: [{ data: job, fingerprint: 'version1', eligibleCountries: eligible }] });

    await t.test('matching agrees with shared country/keyword rules', async () => {
      for (const p of [profile, { ...profile, country: 'United States', role: 'Sales', skills: '', workMode: 'Any' }, { ...profile, skills: 'SQL, missing, JavaScript', workMode: 'On-site' }]) {
        const [result] = await query('select public.ns_match($1::jsonb,$2::text[],$3::jsonb) m', [job, eligible, p]);
        assert.deepEqual(result.m, matchJob(job, p));
      }
    });
    await t.test('another account cannot read or modify private rows or CV metadata', async () => {
      await identity(alice);
      assert.equal((await query('select id from public.ns_profiles')).length, 1);
      assert.equal((await query('select id from public.ns_profiles'))[0].id, alice);
      await rpc('ns_toggle_saved', { p_job: job.id });
      await rpc('ns_save_application', { p_job: job.id, p_status: 'Applied', p_notes: 'Private note', p_follow_up: '2026-01-01' });
      await assert.rejects(query("update public.ns_profiles set cv_path='someone-else/file.pdf'"), /permission denied/);
      await assert.rejects(query('select * from public.ns_sessions'), /permission denied/);
      await assert.rejects(rpc('ns_telegram', { p_action: 'disconnect', p_user: bob }), /permission denied/);
      await identity(bob);
      assert.equal((await query('select * from public.ns_applications')).length, 0);
      assert.equal((await query("update public.ns_profiles set name='Not allowed' where id=$1 returning id", [alice])).length, 0);
      const state = await rpc('ns_state');
      assert.equal(state.saved.length, 0);
      assert.equal(state.applications.length, 0);
      assert.ok(!JSON.stringify(state).includes('Private note'));
      await assert.rejects(query("insert into storage.objects(bucket_id,name) values('nextstep-cvs',$1)", [`${bob}/bypass.pdf`]), /row-level security/);
    });
    await t.test('discovery pages omit descriptions but retain full-text search and accurate totals', async () => {
      await identity(null, 'service_role');
      const more = Array.from({ length: 64 }, (_, n) => ({ data: { ...job, id: `page-${n}` }, fingerprint: `page-${n}`, eligibleCountries: eligible }));
      await rpc('ns_import_jobs', { p_jobs: more });
      await identity(alice);
      const first = await rpc('ns_job_page', { p_country: 'Tunisia', p_query: 'JavaScript' });
      assert.equal(first.total, 65);
      assert.equal(first.jobs.length, 60);
      assert.equal(first.nextOffset, 60);
      assert.ok(first.jobs.every(j => !('description' in j) && j.score === 100));
      const last = await rpc('ns_job_page', { p_country: 'Tunisia', p_offset: 60 });
      assert.equal(last.jobs.length, 5);
      assert.equal(last.nextOffset, null);
      assert.equal(new Set([...first.jobs, ...last.jobs].map(j => j.id)).size, 65);
      const state = await rpc('ns_state');
      assert.equal(state.ownedJobs[0].id, job.id);
      assert.ok(!('description' in state.ownedJobs[0]));
      assert.equal(state.applications[0].notes, 'Private note');
      await identity(null, 'anon');
      assert.equal((await rpc('ns_state')).user, null);
      await assert.rejects(rpc('ns_toggle_saved', { p_job: job.id }), /permission denied/);
    });
    await t.test('feed imports are idempotent and changes atomically create events and activity', async () => {
      await identity(null, 'service_role');
      const before = (await query('select count(*)::int n from public.ns_job_events'))[0].n;
      assert.deepEqual(await rpc('ns_import_jobs', { p_jobs: [{ data: job, fingerprint: 'version1', eligibleCountries: eligible }] }), { added: 0, updated: 0 });
      await rpc('ns_import_jobs', { p_jobs: [{ data: { ...job, description: 'Changed listing' }, fingerprint: 'version2', eligibleCountries: eligible }] });
      assert.equal((await query('select count(*)::int n from public.ns_job_events'))[0].n, before + 1);
      assert.ok((await query('select message from public.ns_activities where user_id=$1', [alice])).some(a => a.message.startsWith('Listing updated:')));
      assert.equal(await rpc('ns_claim_feed_refresh'), true);
      assert.equal(await rpc('ns_claim_feed_refresh'), false);
      for (let i = 0; i < 3; i++) assert.equal(await rpc('ns_rate_limit', { p_key: 'limit-test', p_max: 2, p_seconds: 900 }), i < 2);
    });
    await t.test('Telegram linking requires consent and private-chat ownership, guesses expire durably', async () => {
      await identity(null, 'service_role');
      const fakeDb = { rpc, rows: async () => [] };
      const sent = [];
      const bot = { token: 'fake-token', username: 'test_bot', secret: 'webhook-secret', origin: config.origin };
      const telegram = createHostedTelegram(fakeDb, bot, async (_url, init) => { sent.push(JSON.parse(init.body)); return Response.json({ ok: true }); });
      const pending = await telegram.handle('link', 'POST', alice, {});
      const nonce = new URL(pending.url).searchParams.get('start');
      await assert.rejects(telegram.webhook('wrong-secret', {}), { status: 403 });
      await telegram.webhook(bot.secret, { message: { text: `/start ${nonce}`, chat: { id: 1234, type: 'private' }, from: { id: 4321 } } });
      assert.equal(sent.length, 0);
      await telegram.webhook(bot.secret, { message: { text: `/start ${nonce}`, chat: { id: 1234, type: 'private' }, from: { id: 1234 } } });
      const code = /\b\d{6}\b/.exec(sent[0].text)[0];
      await assert.rejects(telegram.handle('confirm', 'POST', alice, { code, consent: false }), { status: 400 });
      await assert.rejects(telegram.handle('confirm', 'POST', bob, { code, consent: true }), { status: 400 });
      for (let i = 0; i < 5; i++) await assert.rejects(telegram.handle('confirm', 'POST', alice, { code: '000000', consent: true }), { status: 400 });
      await assert.rejects(telegram.handle('confirm', 'POST', alice, { code, consent: true }), { status: 400 });
      const again = await telegram.handle('link', 'POST', alice, {});
      await telegram.webhook(bot.secret, { message: { text: `/start ${new URL(again.url).searchParams.get('start')}`, chat: { id: 1234, type: 'private' }, from: { id: 1234 } } });
      await telegram.handle('confirm', 'POST', alice, { code: /\b\d{6}\b/.exec(sent[1].text)[0], consent: true });
      assert.equal((await query('select * from public.ns_telegram_links'))[0].user_id, alice);
      await telegram.handle('test', 'POST', alice, {});
      await assert.rejects(telegram.handle('test', 'POST', alice, {}), /already queued/);
      const lease = '33333333-3333-4333-8333-333333333333';
      const batch = await rpc('ns_telegram', { p_action: 'claim', p_data: { lease } });
      assert.equal(batch.length, 1);
      assert.ok(!batch[0].text.includes('Private note'));
      await rpc('ns_telegram', { p_action: 'finish', p_data: { id: batch[0].id, lease, result: 'limited', retryAfter: 120, error: 'Rate limited' } });
      assert.deepEqual(await rpc('ns_telegram', { p_action: 'claim', p_data: { lease } }), []);
      await telegram.webhook(bot.secret, { message: { text: '/stop', chat: { id: 1234, type: 'private' }, from: { id: 1234 } } });
      assert.equal((await query('select * from public.ns_telegram_links')).length, 0);
      assert.equal((await query('select * from public.ns_telegram_queue')).length, 0);
    });
    await t.test('hosted daily digests respect geography, consent windows, agent pause and tracked changes', async () => {
      await identity(null, 'service_role');
      await query('update public.ns_applications set follow_up=null where user_id=$1', [alice]);
      await query("insert into public.ns_meta values('lastSuccess',to_jsonb(now())) on conflict(key) do update set value=excluded.value");
      await query("insert into public.ns_telegram_links(user_id,chat_id,cursor,last_digest) values($1,'1234',(select max(id) from public.ns_job_events),now()-interval '25 hours')", [alice]);
      const imported = async j => rpc('ns_import_jobs', { p_jobs: [{ data: j, fingerprint: digest(JSON.stringify(j)), eligibleCountries: countries.filter(c => countryMatches(j, c)) }] });
      await imported({ ...job, id: 'outside-country', country: 'United States' });
      await rpc('ns_telegram', { p_action: 'prepare', p_data: { origin: config.origin } });
      assert.equal((await query('select * from public.ns_telegram_queue')).length, 0);
      await query("update public.ns_telegram_links set last_digest=now()-interval '25 hours' where user_id=$1", [alice]);
      await imported({ ...job, id: 'eligible-digest' });
      await rpc('ns_telegram', { p_action: 'prepare', p_data: { origin: config.origin } });
      const [digestRow] = await query('select text from public.ns_telegram_queue');
      assert.match(digestRow.text, /New matching positions/);
      assert.ok(!digestRow.text.includes('JavaScript') && !digestRow.text.includes('Private note'));
      await rpc('ns_telegram', { p_action: 'prepare', p_data: { origin: config.origin } });
      assert.equal((await query('select * from public.ns_telegram_queue')).length, 1);
      await identity(alice);
      await query('update public.ns_profiles set agent_enabled=false where id=$1', [alice]);
      await identity(null, 'service_role');
      await imported({ ...job, id: 'paused-new-match' });
      await query("update public.ns_telegram_links set last_digest=now()-interval '25 hours' where user_id=$1", [alice]);
      await rpc('ns_telegram', { p_action: 'prepare', p_data: { origin: config.origin } });
      assert.equal((await query('select * from public.ns_telegram_queue')).length, 0);
      await imported({ ...job, description: 'Tracked listing changed again' });
      await query("update public.ns_telegram_links set last_digest=now()-interval '25 hours' where user_id=$1", [alice]);
      await rpc('ns_telegram', { p_action: 'prepare', p_data: { origin: config.origin } });
      assert.match((await query('select text from public.ns_telegram_queue'))[0].text, /tracked job listing has changed/);
      await rpc('ns_telegram', { p_action: 'disconnect', p_user: alice });
    });
    await t.test('private CV replacement prevents ownership changes and stale concurrent writes', async () => {
      await identity(null, 'service_role');
      await rpc('ns_replace_cv', { p_user: alice, p_path: `${alice}/cv.pdf`, p_name: 'CV.pdf', p_type: 'application/pdf', p_expected: null });
      await assert.rejects(rpc('ns_replace_cv', { p_user: alice, p_path: `${bob}/cv.pdf`, p_name: 'CV.pdf', p_type: 'application/pdf', p_expected: `${alice}/cv.pdf` }), /Invalid private CV/);
      await assert.rejects(rpc('ns_replace_cv', { p_user: alice, p_path: `${alice}/next.pdf`, p_name: 'CV.pdf', p_type: 'application/pdf', p_expected: null }), /another request/);
      await query('insert into storage.objects(bucket_id,name) values($1,$2)', ['nextstep-cvs', `${alice}/cv.pdf`]);
      await identity(bob);
      assert.equal((await query("select * from storage.objects where bucket_id='nextstep-cvs'")).length, 0);
      await identity(alice);
      assert.equal((await query("select * from storage.objects where bucket_id='nextstep-cvs'")).length, 1);
      await identity(null, 'service_role');
      await rpc('ns_cleanup');
    });
    await t.test('career evidence is private and email claims respect consent, closure and verification', async () => {
      await identity(alice);
      await query('update public.ns_profiles set agent_enabled=true where id=$1',[alice]);
      await rpc('ns_set_evidence', { p_text: 'Private JavaScript SQL evidence' });
      assert.equal((await rpc('ns_state')).user.hasCvText, true);
      assert.equal((await rpc('ns_state')).user.cvText, undefined);
      await assert.rejects(query("update public.ns_profiles set cv_text='bypass' where id=$1",[alice]), /permission denied/);
      await assert.rejects(rpc('ns_set_evidence', { p_text: 'stale', p_expected: 'wrong/path', p_check_path: true }), /CV changed/);
      await rpc('ns_email_settings', { p_enabled: true, p_min_score: 60 });
      await identity(bob);
      assert.equal((await query('select cv_text from public.ns_profiles'))[0].cv_text,'');
      await assert.rejects(query('select * from public.ns_email_queue'), /permission denied/);
      await assert.rejects(rpc('ns_claim_email', { p_lease: alice }), /permission denied/);
      await identity(null,'service_role');
      const tracked = { ...job, id: 'himalayas-closure-fixture', source: 'Himalayas', closed: false, expiresAt: new Date(Date.now()+86400000).toISOString() };
      await rpc('ns_import_jobs', { p_jobs: [{data:tracked,fingerprint:'closure-fixture',eligibleCountries:eligible}] });
      await query("update public.ns_email_preferences set last_digest=now()-interval '25 hours' where user_id=$1",[alice]);
      await rpc('ns_prepare_email',{p_origin:config.origin}); await rpc('ns_prepare_email',{p_origin:config.origin});
      assert.equal((await query('select * from public.ns_email_queue')).length,1);
      const claimed = await rpc('ns_claim_email',{p_lease:alice});
      assert.equal(claimed.email,'alice@example.test');
      assert.equal(await rpc('ns_email_allowed',{p_id:claimed.id,p_email:claimed.email}),true);
      await identity(alice);
      await rpc('ns_email_settings',{p_enabled:false,p_min_score:60});
      await rpc('ns_toggle_saved',{p_job:tracked.id});
      await rpc('ns_email_settings',{p_enabled:true,p_min_score:60});
      await identity(null,'service_role');
      assert.equal(await rpc('ns_email_allowed',{p_id:claimed.id,p_email:claimed.email}),false);
      assert.equal((await query('select public.ns_mark_closed(array[$1]) n',[tracked.id]))[0].n,1);
      assert.equal((await query('select public.ns_mark_closed(array[$1]) n',[tracked.id]))[0].n,0);
      assert.equal((await rpc('ns_import_jobs',{p_jobs:[{data:tracked,fingerprint:'stale-cache',eligibleCountries:eligible}]})).updated,0);
      assert.equal((await rpc('ns_record_availability',{p_id:tracked.id,p_unknown:false})).closed,true);
      await rpc('ns_import_jobs',{p_jobs:[{data:{...tracked,id:'expired-fixture',expiresAt:new Date(Date.now()-1000).toISOString()},fingerprint:'expired',eligibleCountries:eligible}]});
      assert.equal(await rpc('ns_expire_jobs'),1);
      await query("update public.ns_email_preferences set last_digest=now()-interval '25 hours' where user_id=$1",[alice]);
      await rpc('ns_prepare_email',{p_origin:config.origin});
      assert.match((await query('select text from public.ns_email_queue'))[0].text,/confirmed closed/);
      await db.exec('reset role');
      await query('update auth.users set email_confirmed_at=null where id=$1',[alice]);
      await identity(null,'service_role');
      assert.equal(await rpc('ns_claim_email',{p_lease:alice}),null);
      await db.exec('reset role');
      await query('update auth.users set email_confirmed_at=now() where id=$1',[alice]);
      await identity(alice);
      const state = await rpc('ns_state');
      assert.equal(state.ownedJobs.find(j=>j.id===tracked.id).closed,true);
      assert.ok(!(await rpc('ns_job_page',{p_country:'All countries'})).jobs.some(j=>j.id===tracked.id));
      await rpc('ns_email_settings',{p_enabled:false,p_min_score:60});
      await identity(bob);
      assert.equal((await query("select id from public.ns_jobs where id in ('himalayas-closure-fixture','expired-fixture')")).length,0);
      await identity(null,'anon');
      assert.equal((await query("select id from public.ns_jobs where id in ('himalayas-closure-fixture','expired-fixture')")).length,0);
      assert.ok((await query('select id from public.ns_jobs limit 1')).length>0);
      await identity(null,'service_role');
    });
    await t.test('hosted API verifies email, protects recovery sessions, stores private CVs and revokes devices', async () => {
      const userId = '44444444-4444-4444-8444-444444444444';
      const account = { id: userId, email: 'hosted@example.test', password: 'Test-password-123', email_confirmed_at: null };
      const accessTokens = new Map(), files = new Map();
      let counter = 0;
      const issue = () => {
        const access = `fixture-access-${++counter}`;
        accessTokens.set(access, account);
        return { access_token: access, refresh_token: `fixture-refresh-${counter}`, expires_in: 3600,
          user: { id: account.id, email: account.email, email_confirmed_at: account.email_confirmed_at } };
      };
      const fetcher = async (target, init) => {
        const url = new URL(target);
        assert.equal(url.origin, config.supabase);
        const data = init.body instanceof Buffer ? null : init.body ? JSON.parse(init.body) : {};
        const access = init.headers.Authorization?.replace('Bearer ', '');
        if (url.pathname.startsWith('/auth/v1/')) {
          if (url.pathname.endsWith('/signup')) {
            assert.equal(init.headers.apikey, config.anon);
            await identity(null, 'service_role'); await db.exec('reset role');
            await query('insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)', [userId, account.email, data.data]);
            return Response.json({ user: { id: userId } });
          }
          if (url.pathname.endsWith('/token')) {
            if (url.searchParams.get('grant_type') === 'refresh_token') return Response.json(issue());
            if (data.email !== account.email || data.password !== account.password || !account.email_confirmed_at) return Response.json({ error: 'invalid_grant' }, { status: 400 });
            return Response.json(issue());
          }
          if (url.pathname.endsWith('/verify')) { account.email_confirmed_at = new Date().toISOString(); return Response.json(issue()); }
          if (url.pathname.endsWith('/user')) {
            if (!accessTokens.has(access)) return Response.json({}, { status: 401 });
            if (init.method === 'PUT') account.password = data.password;
            return Response.json({ id: account.id, email: account.email, email_confirmed_at: account.email_confirmed_at });
          }
          if (url.pathname.includes('/admin/users/')) {
            assert.equal(init.headers.apikey, config.service);
            await db.exec('reset role');
            await query('delete from auth.users where id=$1', [userId]);
            return Response.json({});
          }
          if (/\/(recover|resend|logout)$/.test(url.pathname)) return Response.json({});
          assert.fail(`Unexpected auth operation: ${url.pathname}`);
        }
        if (url.pathname.startsWith('/storage/v1/')) {
          assert.equal(init.headers.apikey, config.service);
          const base = '/storage/v1/object/nextstep-cvs';
          if (url.pathname.startsWith(`${base}/`) && init.method === 'POST') {
            const path = url.pathname.slice(base.length + 1);
            assert.ok(path.startsWith(`${userId}/`));
            files.set(path, Buffer.from(init.body));
            return Response.json({ Key: path });
          }
          if (url.pathname.includes('/object/sign/')) return Response.json({ signedURL: `/object/sign/nextstep-cvs/${userId}/cv.pdf?token=short-lived-test` });
          if (url.pathname.includes('/object/list/')) return Response.json([...files.keys()].filter(k => k.startsWith(data.prefix)).slice(0, data.limit).map(k => ({ name: k.split('/').at(-1) })));
          if (url.pathname === base && init.method === 'DELETE') {
            for (const path of data.prefixes) { assert.ok(path.startsWith(`${userId}/`)); files.delete(path); }
            return Response.json([]);
          }
          assert.fail(`Unexpected storage operation: ${url.pathname}`);
        }
        const service = init.headers.apikey === config.service;
        const owner = accessTokens.get(access)?.id;
        await identity(owner, service ? 'service_role' : owner ? 'authenticated' : 'anon');
        if (url.pathname.startsWith('/rest/v1/rpc/')) return Response.json(await rpc(url.pathname.split('/').at(-1), data));
        const table = url.pathname.split('/').at(-1);
        assert.match(table, /^ns_[a-z_]+$/);
        const params = [], where = [];
        for (const [key, value] of url.searchParams) {
          if (key === 'select') continue;
          assert.match(key, /^[a-z_]+$/);
          const dot = value.indexOf('.');
          const op = { eq: '=', gt: '>' }[value.slice(0, dot)];
          assert.ok(op);
          params.push(value.slice(dot + 1));
          where.push(`"${key}" ${op} $${params.length}`);
        }
        const filter = where.length ? ` where ${where.join(' and ')}` : '';
        let rows;
        if (init.method === 'POST') {
          const keys = Object.keys(data);
          rows = await query(`insert into public.${table}(${keys.map(k => `"${k}"`).join(',')}) values(${keys.map((_, n) => `$${n + 1}`).join(',')}) returning *`, Object.values(data));
        } else if (init.method === 'PATCH') {
          const keys = Object.keys(data);
          rows = await query(`update public.${table} set ${keys.map((k, n) => `"${k}"=$${params.length + n + 1}`).join(',')}${filter} returning *`, [...params, ...Object.values(data)]);
        } else if (init.method === 'DELETE') rows = await query(`delete from public.${table}${filter} returning *`, params);
        else {
          const select = url.searchParams.get('select') || '*';
          assert.match(select, /^[a-z_,*]+$/);
          rows = await query(`select ${select} from public.${table}${filter}`, params);
        }
        return Response.json(rows);
      };
      const handler = createHostedHandler({ config, fetcher });
      const call = (path, method = 'GET', data, cookie) => handler(new Request(`${config.origin}${path}`, {
        method, headers: { ...(data ? { 'Content-Type': 'application/json' } : {}), Origin: config.origin, ...(cookie ? { Cookie: cookie } : {}) },
        body: data ? JSON.stringify(data) : undefined,
      }), { ip: '192.0.2.12', deploy: { published: true } });
      const login = async (passwordValue = account.password) => {
        const response = await call('/api/login', 'POST', { email: account.email, password: passwordValue });
        assert.equal(response.status, 200, await response.text());
        return response.headers.get('set-cookie').split(';')[0];
      };
      const registered = await call('/api/register', 'POST', { ...profile, email: account.email, password: account.password });
      assert.equal(registered.status, 202);
      assert.equal((await registered.json()).confirmationRequired, true);
      assert.equal((await call('/api/login', 'POST', { email: account.email, password: account.password })).status, 401);
      const confirmed = await call(`/auth/callback?token_hash=${'c'.repeat(64)}&type=email`);
      assert.equal(confirmed.status, 303);
      assert.equal(confirmed.headers.get('set-cookie'), null, 'Confirming an email must not sign a browser into a different account');
      let cookie = await login();
      const otherDevice = await login();
      const initial = await call('/api/state', 'GET', undefined, cookie);
      assert.equal(initial.status, 200, await initial.clone().text());
      const state = await initial.json();
      assert.equal(state.user.id, userId);
      assert.equal(state.hosted, true);
      assert.ok(state.jobs.every(j => !j.description && !j.eligibleCountries));
      await identity(null, 'service_role');
      const sessionHash = digest(cookie.split('=')[1]);
      const [stored] = await query('select payload from public.ns_sessions where token_hash=$1', [sessionHash]);
      const tokens = unseal(stored.payload, config.key, sessionHash);
      assert.ok(!stored.payload.includes(tokens.refresh));
      await query('update public.ns_sessions set payload=$1 where token_hash=$2', [
        seal({ ...tokens, expiresAt: Date.now() - 1000 }, config.key, sessionHash), sessionHash,
      ]);
      assert.equal((await call('/api/state?summary=1', 'GET', undefined, cookie)).status, 200);
      await identity(null, 'service_role');
      const [renewed] = await query('select payload from public.ns_sessions where token_hash=$1', [sessionHash]);
      assert.notEqual(unseal(renewed.payload, config.key, sessionHash).refresh, tokens.refresh);
      const summary = await (await call('/api/state?summary=1', 'GET', undefined, cookie)).json();
      assert.ok(!('jobs' in summary));
      const detail = await (await call(`/api/jobs/${job.id}`, 'GET', undefined, cookie)).json();
      assert.equal(detail.job.description, 'Tracked listing changed again');
      const invalid = await call('/api/cv', 'POST', { type: 'application/pdf', name: 'CV.pdf', content: Buffer.from('not-pdf').toString('base64') }, cookie);
      assert.equal(invalid.status, 400);
      const bytes = Buffer.alloc(4 * 1024 * 1024, 65); bytes.write('%PDF-');
      const uploaded = await call('/api/cv', 'POST', { type: 'application/pdf', name: 'CV.pdf', content: bytes.toString('base64') }, cookie);
      assert.equal(uploaded.status, 200, await uploaded.text());
      assert.equal(files.size, 1);
      const oversize = await call('/api/cv', 'POST', { type: 'text/plain', name: 'large.txt', content: Buffer.alloc(bytes.length + 1).toString('base64') }, cookie);
      assert.equal(oversize.status, 413);
      const download = await call('/api/cv', 'GET', undefined, cookie);
      assert.equal(download.status, 303);
      assert.equal(new URL(download.headers.get('location')).origin, config.supabase);
      assert.ok(download.headers.get('location').includes('download=CV.pdf'));
      assert.equal((await call('/api/logout-all', 'POST', undefined, cookie)).status, 200);
      assert.equal((await (await call('/api/state', 'GET', undefined, otherDevice)).json()).user, null);
      assert.equal((await call('/api/password-reset', 'POST', { email: account.email })).status, 200);
      const recovering = await call(`/auth/callback?token_hash=${'d'.repeat(64)}&type=recovery`);
      assert.match(recovering.headers.get('set-cookie'), /Max-Age=600;/);
      cookie = recovering.headers.get('set-cookie').split(';')[0];
      const recovery = await (await call('/api/state', 'GET', undefined, cookie)).json();
      assert.equal(recovery.user, null);
      assert.equal(recovery.passwordRecovery, true);
      assert.equal(recovery.recoveryEmail, account.email);
      assert.equal((await call('/api/cv', 'GET', undefined, cookie)).status, 403);
      const completed = await call('/api/password-reset/complete', 'POST', { password: 'Changed-password-123' }, cookie);
      assert.equal(completed.status, 200, await completed.text());
      assert.equal((await (await call('/api/state', 'GET', undefined, cookie)).json()).passwordRecovery, false);
      cookie = await login();
      assert.equal((await call('/api/account', 'DELETE', { password: 'Wrong-password-123' }, cookie)).status, 401);
      assert.equal(files.size, 1);
      const deleted = await call('/api/account', 'DELETE', { password: account.password }, cookie);
      assert.equal(deleted.status, 200, await deleted.text());
      assert.equal(files.size, 0);
      await db.exec('reset role');
      assert.equal((await query('select * from public.ns_profiles where id=$1', [userId])).length, 0);
      assert.equal((await query('select * from public.ns_sessions where user_id=$1', [userId])).length, 0);
    });
    await t.test('recruiter roles, ownership, applicant privacy, CV consent and deletion are enforced in SQL', async () => {
      const owner='33333333-3333-4333-8333-333333333333', stranger='44444444-4444-4444-8444-444444444444', candidate='55555555-5555-4555-8555-555555555555';
      await db.exec('reset role');
      for(const [id,accountType] of [[owner,'recruiter'],[stranger,'recruiter'],[candidate,'jobseeker']]) await query('insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)',[id,`${id}@example.test`,{...profile,accountType,agentEnabled:false}]);
      await identity(owner);
      assert.equal((await rpc('ns_state')).user.accountType,'recruiter');
      await assert.rejects(query("update public.ns_profiles set account_type='jobseeker'"),/permission denied/);
      await assert.rejects(query('select * from public.ns_submissions'),/permission denied/);
      await rpc('ns_recruitment',{p_action:'company',p_data:{name:'Employer',description:'Our company',website:''}});
      const post={title:'Python developer',description:'Build and test Python APIs and SQL databases. Work with the product team to deliver reliable applications.',country:'Tunisia',remote:true,status:'draft'};
      const {id}=await rpc('ns_recruitment',{p_action:'posting',p_data:post});
      await identity(null,'anon');
      assert.equal((await query('select id from public.ns_jobs where id=$1',[id])).length,0);
      await identity(owner);
      await rpc('ns_recruitment',{p_action:'posting',p_data:{...post,id,status:'open'}});
      await identity(null,'service_role');
      await query("update public.ns_jobs set published_at=now()-interval '100 days' where id=$1",[id]);
      await query('delete from public.ns_job_events where job_id=$1',[id]);
      await rpc('ns_cleanup');
      assert.equal((await query('select id from public.ns_jobs where id=$1',[id])).length,1);
      await identity(stranger);
      assert.equal((await rpc('ns_recruitment',{p_action:'state'})).postings.length,0);
      await rpc('ns_recruitment',{p_action:'company',p_data:{name:'Other employer'}});
      await assert.rejects(rpc('ns_recruitment',{p_action:'posting',p_data:{...post,id,status:'closed'}}),/not found/);
      await identity(null,'service_role');
      await rpc('ns_replace_cv',{p_user:candidate,p_path:`${candidate}/old.txt`,p_name:'CV.txt',p_type:'text/plain',p_expected:null});
      await identity(candidate);
      await rpc('ns_set_evidence',{p_text:'CANDIDATE_SECRET Python SQL'});
      await assert.rejects(rpc('ns_recruitment',{p_action:'apply',p_data:{jobId:id,shareCv:true}}),/consent/);
      await rpc('ns_recruitment',{p_action:'apply',p_data:{jobId:id,shareCv:true,consent:true,message:'My application'}});
      await assert.rejects(rpc('ns_recruitment',{p_action:'apply',p_data:{jobId:id,shareCv:true,consent:true}}),/already applied/);
      await identity(owner);
      const workspace=await rpc('ns_recruitment',{p_action:'state'}), app=workspace.applicants[0];
      assert.ok(!JSON.stringify(workspace).includes('CANDIDATE_SECRET'));
      assert.equal(app.cvAvailable,true);
      assert.equal((await rpc('ns_recruitment',{p_action:'cv',p_data:{id:app.id}})).path,`${candidate}/old.txt`);
      await rpc('ns_recruitment',{p_action:'review',p_data:{id:app.id,status:'Interview',notes:'RECRUITER_SECRET',interviewAt:'2026-12-01T10:00:00Z'}});
      await identity(stranger);
      await assert.rejects(rpc('ns_recruitment',{p_action:'cv',p_data:{id:app.id}}),/not found/);
      await identity(candidate);
      const own=await rpc('ns_recruitment',{p_action:'state'});
      assert.equal(own.applications[0].status,'Interview');
      assert.ok(!JSON.stringify(own).includes('RECRUITER_SECRET'));
      await assert.rejects(rpc('ns_recruitment',{p_action:'review',p_data:{id:app.id,status:'Offer'}}),/recruiter account/);
      await identity(null,'service_role');
      await rpc('ns_replace_cv',{p_user:candidate,p_path:`${candidate}/new.txt`,p_name:'CV.txt',p_type:'text/plain',p_expected:`${candidate}/old.txt`});
      await identity(owner);
      await assert.rejects(rpc('ns_recruitment',{p_action:'cv',p_data:{id:app.id}}),/revoked/);
      await identity(candidate);
      await rpc('ns_recruitment',{p_action:'consent',p_data:{jobId:id,shareCv:true,withdraw:false,consent:true}});
      await identity(owner);
      assert.equal((await rpc('ns_recruitment',{p_action:'cv',p_data:{id:app.id}})).path,`${candidate}/new.txt`);
      await identity(candidate);
      await rpc('ns_recruitment',{p_action:'consent',p_data:{jobId:id,shareCv:false,withdraw:true}});
      await identity(owner);
      await assert.rejects(rpc('ns_recruitment',{p_action:'review',p_data:{id:app.id,status:'Offer'}}),/withdrew/);
      await db.exec('reset role');
      await query('delete from auth.users where id=$1',[owner]);
      assert.equal((await query('select data from public.ns_jobs where id=$1',[id]))[0].data.company,'Deleted employer');
      assert.equal((await query('select id from public.ns_submissions where job_id=$1',[id])).length,0);
      await query("update public.ns_jobs set published_at=now()-interval '100 days' where id=$1",[id]);
      await rpc('ns_cleanup');
    });
  } finally { await db.close(); }
});

test('hosted provider never forwards privileged keys as a user bearer token', async () => {
  const requests = [];
  const db = createSupabase(config, async (url, init) => { requests.push({ url, ...init }); return Response.json({ ok: true }); });
  await db.rpc('ns_state', {}, 'user-jwt');
  await db.rpc('ns_claim_feed_refresh');
  assert.equal(requests[0].headers.apikey, config.anon);
  assert.equal(requests[0].headers.Authorization, 'Bearer user-jwt');
  assert.equal(requests[1].headers.apikey, config.service);
  assert.equal(requests[1].headers.Authorization, undefined);
});

test('hosted feed failures remain explicit and cooldown prevents extra provider requests', async () => {
  const saved = [];
  const db = { rpc: async () => true, rows: async (...args) => { saved.push(args); return []; } };
  const result = await syncHostedFeeds(db, async () => new Response('Unavailable', { status: 503 }));
  assert.equal(result.sources.length, feeds.length);
  assert.ok(result.sources.every(s => !s.ok && s.error));
  assert.equal(saved.find(args=>args[2]?.body?.some(row=>row.key==='syncResult'))[2].body.some(row => row.key === 'lastSuccess'), false);
  const cached = await syncHostedFeeds({ rpc: async () => false, rows: async () => [] }, async () => { assert.fail('Must not fetch during cooldown'); });
  assert.equal(cached.cached, true);
});
test('Remotive cooldown is durable, includes failed attempts and permits refresh at six hours', async t => {
  const now=Date.now(), metadata=new Map([['source:Remotive',{at:new Date(now-21600000+1).toISOString(),ok:true,count:7}]]);
  t.mock.method(Date,'now',()=>now);
  let calls=0;
  const db={
    rpc:async name=>name==='ns_import_jobs'?{added:0,updated:0}:true,
    rows:async (table,params,options)=>{
      if(options?.method==='POST') { for(const row of options.body) metadata.set(row.key,row.value); return []; }
      const value=metadata.get(params.key.replace(/^eq\./,'')); return value?[{value}]:[];
    },
  };
  const fetcher=async url=>{
    if(url.includes('remotive.com')) { calls++; return Response.json({jobs:[]}); }
    return Response.json({jobs:[],data:[]});
  };
  assert.equal((await syncHostedFeeds(db,fetcher)).sources.find(s=>s.name==='Remotive').cached,true);
  assert.equal(calls,0);
  t.mock.method(Date,'now',()=>now+1);
  await syncHostedFeeds(db,fetcher); assert.equal(calls,1);
  await syncHostedFeeds(db,fetcher); assert.equal(calls,1);
  metadata.delete('source:Remotive');
  await syncHostedFeeds(db,async url=>url.includes('remotive.com')?(calls++,new Response('',{status:503})):Response.json({jobs:[],data:[]}));
  const cached=await syncHostedFeeds(db,fetcher);
  assert.equal(calls,2);
  assert.equal(cached.sources.find(s=>s.name==='Remotive').ok,false);
});
