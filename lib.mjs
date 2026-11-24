import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import ct from 'countries-and-timezones';

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
const countryCodes = 'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' ');
export const countries = countryCodes.map(code => regionNames.of(code)).sort((a, b) => a.localeCompare(b));
export const statuses = ['Applied', 'Interview', 'Offer', 'Rejected', 'Withdrawn'];
export const defaultCountry = 'Tunisia';
export const feeds = [
  { name: 'Arbeitnow', url: 'https://www.arbeitnow.com/api/job-board-api' },
  { name: 'Arbeitnow UK', url: 'https://www.arbeitnow.co.uk/api/job-board-api' },
  { name: 'Jobicy', url: 'https://jobicy.com/api/jobs?count=100' },
  { name: 'Himalayas', url: 'https://himalayas.app/jobs/api?limit=20' },
  { name: 'Himalayas Tunisia', url: 'https://himalayas.app/jobs/api/search?country=TN&sort=recent' },
  { name: 'Remotive', url: 'https://remotive.com/api/remote-jobs?limit=300', cooldown: 21600000 },
];
export const sourceNames = [...new Set(feeds.map(feed=>feed.name.startsWith('Himalayas')?'Himalayas':feed.name)),'Nextstep'];
export const feedRecords = (payload, name) => name.startsWith('Himalayas') || ['Jobicy','Remotive'].includes(name) ? payload.jobs : payload.data;

const scryptAsync = promisify(scrypt);
let passwordWork = 0;
async function derivePassword(password, salt, modern) {
  if (passwordWork >= 2) throw Object.assign(new Error('Password service is busy. Please try again shortly.'), { status: 503 });
  passwordWork++;
  try {
    return await scryptAsync(password, salt, 64, modern ? { N: 65536, r: 8, p: 2, maxmem: 96 * 1024 * 1024 } : {});
  } finally { passwordWork--; }
}

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `scrypt-v2:${salt}:${(await derivePassword(password, salt, true)).toString('hex')}`;
}

export async function verifyPassword(password, hash) {
  const modern = hash.startsWith('scrypt-v2:');
  const [salt, key] = hash.split(':').slice(modern ? 1 : 0);
  if (!/^[a-f0-9]{32}$/.test(salt || '') || !/^[a-f0-9]{128}$/.test(key || '')) throw new Error('Stored password hash is invalid.');
  return timingSafeEqual(Buffer.from(key, 'hex'), await derivePassword(password, salt, modern));
}

export function plainText(value = '') {
  return String(value).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
}

export function safeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

function listingCountry(raw, source, location) {
  if (source === 'Jobicy') return location || 'Not specified';
  if (source === 'Arbeitnow UK') return 'United Kingdom';
  const stated = countries.find(c => new RegExp(`\\b${c}\\b`, 'i').test(`${raw.country || ''} ${location}`));
  if (stated) return stated;
  const city = location.toLowerCase();
  if (/\b(berlin|hamburg|bremen|frankfurt|munich|münchen|köln|cologne|düsseldorf|dusseldorf|stuttgart|leipzig|dresden|hannover|hanover|bonn|dortmund|essen|nürnberg|nuremberg|karlsruhe|mannheim|potsdam|wiesbaden|mainz|freiburg|augsburg|regensburg|münster|bochum|duisburg|aachen|bielefeld|kiel|rostock|ludwigshafen|braunschweig|heidelberg|erlangen|darmstadt)\b/.test(city)) return 'Germany';
  if (/\b(london|manchester|birmingham|bristol|edinburgh|glasgow|leeds|cambridge|oxford)\b/.test(city)) return 'United Kingdom';
  if (/\b(amsterdam|rotterdam|utrecht|eindhoven|the hague)\b/.test(city)) return 'Netherlands';
  if (/\b(paris|lyon|marseille|toulouse|bordeaux)\b/.test(city)) return 'France';
  return 'Not specified';
}

export function normalizeJob(raw, source, now = new Date().toISOString()) {
  if(source==='Remotive') {
    const url=safeUrl(raw.url);
    if(!url || new URL(url).hostname!=='remotive.com' || !raw.id || !raw.title || !raw.company_name) return null;
    const published=new Date(raw.publication_date);
    return {id:`remotive-${raw.id}`,source,sourceUrl:url,url,title:plainText(raw.title),company:plainText(raw.company_name),
      country:plainText(raw.candidate_required_location || 'Not specified'),location:plainText(raw.candidate_required_location || 'Location not specified'),
      remote:true,tags:(Array.isArray(raw.tags)?raw.tags:[]).slice(0,5).map(plainText),type:plainText(raw.job_type || 'Not specified').replaceAll('_',' '),
      description:plainText(raw.description).slice(0,18000),salary:plainText(raw.salary || 'Salary not listed'),publishedAt:Number.isFinite(published.getTime())?published.toISOString():now,updatedAt:now};
  }
  if (source.startsWith('Himalayas')) {
    let guid;
    try { guid = new URL(raw.guid); } catch { return null; }
    if (guid.origin !== 'https://himalayas.app' || !/^\/companies\/[^/]+\/jobs\/[^/]+$/.test(guid.pathname) || !safeUrl(raw.applicationLink) || !raw.title || !raw.companyName) return null;
    const expires = new Date(Number(raw.expiryDate) * 1000), published = new Date(Number(raw.pubDate) * 1000);
    if (!Number.isFinite(expires.getTime()) || expires.getTime() <= Date.parse(now)) return null;
    const restrictions = Array.isArray(raw.locationRestrictions) ? raw.locationRestrictions.filter(v => typeof v === 'string') : [];
    return {
      id: `himalayas-${guid.pathname}`, source: 'Himalayas', sourceUrl: guid.href, statusUrl: `https://himalayas.app/jobs/api${guid.pathname}`,
      title: plainText(raw.title), company: plainText(raw.companyName), url: raw.applicationLink,
      country: restrictions.length ? restrictions.join(', ') : 'Worldwide',
      location: restrictions.length ? restrictions.join(', ') : 'Worldwide (check timezone restrictions)',
      remote: true, timezoneRestrictions: Array.isArray(raw.timezoneRestrictions) ? raw.timezoneRestrictions.filter(Number.isFinite) : [],
      tags: (Array.isArray(raw.parentCategories) ? raw.parentCategories : []).slice(0, 5).map(plainText),
      description: plainText(raw.description).slice(0, 18000), type: plainText(raw.employmentType || 'Not specified'),
      salary: raw.minSalary ? `${raw.currency || ''} ${raw.minSalary}${raw.maxSalary ? ` - ${raw.maxSalary}` : ''} / ${raw.salaryPeriod || 'annual'}` : 'Salary not listed',
      publishedAt: Number.isFinite(published.getTime()) ? published.toISOString() : now,
      expiresAt: expires.toISOString(), updatedAt: now, closed: false,
    };
  }
  const jobicy = source === 'Jobicy';
  const id = jobicy ? raw.id : raw.slug;
  const title = plainText(jobicy ? raw.jobTitle : raw.title);
  const company = plainText(jobicy ? raw.companyName : raw.company_name);
  const url = safeUrl(raw.url);
  if (!id || !title || !company || !url) return null;
  const published = jobicy ? new Date(raw.pubDate) : new Date(Number(raw.created_at) * 1000);
  const location = plainText(jobicy ? raw.jobGeo : raw.location);
  const tags = jobicy ? raw.jobIndustry : raw.tags;
  return {
    id: `${source.toLowerCase()}-${id}`, title, company, url, source,
    location: location || 'Location not specified',
    country: listingCountry(raw, source, location),
    remote: jobicy || raw.remote === true,
    tags: Array.isArray(tags) ? tags.slice(0, 5).map(plainText) : [],
    type: (jobicy ? raw.jobType : raw.job_types)?.[0] || 'Not specified',
    description: plainText(jobicy ? raw.jobDescription : raw.description).slice(0, 18000),
    salary: jobicy && Number(raw.salaryMin) > 0
      ? `${raw.salaryCurrency || ''} ${Number(raw.salaryMin).toLocaleString('en-US')}${raw.salaryMax ? ` - ${Number(raw.salaryMax).toLocaleString('en-US')}` : ''} / ${raw.salaryPeriod || 'period not specified'}`
      : 'Salary not listed',
    publishedAt: Number.isNaN(published.getTime()) ? now : published.toISOString(),
    updatedAt: now,
  };
}

const regionSet = codes => new Set(codes.split(' ').map(code => regionNames.of(code)));
const european = regionSet('AD AL AT AX BA BE BG BY CH CY CZ DE DK EE ES FI FO FR GB GG GI GR HR HU IE IM IS IT JE LI LT LU LV MC MD ME MK MT NL NO PL PT RO RS RU SE SI SJ SK SM UA VA');
const europeanUnion = regionSet('AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE');
const emea = new Set([...european, ...regionSet('AE AM AO AZ BF BH BI BJ BW CD CF CG CI CM CV DJ DZ EG EH ER ET GA GE GH GM GN GQ GW IL IQ IR JO KE KM KW LB LR LS LY MA MG ML MR MU MW MZ NA NE NG OM PS QA RE RW SA SC SD SH SL SN SO SS ST SY SZ TD TG TN TR TZ UG YE YT ZA ZM ZW')]);
const countryOffsets = new Map(countryCodes.map(code => [regionNames.of(code), (ct.getCountry(code)?.timezones || []).map(zone => ct.getTimezone(zone)?.utcOffset / 60)]));
export function countryMatches(job, country) {
  if (!country || country === 'All countries') return true;
  if (job.timezoneRestrictions?.length) {
    if (!countryOffsets.get(country)?.some(offset => job.timezoneRestrictions.includes(offset))) return false;
  }
  const eligibility = job.country.toLowerCase();
  if (/\b(worldwide|anywhere|global)\b/.test(eligibility)) return true;
  const locations = eligibility.split(/[,;/|]|\s+(?:and|or)\s+|\s*\+\s*/).map(s => s.trim().replace(/\s+only$/, ''));
  if (locations.includes(country.toLowerCase())) return true;
  if (country === 'United States' && locations.some(s => ['usa', 'us', 'united states of america'].includes(s))) return true;
  if (country === 'United Kingdom' && locations.some(s => ['uk', 'great britain'].includes(s))) return true;
  if (european.has(country) && locations.includes('europe')) return true;
  if (europeanUnion.has(country) && locations.some(s => ['eu', 'european union'].includes(s))) return true;
  return emea.has(country) && locations.includes('emea');
}

export function dailyRefreshDue(profiles, lastAttempt, now = Date.now()) {
  return profiles.some(p => p.agentEnabled) && now - lastAttempt >= 86400000;
}

export function matchJob(job, profile) {
  const text = `${job.title} ${job.tags.join(' ')} ${job.description}`.toLowerCase();
  const skills = (profile.skills || '').split(',').map(s => s.trim()).filter(Boolean);
  const matched = skills.filter(skill => text.includes(skill.toLowerCase()));
  const roleWords = (profile.role || '').toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const roleMatch = roleWords.length ? roleWords.filter(w => job.title.toLowerCase().includes(w)).length / roleWords.length : 0;
  const location = countryMatches(job, profile.country);
  const workMatch = profile.workMode === 'Any' || !profile.workMode || (profile.workMode === 'Remote' ? job.remote : !job.remote);
  const score = Math.round((skills.length ? matched.length / skills.length * 40 : 0) + roleMatch * 35 + (location ? 15 : 0) + (workMatch ? 10 : 0));
  return { score, matchedSkills: matched, countryMatch: location, workMatch };
}

export function validateProfile(input) {
  const name = String(input.name || '').trim();
  const role = String(input.role || '').trim();
  const country = String(input.country === undefined ? defaultCountry : input.country);
  const skills = String(input.skills || '').trim();
  const workMode = input.workMode || 'Any';
  if (name.length < 2 || name.length > 80) throw new Error('Please enter a name between 2 and 80 characters.');
  if (!role || role.length > 120) throw new Error('Please enter a target role (up to 120 characters).');
  if (!countries.includes(country)) throw new Error('Please choose a supported country.');
  if (skills.length > 500) throw new Error('Please keep your skills under 500 characters.');
  if (!['Any', 'Remote', 'On-site'].includes(workMode)) throw new Error('Please choose a valid work arrangement.');
  const links = {};
  for (const [field, host, path] of [['linkedin', 'www.linkedin.com', /^\/in\/[^/]+\/?$/], ['github', 'github.com', /^\/[^/]+\/?$/], ['gitlab', 'gitlab.com', /^\/[^/]+\/?$/]]) {
    const value = String(input[field] || '').trim();
    if (!value) { links[field] = ''; continue; }
    let url;
    try { url = new URL(value); } catch { throw new Error(`Enter a valid HTTPS ${field} profile URL.`); }
    if (url.protocol !== 'https:' || ![host, host.replace(/^www\./, '')].includes(url.hostname) || url.username || url.password || url.port || !path.test(url.pathname) || value.length > 300) throw new Error(`Use a public ${field} profile URL, not a repository, sign-in page or another host.`);
    url.search = ''; url.hash = '';
    links[field] = url.href;
  }
  return { name, role, country, skills, workMode, agentEnabled: input.agentEnabled !== false, ...links };
}
