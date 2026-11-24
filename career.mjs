import { countries, matchJob, plainText } from './lib.mjs';
import { makeQuiz } from './interview.mjs';

const skills = ['JavaScript', 'TypeScript', 'Python', 'Java', 'C++', 'C#', '.NET', 'SQL', 'PostgreSQL', 'MySQL', 'MongoDB', 'React', 'Angular', 'Vue', 'Node.js', 'PHP', 'Laravel', 'Symfony', 'HTML', 'CSS', 'Docker', 'Kubernetes', 'AWS', 'Azure', 'GCP', 'Linux', 'Git', 'GitLab', 'GitHub', 'CI/CD', 'Jenkins', 'Terraform', 'Selenium', 'Playwright', 'Cypress', 'Postman', 'ISTQB', 'JUnit', 'Pytest', 'API testing', 'REST', 'GraphQL', 'Agile', 'Scrum', 'Jira', 'Figma', 'Excel', 'Power BI', 'Tableau', 'SAP', 'Salesforce', 'Accounting', 'Comptabilité', 'Marketing', 'SEO', 'Customer service', 'Gestion de projet', 'Project management'];
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentions = (text, term) => new RegExp(`(?<![a-z0-9])${escapeRegex(term)}(?![a-z0-9])`, 'i').test(text);
export const detectedSkills = text => skills.filter(skill => mentions(text, skill));

export function assessJob(job, profile) {
  const detected = detectedSkills(`${job.title} ${(job.tags || []).join(' ')} ${job.description || ''}`);
  const evidence = profile.cvText || '';
  const matched = evidence ? detected.filter(skill => mentions(evidence, skill)) : [];
  return {
    preferenceMatch: matchJob(job, profile), hasCvText: Boolean(evidence.trim()),
    detectedSkills: detected, matched, missing: evidence ? detected.filter(skill => !matched.includes(skill)) : [],
    coverage: evidence.trim() && detected.length ? Math.round(matched.length / detected.length * 100) : null,
    explanation: 'Keyword evidence, not a hiring probability. Not found in your CV does not mean you lack a skill. Requirements such as seniority, education, language fluency and work authorization need manual review.',
  };
}
export function proposeLinkedIn(text) {
  const proposal = { skills: detectedSkills(text).join(', ').slice(0, 500) };
  if (/\b(?:Tunisia|Tunisie)\b/i.test(text)) proposal.country = 'Tunisia';
  else proposal.country = [...countries].sort((a, b) => b.length - a.length).find(c => mentions(text, c));
  const rows = parseCsv(text);
  if (rows.length >= 2) {
    const header = rows[0].map(x => x.toLowerCase().replace(/[^a-z]/g, ''));
    const field = key => rows[1][header.indexOf(key)]?.trim() || '';
    const name = `${field('firstname')} ${field('lastname')}`.trim();
    if (name.length >= 2 && name.length <= 80) proposal.name = name;
    if (field('headline')) proposal.role = field('headline').slice(0, 120);
    if (header.length === 1 && ['name', 'skill', 'skills'].includes(header[0])) {
      proposal.skills = [...new Set(rows.slice(1).map(row => row[0]?.trim()).filter(Boolean))].join(', ').slice(0, 500);
    }
  }
  return Object.fromEntries(Object.entries(proposal).filter(([, value]) => value));
}
function parseCsv(text) {
  const rows = []; let row = [], value = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') { value += '"'; i++; } else quoted = !quoted; }
    else if (!quoted && (c === ',' || c === '\n')) {
      row.push(value.replace(/\r$/, '')); value = '';
      if (c === '\n') { rows.push(row); row = []; }
    } else value += c;
  }
  row.push(value.replace(/\r$/, '')); rows.push(row);
  return rows;
}
export async function careerRequest(action, input, profile, lookup) {
  let job;
  if (input.jobId) job = await lookup(String(input.jobId));
  else {
    const title = plainText(input.title).slice(0, 120), company = plainText(input.company).slice(0, 120);
    const description = String(input.description || '');
    if (!title || !company || !description.trim() || description.length > 18000) throw new Error('Enter a job title, company, and advertisement text (up to 18,000 characters).');
    job = { title, company, description, tags: [], country: profile.country, remote: profile.workMode === 'Remote' };
  }
  if (!job) throw new Error('Job not found.');
  if (action === 'analyze') return assessJob(job, profile);
  if (action === 'quiz') return makeQuiz(job,input);
  throw new Error('Unknown career tool.');
}
