import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { normalizeJob, validateProfile, countryMatches } from '../lib.mjs';
import { assessJob, proposeLinkedIn, careerRequest } from '../career.mjs';
import { extractDocument } from '../documents.mjs';
import { checkAvailability } from '../availability.mjs';
import { discoveryLinks } from '../discovery.mjs';
import { createLocalEmail, emailConfig, drainEmail } from '../email.mjs';

const profile = { name: 'Test Candidate', role: 'Engineer', country: 'Tunisia', skills: 'Python', workMode: 'Remote', agentEnabled: true, cvText: 'Used Python and SQL to build a verifiable project.' };
const listing = { guid: 'https://himalayas.app/companies/example/jobs/engineer', applicationLink: 'https://example.test/apply?original=1',
  title: 'Engineer', companyName: 'Example', locationRestrictions: [], timezoneRestrictions: [1],
  description: 'Python, SQL and Docker.', pubDate: Date.now() / 1000, expiryDate: Date.now() / 1000 + 86400 };
const job = normalizeJob(listing, 'Himalayas');

test('worldwide imports preserve apply URLs, expiry and country/timezone eligibility', async () => {
  assert.equal(job.url, listing.applicationLink);
  assert.equal(countryMatches(job, 'Tunisia'), true);
  assert.equal(countryMatches(job, 'Japan'), false);
  assert.equal(normalizeJob({ ...listing, expiryDate: 1 }, 'Himalayas'), null);
  assert.equal(normalizeJob({ ...listing, guid: 'https://untrusted.test/companies/a/jobs/b' }, 'Himalayas'), null);
  assert.equal((await checkAvailability(job, async () => new Response(null, { status: 410 }))).closed, true);
  assert.deepEqual(await checkAvailability(job, async () => new Response(null, { status: 404 })), { closed: false, availabilityUnknown: true });
  await assert.rejects(checkAvailability(job, async () => new Response(null, { status: 503 })), /503/);
  await assert.rejects(checkAvailability({ ...job, sourceUrl: 'https://untrusted.test/companies/a/jobs/b' }, () => assert.fail('Must not fetch another host')), /Invalid source/);
  assert.equal(discoveryLinks()[0].name, 'Tanitjobs');
  assert.ok(!discoveryLinks('Japan').some(link => link.name === 'Keejob'));
});

test('social links and LinkedIn proposals require review and reject other hosts', () => {
  assert.equal(validateProfile({ ...profile, country: undefined }).country, 'Tunisia');
  assert.equal(validateProfile({ ...profile, linkedin: 'https://www.linkedin.com/in/candidate/?tracking=1' }).linkedin, 'https://www.linkedin.com/in/candidate/');
  for (const github of ['https://github.com.evil.test/person', 'http://github.com/person', 'https://github.com/person/repo', 'https://secret@github.com/person']) assert.throws(() => validateProfile({ ...profile, github }), /profile URL/);
  assert.deepEqual(proposeLinkedIn('First Name,Last Name,Headline\n"Test","Candidate","QA, Automation"\n'), { name: 'Test Candidate', role: 'QA, Automation' });
  assert.equal(proposeLinkedIn('Name\nPlaywright\nSQL\n').skills, 'Playwright, SQL');
});
test('Remotive imports preserve attribution, application URL and geographic restrictions', () => {
  const raw={id:123,title:'Developer',company_name:'Example',url:'https://remotive.com/remote-jobs/software-dev/example-123',candidate_required_location:'USA Only',publication_date:'2026-01-01T10:00:00',description:'<p>Python &amp; SQL</p>',tags:['Python'],job_type:'full_time'};
  const imported=normalizeJob(raw,'Remotive');
  assert.equal(imported.url,raw.url);
  assert.equal(imported.sourceUrl,raw.url);
  assert.equal(imported.description,'Python & SQL');
  assert.equal(countryMatches(imported,'Tunisia'),false);
  assert.equal(countryMatches(imported,'United States'),true);
  assert.equal(normalizeJob({...raw,url:'https://example.test/role'},'Remotive'),null);
});

test('CV coverage is distinct from preference match and interview practice follows the role', async () => {
  const analysis = assessJob(job, profile);
  assert.equal(analysis.coverage, 67);
  assert.deepEqual(analysis.missing, ['Docker']);
  assert.equal(assessJob(job, { ...profile, cvText: '' }).coverage, null);
  assert.equal(assessJob({ ...job, description: 'A general position.', title: 'Specialist' }, profile).coverage, null);
  for (const language of ['fr','en']) {
    const result = await careerRequest('quiz', { title:'HR Recruiter',company:'Example',description:'Recruit developers with Python and SQL',language }, profile);
    assert.equal(result.family,'hr');
    assert.equal(result.questions.length,5);
    assert.ok(result.questions.every(q=>!q.id.startsWith('dev-')));
    assert.ok(result.questions.every(q=>q.options[q.answer] && q.explanation));
    const developer=await careerRequest('quiz',{ title:'Python developer',company:'Example',description:'Python SQL',language },profile);
    assert.equal(developer.family,'developer');
    assert.ok(developer.questions.some(q=>q.id==='dev-python'));
    assert.ok(!developer.questions.some(q=>q.id==='dev-js'));
  }
  const manual = await careerRequest('analyze', { title: 'Engineer', company: 'External', description: 'Python Docker' }, profile, () => assert.fail());
  assert.equal(manual.coverage, 50);
  await assert.rejects(careerRequest('quiz', { title: 'Engineer', company: 'External', description: 'Python', language: 'es' }, profile), /French or English/);
  assert.equal((await careerRequest('quiz',{title:'Mechanical Engineer',company:'External',description:'Maintenance equipment',language:'en'},profile)).family,'general');
  assert.equal((await careerRequest('quiz',{title:'Mechanical Engineer',company:'External',description:'Maintenance equipment',family:'operations'},profile)).family,'operations');
});

function textPdf() {
  const stream = 'BT /F1 12 Tf 40 700 Td (Python SQL evidence) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((value,i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i+1} 0 obj\n${value}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(x => `${String(x).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}
test('document extraction handles real PDFs, plain text, malformed PDFs and encoding errors', async () => {
  assert.equal((await extractDocument(Buffer.from('Python SQL'), 'text/plain')).text, 'Python SQL');
  await assert.rejects(extractDocument(Buffer.from([255]), 'text/plain'), { status: 400 });
  const result = await extractDocument(textPdf(), 'application/pdf');
  assert.match(result.text, /Python SQL evidence/);
  assert.equal(result.warning, undefined);
  assert.match((await extractDocument(Buffer.from('%PDF-invalid'), 'application/pdf')).warning, /extract|processing/i);
});

test('email consent, daily deduplication, retries and tracked closure alerts persist', async () => {
  assert.equal(emailConfig({}),null);
  assert.throws(()=>emailConfig({SMTP_HOST:'smtp.example.test'}),/require SMTP/);
  assert.throws(()=>emailConfig({SMTP_HOST:'smtp.example.test',SMTP_PORT:'25',SMTP_USER:'u',SMTP_PASS:'p',NOTIFICATION_FROM:'alerts@example.test'}),/465 or 587/);
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT,profile TEXT);
    CREATE TABLE jobs(id TEXT PRIMARY KEY,data TEXT);
    CREATE TABLE job_events(id INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT,kind TEXT,created_at INTEGER);
    CREATE TABLE saved(user_id INTEGER,job_id TEXT);
    CREATE TABLE applications(user_id INTEGER,job_id TEXT);`);
  const sent = []; let failNext = false;
  const config = emailConfig({ SMTP_HOST: 'smtp.example.test', SMTP_PORT: '587', SMTP_USER: 'test', SMTP_PASS: 'not-real', NOTIFICATION_FROM: 'alerts@example.test', PUBLIC_ORIGIN: 'https://app.example.test' });
  const alerts = createLocalEmail(db, config, async (email,text) => { if (failNext) { failNext = false; throw new Error('private SMTP details'); } sent.push({email,text}); });
  try {
    db.prepare('INSERT INTO users VALUES (?,?,?)').run(1,'first@example.test',JSON.stringify(profile));
    db.prepare('INSERT INTO users VALUES (?,?,?)').run(2,'second@example.test',JSON.stringify(profile));
    await alerts.begin({ id: 1, email: 'first@example.test' });
    const code = /\b\d{6}\b/.exec(sent[0].text)[0];
    assert.throws(() => alerts.confirm(2,code,true), /fresh/);
    assert.throws(() => alerts.confirm(1,code,false), /consent/);
    for (let i=0;i<5;i++) assert.throws(() => alerts.confirm(1,'000000',true), /Incorrect/);
    assert.throws(() => alerts.confirm(1,code,true), /fresh/);
    await alerts.begin({ id: 1, email: 'first@example.test' });
    alerts.confirm(1,/\b\d{6}\b/.exec(sent[1].text)[0],true);
    const start = db.prepare('SELECT last_digest FROM email_preferences WHERE user_id=1').get().last_digest;
    db.prepare('INSERT INTO jobs VALUES (?,?)').run(job.id,JSON.stringify({ ...job, expiresAt: new Date(Date.now()+10*86400000).toISOString() }));
    db.prepare("INSERT INTO job_events(job_id,kind,created_at) VALUES (?,'new',?)").run(job.id,Date.now());
    alerts.prepare(start+86400000-1);
    assert.equal(db.prepare('SELECT count(*) n FROM email_queue').get().n,0);
    alerts.prepare(start+86400000); alerts.prepare(start+86400000);
    assert.equal(db.prepare('SELECT count(*) n FROM email_queue').get().n,1);
    failNext = true; await alerts.drain();
    assert.equal(alerts.state(1).delivery.status,'pending');
    assert.ok(!alerts.state(1).delivery.error.includes('private'));
    await alerts.drain();
    assert.equal(db.prepare('SELECT attempts FROM email_queue').get().attempts,1);
    db.exec('UPDATE email_queue SET next_attempt=0'); await alerts.drain();
    assert.equal(alerts.state(1).delivery.status,'sent');
    assert.ok(!sent.at(-1).text.includes(profile.name));
    assert.ok(!sent.at(-1).text.includes('Python'));
    db.prepare('UPDATE users SET profile=? WHERE id=1').run(JSON.stringify({ ...profile, agentEnabled: false }));
    db.prepare('INSERT INTO saved VALUES (?,?)').run(1,job.id);
    db.prepare("INSERT INTO job_events(job_id,kind,created_at) VALUES (?,'closed',?)").run(job.id,Date.now());
    alerts.prepare(start+2*86400000);
    assert.match(db.prepare('SELECT text FROM email_queue ORDER BY id DESC LIMIT 1').get().text,/confirmed closed/);
    alerts.preferences(1,{enabled:false,minScore:60});
    assert.equal(db.prepare("SELECT count(*) n FROM email_queue WHERE status='pending'").get().n,0);
  } finally { db.close(); }
  let sentAfterRevocation = false;
  const results = [];
  await drainEmail({ claim: async () => results.length ? null : {id:1}, allowed: async () => false, finish: async (_item,_lease,result) => results.push(result) }, config, async () => { sentAfterRevocation = true; });
  assert.deepEqual(results,['cancelled']); assert.equal(sentAfterRevocation,false);
});
