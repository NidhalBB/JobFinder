import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { normalizeJob, countryMatches, matchJob, validateProfile, hashPassword, verifyPassword, dailyRefreshDue } from '../lib.mjs';
import { scryptSync } from 'node:crypto';

const profile = { name: 'Test Person', role: 'Product Designer', country: 'Netherlands', skills: 'Figma, Research', workMode: 'Remote', agentEnabled: true };
const job = normalizeJob({ id: 42, jobTitle: 'Product Designer', companyName: 'Example', jobGeo: 'Europe', jobIndustry: ['Design'], jobType: ['Full-time'], url: 'https://jobicy.com/jobs/example', pubDate: new Date().toISOString(), jobDescription: '<p>Work with Figma and Research.</p>' }, 'Jobicy');

test('normalizes feed fields and rejects unsafe listing links', () => {
  assert.equal(job.source, 'Jobicy');
  assert.equal(job.remote, true);
  assert.equal(job.description, 'Work with Figma and Research.');
  assert.equal(job.salary, 'Salary not listed');
  assert.equal(normalizeJob({ id: 2, jobTitle: 'Engineer', companyName: 'X', url: 'javascript:alert(1)' }, 'Jobicy'), null);
  const german = normalizeJob({ slug: 'role', title: 'Engineer', company_name: 'X', url: 'https://example.com', created_at: 1700000000, location: 'Berlin', remote: false }, 'Arbeitnow');
  assert.equal(german.country, 'Germany');
  assert.equal(german.remote, false);
  assert.equal(normalizeJob({ ...{ slug: 'role', title: 'Engineer', company_name: 'X', url: 'https://example.com', created_at: 1700000000 } }, 'Arbeitnow UK').country, 'United Kingdom');
  const raw = { slug: 'remote', title: 'Engineer', company_name: 'X', url: 'https://example.com', created_at: 1700000000, remote: true };
  assert.equal(normalizeJob({ ...raw, location: 'Remote job' }, 'Arbeitnow').country, 'Not specified');
  assert.equal(normalizeJob({ ...raw, location: 'Amsterdam' }, 'Arbeitnow').country, 'Netherlands');
  assert.equal(countryMatches(normalizeJob({ ...raw, location: 'Hybrid' }, 'Arbeitnow'), 'Germany'), false);
});
test('country eligibility distinguishes remote from worldwide', () => {
  assert.equal(countryMatches(job, 'Netherlands'), true);
  assert.equal(countryMatches(job, 'Brazil'), false);
  assert.equal(countryMatches({ country: 'Brazil', remote: true }, 'Netherlands'), false);
  assert.equal(countryMatches({ country: 'Anywhere' }, 'Tunisia'), true);
  assert.equal(countryMatches({ country: 'USA' }, 'United States'), true);
  assert.equal(countryMatches({ country: 'EU' }, 'United Kingdom'), false);
  assert.equal(countryMatches({ country: 'EU' }, 'Italy'), true);
  assert.equal(countryMatches({ country: 'EMEA' }, 'Tunisia'), true);
  assert.equal(countryMatches({ country: 'USA, Canada' }, 'Canada'), true);
  assert.equal(countryMatches({ country: 'Papua New Guinea' }, 'Guinea'), false);
});
test('daily agent refresh respects opt-in and the exact 24-hour boundary', () => {
  const last = 1_000_000;
  assert.equal(dailyRefreshDue([profile], last, last + 86399999), false);
  assert.equal(dailyRefreshDue([profile], last, last + 86400000), true);
  assert.equal(dailyRefreshDue([{ ...profile, agentEnabled: false }], last, last + 86400000), false);
  assert.equal(dailyRefreshDue([], last, last + 2 * 86400000), false);
});
test('matching measures role, skill, location and work preference', () => {
  assert.equal(matchJob(job, profile).score, 100);
  assert.deepEqual(matchJob(job, profile).matchedSkills, ['Figma', 'Research']);
  const mismatch = matchJob(job, { ...profile, role: 'Accountant', skills: 'Excel, Tax', country: 'Brazil', workMode: 'On-site' });
  assert.equal(mismatch.score, 0);
  assert.equal(mismatch.countryMatch, false);
  assert.equal(mismatch.workMatch, false);
});
test('validates profiles and hashes passwords with unique salts and legacy verification', async () => {
  assert.throws(() => validateProfile({ ...profile, country: 'Invalid' }), /country/);
  assert.throws(() => validateProfile({ ...profile, role: '' }), /role/);
  const hash = await hashPassword('a long test password');
  assert.equal(await verifyPassword('a long test password', hash), true);
  assert.equal(await verifyPassword('not the password', hash), false);
  assert.notEqual(await hashPassword('a long test password'), hash);
  const salt = 'a'.repeat(32);
  assert.equal(await verifyPassword('old password', `${salt}:${scryptSync('old password', salt, 64).toString('hex')}`), true);
});

let server;
let db;
let base;
const dir = mkdtempSync(join(tmpdir(), 'nextstep-test-'));
before(async () => {
  server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, NODE_ENV: 'test', PUBLIC_ORIGIN: '', COOKIE_SECURE: 'false', TELEGRAM_BOT_TOKEN: '', TELEGRAM_BOT_USERNAME: '', TELEGRAM_WEBHOOK_SECRET: '', HOST: '127.0.0.1', PORT: '0', DATA_DIR: dir, DISABLE_FEEDS: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
  base = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server did not start')), 10000);
    server.once('error', reject);
    server.stdout.on('data', chunk => {
      const match = chunk.toString().match(/http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timeout); resolve(`http://127.0.0.1:${match[1]}`); }
    });
    server.stderr.on('data', chunk => { if (!chunk.toString().includes('ExperimentalWarning') && !chunk.toString().includes('trace-warnings')) process.stderr.write(chunk); });
  });
  db = new DatabaseSync(join(dir, 'nextstep.sqlite'));
  db.prepare('INSERT INTO jobs VALUES (?,?,?)').run(job.id, JSON.stringify(job), 'test');
});
after(async () => {
  db?.close();
  if (server && server.exitCode === null) {
    const done = new Promise(resolve => server.once('exit', resolve));
    server.kill();
    await done;
  }
  for (const name of readdirSync(dir)) rmSync(join(dir, name));
  rmdirSync(dir);
});
async function request(path, method = 'GET', data, cookie) {
  return fetch(`${base}/api/${path}`, { method, headers: { ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: data !== undefined ? JSON.stringify(data) : undefined });
}
async function create(email, accountType='jobseeker') {
  const res = await request('register', 'POST', { ...profile, email, accountType, password: 'a very good password' });
  assert.equal(res.status, 200);
  return res.headers.get('set-cookie').split(';')[0];
}
test('account, private CV, tracking, ownership, logout, and deletion persist correctly', async () => {
  const cookie = await create('first@example.test');
  assert.notEqual(db.prepare('SELECT token FROM sessions LIMIT 1').get().token, cookie.split('=')[1]);
  const second = await create('second@example.test');
  assert.equal((await request('telegram/link', 'POST', {}, second)).status, 410);
  const stateResponse = await request('state', 'GET', undefined, cookie);
  const state = await stateResponse.json();
  assert.equal(state.user.name, profile.name);
  assert.equal(state.user.password, undefined);
  assert.equal(state.jobs[0].score, 100);
  assert.equal((await request('saved', 'POST', { jobId: job.id })).status, 401);
  assert.equal((await request('saved', 'POST', { jobId: job.id }, cookie)).status, 200);
  assert.deepEqual((await (await request('state', 'GET', undefined, cookie)).json()).saved, [job.id]);
  assert.deepEqual((await (await request('state', 'GET', undefined, second)).json()).saved, []);
  assert.equal((await request('application', 'PUT', { jobId: job.id, status: 'Interview', notes: 'Private interview notes', followUp: '2026-12-03' }, cookie)).status, 200);
  assert.equal((await request('application', 'PUT', { jobId: job.id, status: 'Applied', followUp: '2026-02-31' }, cookie)).status, 400);
  assert.equal((await request('application', 'PUT', { jobId: job.id, status: 'Invalid' }, cookie)).status, 400);
  const cv = { name: 'my-cv.txt', type: 'text/plain', content: Buffer.from('Personal CV').toString('base64') };
  assert.equal((await request('profile/evidence','PUT',{text:'Private Figma evidence'},cookie)).status,200);
  assert.equal((await (await request('state','GET',undefined,cookie)).json()).user.cvText,undefined);
  assert.equal((await (await request('profile/evidence','GET',undefined,second)).json()).text,'');
  const analysis = await (await request('career/analyze','POST',{jobId:job.id},cookie)).json();
  assert.equal(analysis.coverage,100);
  const practice = await (await request('career/quiz','POST',{jobId:job.id,language:'fr'},cookie)).json();
  assert.equal(practice.family,'design');
  assert.equal(practice.questions.length,5);
  const imported = await (await request('profile/import','POST',{type:'text/csv',content:Buffer.from('First Name,Last Name,Headline\nNew,Name,QA Engineer').toString('base64')},cookie)).json();
  assert.equal(imported.proposal.role,'QA Engineer');
  assert.equal((await (await request('state','GET',undefined,cookie)).json()).user.name,profile.name);
  assert.equal((await request('cv', 'POST', cv, cookie)).status, 200);
  assert.equal(await (await request('cv', 'GET', undefined, cookie)).text(), 'Personal CV');
  assert.equal((await request('cv', 'GET', undefined, second)).status, 404);
  assert.equal((await request('cv')).status, 401);
  assert.equal((await request('cv', 'POST', { ...cv, type: 'application/pdf' }, cookie)).status, 400);
  assert.equal((await request('profile', 'PUT', { ...profile, role: 'Researcher', agentEnabled: false }, cookie)).status, 200);
  assert.equal((await (await request('state', 'GET', undefined, cookie)).json()).user.agentEnabled, false);
  assert.equal((await request('logout', 'POST', {}, cookie)).status, 200);
  assert.equal((await (await request('state', 'GET', undefined, cookie)).json()).user, null);
  const login = await request('login', 'POST', { email: 'first@example.test', password: 'a very good password' });
  assert.equal(login.status, 200);
  const newCookie = login.headers.get('set-cookie').split(';')[0];
  const restored = await (await request('state', 'GET', undefined, newCookie)).json();
  assert.equal(restored.applications[0].notes, 'Private interview notes');
  assert.equal(restored.user.cvName, 'my-cv.txt');
  assert.equal(restored.user.role, 'Researcher');
  assert.equal(db.prepare('SELECT password FROM users WHERE email=?').get('first@example.test').password.includes('a very good password'), false);
  assert.equal((await request('account', 'DELETE', { password: 'wrong-password' }, newCookie)).status, 401);
  assert.equal((await request('account', 'DELETE', { password: 'a very good password' }, newCookie)).status, 200);
  assert.equal((await request('cv', 'GET', undefined, newCookie)).status, 401);
  assert.equal(db.prepare('SELECT count(*) AS n FROM applications').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM saved').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 1);
  const secondLogin = await request('login', 'POST', { email: 'second@example.test', password: 'a very good password' });
  const secondDevice = secondLogin.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('logout-all', 'POST', {}, second)).status, 200);
  assert.equal((await (await request('state', 'GET', undefined, second)).json()).user, null);
  assert.equal((await (await request('state', 'GET', undefined, secondDevice)).json()).user, null);
});
test('rejects invalid requests and cross-origin mutations', async () => {
  assert.equal((await request('register', 'POST', { padding: 'x'.repeat(32768) })).status, 413);
  assert.equal((await request('register', 'POST', null)).status, 400);
  assert.equal((await request('register', 'POST', { ...profile, email: 'bad email', password: 'a very good password' })).status, 400);
  const result = await fetch(`${base}/api/register`, { method: 'POST', headers: { Origin: 'https://other.example', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(result.status, 403);
  assert.equal((await fetch(`${base}/data/nextstep.sqlite`)).status, 404);
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.ok(page.headers.get('content-security-policy').includes("script-src 'self'"));
});
test('recruiters publish jobs and manage only consenting applicants, with revocable CV access', async () => {
  const employer=await create('employer@example.test','recruiter'), other=await create('other-employer@example.test','recruiter');
  const candidate=await create('candidate@example.test'), outsider=await create('outsider@example.test');
  assert.equal((await request('recruitment/constructor','POST',{},candidate)).status,404);
  const post={title:'Python developer',description:'Build and test Python APIs with SQL. Collaborate with the product team and maintain reliable software.',country:'Tunisia',status:'draft',remote:true};
  assert.equal((await request('recruitment/company','POST',{name:'Example Employer'},candidate)).status,403);
  assert.equal((await request('recruitment/company','POST',{name:'Example Employer'},employer)).status,200);
  const created=await request('recruitment/posting','POST',post,employer);
  assert.equal(created.status,200);
  const {id}=await created.json();
  assert.ok(!(await (await request('state')).json()).jobs.some(j=>j.id===id));
  assert.equal((await request('recruitment/posting','POST',{...post,id,status:'open'},other)).status,400);
  assert.equal((await request('recruitment/posting','POST',{...post,id,status:'open'},employer)).status,200);
  assert.ok((await (await request('state')).json()).jobs.some(j=>j.id===id));
  await request('profile','PUT',{...profile,accountType:'recruiter'},candidate);
  assert.equal((await (await request('state','GET',undefined,candidate)).json()).user.accountType,'jobseeker');
  const cv={name:'private.txt',type:'text/plain',content:Buffer.from('PRIVATE_CV Python').toString('base64')};
  assert.equal((await request('cv','POST',cv,candidate)).status,200);
  assert.equal((await request('recruitment/apply','POST',{jobId:id,shareCv:true},candidate)).status,400);
  assert.equal((await request('recruitment/apply','POST',{jobId:id,shareCv:true,consent:true,message:'My application'},candidate)).status,200);
  assert.equal((await request('recruitment/apply','POST',{jobId:id,shareCv:false,consent:true},candidate)).status,409);
  assert.equal((await request('recruitment/apply','POST',{jobId:id,shareCv:false,consent:true},employer)).status,403);
  const workspace=await (await request('recruitment','GET',undefined,employer)).json(), applicant=workspace.applicants[0];
  assert.equal(applicant.cvAvailable,true);
  assert.ok(!JSON.stringify(workspace).includes('PRIVATE_CV'));
  assert.equal((await (await request('recruitment','GET',undefined,other)).json()).applicants.length,0);
  assert.equal((await request(`recruitment/cv/${applicant.id}`,'GET',undefined,other)).status,404);
  assert.equal(await (await request(`recruitment/cv/${applicant.id}`,'GET',undefined,employer)).text(),'PRIVATE_CV Python');
  assert.equal((await request('recruitment/review','POST',{id:applicant.id,status:'Interview',notes:'EMPLOYER_SECRET',interviewAt:'2026-12-01T10:00:00Z'},employer)).status,200);
  const candidateState=await (await request('recruitment','GET',undefined,candidate)).json();
  assert.equal(candidateState.applications[0].status,'Interview');
  assert.ok(!JSON.stringify(candidateState).includes('EMPLOYER_SECRET'));
  assert.equal((await request('recruitment/consent','POST',{jobId:id,shareCv:false,withdraw:false},outsider)).status,404);
  await request('cv','POST',{...cv,content:Buffer.from('NEW_CV').toString('base64')},candidate);
  assert.equal((await request(`recruitment/cv/${applicant.id}`,'GET',undefined,employer)).status,404);
  await request('recruitment/consent','POST',{jobId:id,shareCv:true,withdraw:false,consent:true},candidate);
  assert.equal((await request(`recruitment/cv/${applicant.id}`,'GET',undefined,employer)).status,200);
  await request('recruitment/consent','POST',{jobId:id,shareCv:false,withdraw:true},candidate);
  assert.equal((await request(`recruitment/cv/${applicant.id}`,'GET',undefined,employer)).status,404);
  assert.equal((await request('recruitment/review','POST',{id:applicant.id,status:'Offer'},employer)).status,409);
  await request('account','DELETE',{password:'a very good password'},employer);
  assert.equal(JSON.parse(db.prepare('SELECT data FROM jobs WHERE id=?').get(id).data).closed,true);
  assert.equal(db.prepare('SELECT count(*) n FROM submissions WHERE job_id=?').get(id).n,0);
});
