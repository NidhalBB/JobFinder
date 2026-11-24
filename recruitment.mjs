import { randomUUID } from 'node:crypto';
import { countries, safeUrl } from './lib.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });
export const hiringStages = ['Applied','Shortlisted','Interview','Offer','Rejected','Withdrawn'];
export function accountType(value = 'jobseeker') {
  if (!['jobseeker','recruiter'].includes(value)) throw fail(400, 'Choose job seeker or recruiter.');
  return value;
}
export function companyInput(input) {
  const name = String(input.name || '').trim(), description = String(input.description || '').trim(), website = String(input.website || '').trim();
  if (name.length < 2 || name.length > 120 || description.length > 3000 || website.length > 300 || (website && !safeUrl(website))) throw fail(400, 'Enter a company name (2–120 characters), optional HTTPS website and description up to 3,000 characters.');
  return { name, description, website };
}
export function postingInput(input) {
  const title = String(input.title || '').trim(), description = String(input.description || '').trim();
  const status = input.status, country = input.country, remote = input.remote;
  const location = String(input.location || country || '').trim(), salary = String(input.salary || 'Salary not listed').trim(), type = String(input.type || 'Full-time').trim();
  const skills = String(input.skills || '').trim();
  if (title.length < 2 || title.length > 120 || description.length < 80 || description.length > 18000 || !countries.includes(country)
    || !['draft','open','closed'].includes(status) || typeof remote !== 'boolean' || location.length > 150 || salary.length > 150 || type.length > 60 || skills.length > 500) throw fail(400, 'Enter a title, 80–18,000 character description, valid country, work arrangement and posting status.');
  return { id: String(input.id || ''), title, description, status, country, remote, location, salary, type, skills };
}
export function submissionInput(input) {
  const message = String(input.message || '').trim();
  if (input.consent !== true || typeof input.shareCv !== 'boolean' || message.length > 2000) throw fail(400, 'Consent to share your name, email and application message; choose whether to share your current CV.');
  return { jobId: String(input.jobId || ''), consent: true, shareCv: input.shareCv, message };
}
export function reviewInput(input) {
  const notes = String(input.notes || ''), interviewAt = String(input.interviewAt || '');
  if (!hiringStages.includes(input.status) || input.status === 'Withdrawn' || notes.length > 5000 || (interviewAt && (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?Z$/.test(interviewAt) || !Number.isFinite(Date.parse(interviewAt))))) throw fail(400, 'Choose an applicant stage, notes up to 5,000 characters and a valid UTC interview time.');
  return { id: String(input.id || ''), status: input.status, notes, interviewAt: interviewAt || null };
}
export function consentInput(input) {
  if (typeof input.shareCv !== 'boolean' || typeof input.withdraw !== 'boolean' || (input.shareCv && input.consent !== true)) throw fail(400,'Confirm CV sharing, revoke it, or withdraw.');
  return { jobId:String(input.jobId || ''),shareCv:input.shareCv,withdraw:input.withdraw,consent:input.consent===true };
}
const cvHash = user => user.cv_name ? JSON.parse(user.profile).cvVersion : null;
export function createLocalRecruitment(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS companies(user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS postings(job_id TEXT PRIMARY KEY REFERENCES jobs(id),user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,status TEXT NOT NULL,content TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS submissions(id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES postings(job_id) ON DELETE CASCADE,candidate_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,status TEXT NOT NULL DEFAULT 'Applied',message TEXT NOT NULL,cv_hash TEXT,notes TEXT NOT NULL DEFAULT '',interview_at TEXT,created_at TEXT NOT NULL,UNIQUE(job_id,candidate_id));
    CREATE INDEX IF NOT EXISTS postings_owner ON postings(user_id);
    CREATE INDEX IF NOT EXISTS submissions_candidate ON submissions(candidate_id);
    UPDATE users SET profile=json_set(profile,'$.cvVersion',lower(hex(randomblob(16)))) WHERE cv IS NOT NULL AND json_extract(profile,'$.cvVersion') IS NULL;
  `);
  const kind = u => JSON.parse(u.profile).accountType || 'jobseeker';
  const recruiter = u => { if (kind(u) !== 'recruiter') throw fail(403, 'A recruiter account is required.'); };
  const candidate = u => { if (kind(u) !== 'jobseeker') throw fail(403, 'A job-seeker account is required.'); };
  const event = (id, type) => db.prepare('INSERT INTO job_events(job_id,kind,created_at) VALUES (?,?,?)').run(id,type,Date.now());
  function state(user) {
    if (kind(user) === 'recruiter') return {
      company: JSON.parse(db.prepare('SELECT data FROM companies WHERE user_id=?').get(user.id)?.data || 'null'),
      postings: db.prepare('SELECT job_id,status,content FROM postings WHERE user_id=? ORDER BY rowid DESC').all(user.id).map(p=>({...JSON.parse(p.content),id:p.job_id,status:p.status})),
      applicants: db.prepare("SELECT s.*,u.email,json_extract(u.profile,'$.name') name,json_extract(u.profile,'$.cvVersion') cv_version,u.cv IS NOT NULL has_cv FROM submissions s JOIN postings p ON p.job_id=s.job_id JOIN users u ON u.id=s.candidate_id WHERE p.user_id=? ORDER BY s.created_at DESC").all(user.id).map(s=>({
        id:s.id,jobId:s.job_id,name:s.name,email:s.email,status:s.status,message:s.message,notes:s.notes,interviewAt:s.interview_at,createdAt:s.created_at,
        cvAvailable:Boolean(s.cv_hash && s.has_cv && s.cv_hash===s.cv_version && s.status!=='Withdrawn'),
      })),
    };
    return { applications: db.prepare("SELECT s.*,json_extract(u.profile,'$.cvVersion') cv_version,u.cv IS NOT NULL has_cv FROM submissions s JOIN users u ON u.id=s.candidate_id WHERE s.candidate_id=? ORDER BY s.created_at DESC").all(user.id).map(s=>({
      id:s.id,jobId:s.job_id,status:s.status,interviewAt:s.interview_at,cvShared:Boolean(s.cv_hash && s.has_cv && s.cv_hash===s.cv_version && s.status!=='Withdrawn'),createdAt:s.created_at,
    })) };
  }
  function company(user, input) {
    recruiter(user);
    db.prepare('INSERT INTO companies VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data').run(user.id,JSON.stringify(input));
    return { ok:true };
  }
  function posting(user, input) {
    recruiter(user);
    const company = JSON.parse(db.prepare('SELECT data FROM companies WHERE user_id=?').get(user.id)?.data || 'null');
    if (!company) throw fail(400, 'Save your company profile first.');
    const old = input.id ? db.prepare('SELECT * FROM postings WHERE job_id=? AND user_id=?').get(input.id,user.id) : null;
    if (input.id && !old) throw fail(404, 'Your posting was not found.');
    const id = old?.job_id || `nextstep-${randomUUID()}`, at = new Date().toISOString();
    const previous = old ? JSON.parse(db.prepare('SELECT data FROM jobs WHERE id=?').get(id).data) : null;
    const job = { id,source:'Nextstep',title:input.title,company:company.name,country:input.country,location:input.location,remote:input.remote,
      tags:input.skills.split(',').map(s=>s.trim()).filter(Boolean).slice(0,20),type:input.type,salary:input.salary,
      description:input.status==='open'?input.description:'',closed:input.status!=='open',url:'/',publishedAt:old?.status==='open'?previous.publishedAt:at,updatedAt:at };
    db.exec('BEGIN');
    try {
      db.prepare('INSERT INTO jobs VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,fingerprint=excluded.fingerprint').run(id,JSON.stringify(job),randomUUID());
      db.prepare('INSERT INTO postings VALUES (?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET status=excluded.status,content=excluded.content').run(id,user.id,input.status,JSON.stringify(input));
      if (input.status==='open') event(id,old?.status==='open'?'updated':'new');
      else if (old?.status==='open') event(id,'closed');
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return { id };
  }
  function apply(user, input) {
    candidate(user);
    const post = db.prepare("SELECT * FROM postings WHERE job_id=? AND status='open'").get(input.jobId);
    if (!post) throw fail(409, 'This employer posting is no longer open.');
    if (db.prepare('SELECT 1 FROM submissions WHERE job_id=? AND candidate_id=?').get(input.jobId,user.id)) throw fail(409, 'You have already applied. Manage CV sharing or withdraw instead.');
    const hash = input.shareCv ? cvHash(user) : null;
    if (input.shareCv && !hash) throw fail(400, 'Upload a CV before sharing it.');
    db.exec('BEGIN');
    try {
      db.prepare('INSERT INTO submissions(id,job_id,candidate_id,message,cv_hash,created_at) VALUES (?,?,?,?,?,?)').run(randomUUID(),input.jobId,user.id,input.message,hash,new Date().toISOString());
      db.prepare("INSERT INTO applications VALUES (?,?,'Applied','','',?) ON CONFLICT(user_id,job_id) DO NOTHING").run(user.id,input.jobId,new Date().toISOString());
      db.exec('COMMIT');
    } catch(error) { db.exec('ROLLBACK'); throw error; }
    return { ok:true };
  }
  function consent(user, input) {
    candidate(user);
    const row = db.prepare('SELECT * FROM submissions WHERE job_id=? AND candidate_id=?').get(input.jobId,user.id);
    if (!row || row.status==='Withdrawn') throw fail(404,'Active application not found.');
    const hash = input.shareCv ? cvHash(user) : null;
    if (input.shareCv && !hash) throw fail(400,'Upload a CV first.');
    db.prepare('UPDATE submissions SET cv_hash=?,status=? WHERE id=?').run(input.withdraw ? null:hash,input.withdraw?'Withdrawn':row.status,row.id);
    if (input.withdraw) db.prepare("UPDATE applications SET status='Withdrawn',updated_at=? WHERE user_id=? AND job_id=?").run(new Date().toISOString(),user.id,row.job_id);
    return { ok:true };
  }
  function review(user, input) {
    recruiter(user);
    const row = db.prepare('SELECT s.* FROM submissions s JOIN postings p ON p.job_id=s.job_id WHERE s.id=? AND p.user_id=?').get(input.id,user.id);
    if (!row) throw fail(404,'Applicant not found.');
    if (row.status==='Withdrawn') throw fail(409,'This candidate withdrew. Their application cannot be advanced.');
    db.prepare('UPDATE submissions SET status=?,notes=?,interview_at=? WHERE id=?').run(input.status,input.notes,input.interviewAt,input.id);
    db.prepare('INSERT INTO activities(user_id,message,created_at) VALUES (?,?,?)').run(row.candidate_id,`An employer updated your application to ${input.status}. Check My applications.`,new Date().toISOString());
    return { ok:true };
  }
  function cv(user, id) {
    recruiter(user);
    const row = db.prepare("SELECT u.* ,s.cv_hash FROM submissions s JOIN postings p ON p.job_id=s.job_id JOIN users u ON u.id=s.candidate_id WHERE s.id=? AND p.user_id=? AND s.status<>'Withdrawn'").get(id,user.id);
    if (!row || !row.cv_hash || row.cv_hash!==cvHash(row)) throw fail(404,'CV sharing is unavailable, revoked, or the CV has been replaced.');
    return row;
  }
  function remove(user) {
    for (const p of db.prepare('SELECT job_id,status FROM postings WHERE user_id=?').all(user.id)) {
      const job = JSON.parse(db.prepare('SELECT data FROM jobs WHERE id=?').get(p.job_id).data);
      db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify({...job,closed:true,description:'',company:'Deleted employer'}),p.job_id);
      if (p.status==='open') event(p.job_id,'closed');
    }
  }
  return { state, company, posting, apply, consent, review, cv, remove };
}
