import { icon } from './icons.js';

const $ = (selector, root = document) => root.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = new Date();
const ago = days => new Date(Date.now() - days * 86400000).toISOString();
const demoJobs = [
  { id: 'demo-1', company: 'Linear', title: 'Senior Product Designer', country: 'Netherlands', location: 'Amsterdam, Netherlands', remote: true, salary: '\u20ac75,000 - \u20ac95,000 / year', tags: ['Design', 'Product', 'Figma'], score: 98, letter: 'L', color: 'linear', publishedAt: ago(.08) },
  { id: 'demo-2', company: 'Notion', title: 'Product Designer', country: 'Netherlands', location: 'Amsterdam, Netherlands', remote: false, salary: '\u20ac65,000 - \u20ac85,000 / year', tags: ['Design', 'SaaS', 'UX/UI'], score: 95, letter: 'N', color: 'notion', publishedAt: ago(.2) },
  { id: 'demo-3', company: 'Spotify', title: 'Senior UX Designer', country: 'Worldwide', location: 'Remote, Europe', remote: true, salary: '\u20ac70,000 - \u20ac90,000 / year', tags: ['UX Design', 'Research', 'Figma'], score: 93, letter: '\u224b', color: 'spotify', publishedAt: ago(.4) },
  { id: 'demo-4', company: 'Miro', title: 'Product Designer, Growth', country: 'Netherlands', location: 'Amsterdam, Netherlands', remote: false, salary: '\u20ac68,000 - \u20ac88,000 / year', tags: ['Product', 'Growth', 'UX/UI'], score: 91, letter: 'M', color: 'miro', publishedAt: ago(.8) },
  { id: 'demo-5', company: 'Figma', title: 'Design Systems Designer', country: 'Germany', location: 'Berlin, Germany', remote: true, salary: '\u20ac80,000 - \u20ac100,000 / year', tags: ['Design Systems', 'Figma'], score: 89, letter: 'F', color: 'figma', publishedAt: ago(1.2) },
  { id: 'demo-6', company: 'Revolut', title: 'UX Researcher', country: 'United Kingdom', location: 'London, United Kingdom', remote: true, salary: '\u00a360,000 - \u00a380,000 / year', tags: ['Research', 'Fintech'], score: 87, letter: 'R', color: 'revolut', publishedAt: ago(2) },
];
for (const job of demoJobs) Object.assign(job, { source: 'Sample listing', type: 'Full-time', description: 'This is an illustrative job, not a real vacancy. Create your account and switch to live jobs to discover opportunities from connected public feeds. Sample listings demonstrate how your personalized dashboard and application tracker work.' });
const demoApplications = [
  { jobId: 'demo-1', status: 'Interview', updatedAt: ago(.15), notes: '', followUp: '' },
  { jobId: 'demo-2', status: 'Applied', updatedAt: ago(1), notes: '', followUp: '' },
  { jobId: 'demo-3', status: 'Offer', updatedAt: ago(2), notes: '', followUp: '' },
];
let state = { user: null, jobs: [], applications: [], saved: [], activities: [], countries: [], sync: { sources: [] } };
let view = 'overview';
let preview = false;
let guestBrowsing = false;
let query = '';
let country = 'Tunisia';
let tab = 'all';
let source = 'all';
let sort = 'match';
let busy = false;
let authMode = 'login';
let authStep = 1;
let authDraft = {};
let modalTrigger = null;
let jobsRequest = 0;
let searchTimer;
let discoveryRequest = 0;
let quizJobId = '';
let currentQuiz = null;
let editingPosting = null;
let applicantStage = 'all';
const isRecruiter = () => state.user?.accountType === 'recruiter';
const views = { overview: 'Overview', discover: 'Discover jobs', applications: 'My applications', saved: 'Saved jobs', agent: 'My job agent', profile: 'Profile & preferences', interview: 'Interview practice', hiring:'Recruitment dashboard' };
const activeJobs = () => preview ? demoJobs : state.hosted && ['applications', 'saved'].includes(view) ? state.ownedJobs : state.jobs;
const applications = () => preview ? demoApplications : state.applications;
const saved = () => preview ? ['demo-4', 'demo-5'] : state.saved;
const profile = () => state.user || { name: 'Guest', role: '', country: 'Tunisia', skills: '', workMode: 'Any', agentEnabled: false };
const initials = name => name.split(/\s+/).slice(0, 2).map(x => x[0]).join('').toUpperCase();
const relative = value => {
  if (!value) return 'Not yet';
  const mins = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60000));
  return mins < 1 ? 'Just now' : mins < 60 ? `${mins}m ago` : mins < 1440 ? `${Math.floor(mins / 60)}h ago` : `${Math.floor(mins / 1440)}d ago`;
};
const empty = (heading, text, action = '') => `<div class="empty-state"><div class="empty-icon">${icon('search')}</div><h3>${heading}</h3><p>${text}</p>${action}</div>`;
const button = (text, action, cls = 'button primary', symbol = '') => `<button class="${cls}" data-action="${action}">${symbol ? icon(symbol) : ''}${text}</button>`;

async function api(path, method = 'GET', data) {
  const res = await fetch(`/api/${path}`, { method, headers: data ? { 'Content-Type': 'application/json' } : {}, body: data ? JSON.stringify(data) : undefined });
  const result = await res.json();
  if (!res.ok) throw new Error(result.error || result.sources?.filter(s => !s.ok).map(s => `${s.name}: ${s.error}`).join('; ') || 'The request failed. Please try again.');
  return result;
}
const jobQuery = (offset = 0) => new URLSearchParams({ country, q: query, tab, source, sort, offset }).toString();
async function load() {
  state = await api(`state?${jobQuery()}`);
  if(state.user) state.recruitment=await api('recruitment');
}
async function fetchHostedJobs(append = false) {
  if (!state.hosted || preview) return;
  const request = ++jobsRequest;
  const page = await api(`jobs?${jobQuery(append ? state.paging.nextOffset : 0)}`);
  if (request !== jobsRequest) return;
  state.jobs = append ? [...state.jobs, ...page.jobs] : page.jobs;
  state.paging = { total: page.total, nextOffset: page.nextOffset };
}
let toastTimer;
function toast(message, error = false) {
  const el = $('#toast');
  el.className = `show ${error ? 'error' : ''}`;
  el.innerHTML = `${icon(error ? 'help' : 'check')}<span>${esc(message)}</span>`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 5500);
}
function logo(job) { return `<span class="company-logo ${job.color || 'generic'}">${esc(job.letter || initials(job.company))}</span>`; }

function render() {
  if(!state.user && !guestBrowsing) {
    authMode='login'; authStep=1;
    $('#app').innerHTML=`<main class="auth-landing"><section class="panel settings-panel"><a class="brand" href="/"><img src="/favicon.svg" width="38" height="38" alt="">nextstep.</a><h1>Your next chapter starts here.</h1><p>Find opportunities worldwide or recruit your next teammate.</p><form id="auth-form"><label>Email address<input name="email" type="email" autocomplete="email" required></label><label>Password<input name="password" type="password" autocomplete="current-password" minlength="10" maxlength="128" required></label><div id="form-error" class="field-error" role="alert"></div><button type="submit" class="button primary full-button">Sign in</button></form><div class="detail-actions">${button('Create an account','register','button secondary')}${button('Browse public jobs','browse-public','text-button')}</div>${state.hosted?`${button('Forgot password?','recover','text-button')} ${button('Resend confirmation','resend-confirmation','text-button')}`:''}<p class="muted">Separate job seeker and recruiter accounts. Public job listings remain available without signing up.</p></section></main>`;
    $('#auth-form').id='login-form';
    return;
  }
  const p = profile();
  $('#app').innerHTML = `
    <aside class="sidebar">
      <a class="brand" href="#" data-action="nav:overview"><img src="/favicon.svg" alt="" width="34" height="34"><span>nextstep<span class="brand-dot">.</span></span></a>
      <button class="workspace-switch" data-action="${state.user ? 'nav:profile' : 'login'}"><span class="workspace-avatar">${state.user ? esc(initials(p.name)) : 'G'}</span><span><strong>${state.user ? esc(p.name.split(' ')[0]) + "'s workspace" : 'Public catalog'}</strong><small>${isRecruiter()?'Recruiter account':state.user ? 'Job seeker account' : 'No account required'}</small></span>${icon('down')}</button>
      <div class="nav-caption">WORKSPACE</div>
      <nav aria-label="Main navigation">
        ${(isRecruiter()?[['hiring','briefcase'],['discover','search']]:[['overview', 'grid'], ['discover', 'search'], ['applications', 'briefcase'], ['saved', 'bookmark']]).map(([key, symbol]) => `<button class="nav-item ${view === key ? 'active' : ''}" data-action="nav:${key}">${icon(symbol)}<span>${views[key]}</span>${key === 'applications' ? `<span class="nav-count">${applications().length}</span>` : ''}${key === 'discover' ? '<span class="new-dot"></span>' : ''}</button>`).join('')}
        <div class="nav-caption second">YOUR TOOLKIT</div>
        ${!isRecruiter()?`<button class="nav-item ${view === 'interview' ? 'active' : ''}" data-action="nav:interview">${icon('file')}<span>Interview practice</span></button>
        <button class="nav-item ${view === 'agent' ? 'active' : ''}" data-action="nav:agent">${icon('sparkles')}<span>My job agent</span></button>`:''}
        <button class="nav-item ${view === 'profile' ? 'active' : ''}" data-action="nav:profile">${icon('user')}<span>Profile & preferences</span></button>
      </nav>
      <div class="sidebar-bottom">
        <div class="sidebar-tip"><span class="tip-icon">${icon('sparkles')}</span><h4>A little focus. A big step.</h4><p>Your next opportunity could be one great match away.</p><button data-action="${state.user ? 'nav:profile' : 'register'}">Perfect your profile ${icon('arrow')}</button></div>
        <button class="nav-item" data-action="help">${icon('help')}<span>Help & getting started</span>${icon('external')}</button>
        <button class="sidebar-user" data-action="${state.user ? 'nav:profile' : 'register'}"><span class="avatar">${esc(initials(p.name))}</span><span><strong>${esc(p.name)}</strong><small>${state.user ? 'Personal account' : 'Preview account'}</small></span>${icon('settings')}</button>
      </div>
    </aside>
    <div class="workspace">
      <header class="topbar"><div class="breadcrumb"><button class="icon-button mobile-menu" data-action="menu" aria-label="Toggle navigation">${icon('menu')}</button>${icon('grid')}<span>Workspace</span>${icon('chevron')}<strong>${views[view]}</strong></div><div class="topbar-right"><span class="today">${icon('calendar')}${today.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span><span class="topbar-divider"></span><button class="icon-button notification-button" data-action="notifications" aria-label="View notifications">${icon('bell')}<i></i></button><button class="avatar small" data-action="${state.user ? 'nav:profile' : 'register'}" aria-label="Open account">${esc(initials(p.name))}</button></div></header>
      <main>
        ${!state.user ? `<div class="preview-strip"><span>Public job catalog. Sign in for private tools.</span>${button('Sign in','login','text-button')}</div>` : ''}
        ${renderView()}
        <footer><span>Made for your next chapter.</span><span>${icon('shield')} Your CV and preferences stay private.</span><span>nextstep<span class="brand-dot">.</span></span></footer>
      </main>
    </div>`;
  if ($('#discovery-links')) void updateDiscovery();
}
function pageHeading(eyebrow, title, text, action = '') {
  return `<section class="page-heading"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p>${text}</p></div>${action}</section>`;
}
function renderView() {
  if (view === 'profile') return renderProfile();
  if (view === 'interview') return renderInterview();
  if (view === 'hiring' || (isRecruiter() && view==='overview')) return renderRecruitment();
  if (view === 'agent') return renderAgent()+`<section class="panel settings-panel"><h2>More jobs inside your results</h2><p><a href="https://remotive.com" target="_blank" rel="noopener noreferrer">Remotive</a>: remote vacancies imported into the same list, with attribution and original links. Public feed results are delayed 24 hours; this app fetches them at most every 6 hours.</p><p>Nextstep: vacancies published directly by recruiter accounts, with in-app applications and employer status updates. No source covers every vacancy; Google, Tanitjobs and Keejob remain external search links until a permitted data integration is available.</p></section>`;
  if (view === 'applications') return renderApplications();
  if (view === 'saved') return renderSaved();
  const p = profile();
  const apps = applications();
  const counts = [
    { title: 'Jobs for you', value: preview ? 6 : state.hosted ? state.matchedCount : state.jobs.filter(j => j.countryMatch && j.workMatch && j.score >= 40).length, symbol: 'briefcase', color: 'purple', note: preview ? 'Personalized to your profile' : '40%+ preference match', trend: 'Your next move' },
    { title: 'Applications sent', value: apps.length, symbol: 'external', color: 'blue', note: 'Every step is progress', trend: 'Keep it going' },
    { title: 'In conversation', value: apps.filter(a => a.status === 'Interview').length, symbol: 'chat', color: 'orange', note: 'Great things start with a hello', trend: 'Looking good' },
    { title: 'Saved for later', value: saved().length, symbol: 'bookmark', color: 'green', note: "Opportunities you don't want to lose", trend: 'Worth a closer look' },
  ];
  return `${pageHeading('YOUR CAREER, IN MOTION', `A new day. New possibilities<span class="brand-dot">.</span>`, `Welcome back, ${esc(p.name.split(' ')[0])} ${'<span class="wave">&#128075;</span>'} Let's find where you belong.`, `<button class="button secondary heading-preferences" data-action="${state.user ? 'nav:profile' : 'register'}">${icon('filter')} Search preferences</button>`)}
    ${view === 'overview' ? `<div class="stats-grid">${counts.map(c => `<div class="stat-card"><div class="stat-label"><span>${c.title}</span><span class="stat-icon ${c.color}">${icon(c.symbol)}</span></div><div class="stat-number">${c.value}<span class="stat-trend">${icon('trend')}${c.trend}</span></div><p>${c.note}</p></div>`).join('')}</div>` : ''}
    <div class="dashboard-columns"><div class="main-column">
      ${view === 'overview' ? `<section class="hero-banner"><div class="hero-copy"><span class="hero-eyebrow">${icon('sparkles')} A LITTLE HELP FOR YOUR NEXT BIG THING</span><h2>You bring the ambition.<br>We'll find the opportunities.</h2><p>A daily search. Better matches. More time for what comes next.</p><button class="button dark" data-action="nav:agent">Meet your job agent ${icon('arrow')}</button></div><div class="hero-art" aria-hidden="true"><div class="orbit orbit-one"></div><div class="orbit orbit-two"></div><span class="art-star star-one">&#10022;</span><span class="art-star star-two">&#10022;</span><div class="floating-pill pill-one">${icon('check')} It's a match!</div><div class="art-briefcase"><div class="briefcase-handle"></div><div class="briefcase-body"><div class="briefcase-flap"></div><div class="briefcase-lock"></div><span>&#10022;</span></div></div><div class="floating-pill pill-two">${icon('pin')} Your next chapter</div><span class="art-dot"></span></div></section>` : ''}
      <section class="jobs-section"><div class="section-title"><div><h2>${view === 'overview' ? 'A few steps in the right direction' : 'Find your next opportunity'} <span class="count-pill">${state.hosted && !preview ? state.paging.total : activeJobs().length}</span></h2><p>${preview ? 'Handpicked examples of what your personalized matches could look like.' : 'Public-feed listings, ranked by your role, skills, and location preferences.'}</p></div><button class="text-button" data-action="toggle-data">${preview ? 'Explore live jobs' : !state.user ? 'Sample jobs' : 'Refresh feeds'} ${icon('arrow')}</button></div>
      ${filters()}<div id="job-results">${jobResults()}</div></section>
      <section class="panel settings-panel"><h2>Search beyond connected feeds</h2><p class="muted">External searches for your selected country and role, including Tunisia's Tanitjobs and Keejob. These are not imported listings or universal web coverage. Opening a link shares your search with that site. Paste an advertisement into Interview practice for private CV analysis and preparation.</p><div id="discovery-links" class="discovery-links" aria-live="polite">Loading search links...</div></section>
    </div>${rightRail()}</div>`;
}
function filters() {
  return `<div class="search-bar"><label class="search-field">${icon('search')}<input id="job-search" type="search" placeholder="Job title, company, or keyword" aria-label="Search jobs" value="${esc(query)}"></label><label class="country-field">${icon('globe')}<select id="country-filter" aria-label="Filter by country">${['All countries', ...state.countries].map(c => `<option ${country === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label><button class="filter-button ${source !== 'all' ? 'selected' : ''}" data-action="filters" aria-label="More job filters">${icon('filter')}</button></div><div class="job-tabs"><div role="group" aria-label="Job categories">${[['all', 'All jobs'], ['best', 'Best matches'], ['new', 'Just added'], ['remote', 'Remote']].map(([key, label]) => `<button class="${tab === key ? 'selected' : ''}" data-action="tab:${key}">${key === 'best' ? icon('sparkles') : ''}${label}${key === 'new' ? '<span class="new-dot"></span>' : ''}</button>`).join('')}</div><label class="sort-label">Sort by: <select id="sort-filter" aria-label="Sort jobs"><option value="match" ${sort === 'match' ? 'selected' : ''}>${state.user || preview ? 'Best match' : 'Relevance'}</option><option value="new" ${sort === 'new' ? 'selected' : ''}>Newest</option><option value="company" ${sort === 'company' ? 'selected' : ''}>Company</option></select></label></div>`;
}
function filteredJobs() {
  if (state.hosted && !preview) return state.jobs;
  return activeJobs().filter(j => {
    const text = `${j.title} ${j.company} ${j.tags.join(' ')} ${j.description}`.toLowerCase();
    const countryMatch = country === 'All countries' || (j.eligibleCountries ? j.eligibleCountries.includes(country) : j.country === country || j.country === 'Worldwide');
    return !j.closed && (!j.expiresAt || Date.parse(j.expiresAt) > Date.now()) && text.includes(query.toLowerCase()) && countryMatch && (source === 'all' || j.source === source)
      && (tab !== 'remote' || j.remote) && (tab !== 'best' || (j.score || 0) >= 60) && (tab !== 'new' || Date.now() - Date.parse(j.publishedAt) < 3 * 86400000);
  }).sort((a, b) => sort === 'company' ? a.company.localeCompare(b.company) : sort === 'new' ? Date.parse(b.publishedAt) - Date.parse(a.publishedAt) : (b.score || 0) - (a.score || 0) || Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
}
function jobResults() {
  const list = filteredJobs();
  const hasJobs = state.jobs.length || preview || (state.hosted && state.sync.sources.some(s => s.ok && s.count));
  if (!list.length) return empty('A fresh start for your search', hasJobs ? 'Try another country, a broader keyword, or a different filter.' : 'Your live feeds are ready to connect. Refresh to bring in the latest available listings.', button(hasJobs ? 'Clear filters' : 'Refresh live feeds', hasJobs ? 'clear-filters' : 'refresh', 'button secondary', 'refresh'));
  const hosted = state.hosted && !preview;
  const visible = view === 'overview' ? list.slice(0, 4) : hosted ? list : list.slice(0, 60);
  const more = hosted && state.paging.nextOffset !== null;
  return `<div class="job-grid">${visible.map(jobCard).join('')}</div><div class="results-footer"><span>${preview ? 'Illustrative listings, not real vacancies' : `${hosted ? `${list.length} of ${state.paging.total}` : list.length} listings \u00b7 Source eligibility restrictions may apply`}</span><button class="text-button" data-action="${view === 'overview' ? 'nav:discover' : more ? 'load-more' : 'refresh'}">${view === 'overview' ? 'View all opportunities' : more ? 'Load more opportunities' : 'Refresh available feeds'} ${icon('arrow')}</button></div>${!hosted && list.length > 60 && view !== 'overview' ? '<p class="muted">Showing the first 60 results. Narrow your search to see more relevant jobs.</p>' : ''}`;
}
function jobCard(job) {
  const isSaved = saved().includes(job.id);
  const score = job.score;
  return `<article class="job-card"><div class="job-card-top">${logo(job)}<div class="company-info"><strong>${esc(job.company)}</strong>
    ${job.sourceUrl ? `<a class="source-credit" href="${esc(job.sourceUrl)}" target="_blank" rel="noopener noreferrer">${esc(job.source)} ${icon('external')}</a>` : `<span>${esc(job.source)}</span>`}</div><button class="save-button ${isSaved ? 'is-saved' : ''}" data-action="save:${esc(job.id)}" aria-label="${isSaved ? 'Unsave' : 'Save'} ${esc(job.title)}" aria-pressed="${isSaved}">${icon('bookmark')}</button></div>
    ${job.closed ? '<div class="info-banner">Confirmed closed</div>' : ''}<button class="job-title" data-action="job:${esc(job.id)}">${esc(job.title)}</button><div class="job-location">${icon('pin')}<span>${esc(job.location)}</span><span class="location-dot"></span><span>${job.remote ? 'Remote' : 'On-site'}</span></div><div class="job-tags">${job.tags.slice(0, 3).map(t => `<span>${esc(t)}</span>`).join('')}<span>${esc(job.type)}</span></div><div class="job-salary">${esc(job.salary)}</div><div class="job-card-bottom"><span class="match-badge">${icon('sparkles')}${score !== undefined ? `${score}% match` : 'Explore role'}</span><span class="job-age">${relative(job.publishedAt)}</span><button class="circle-button" data-action="job:${esc(job.id)}" aria-label="View ${esc(job.title)}">${icon('arrow')}</button></div></article>`;
}
function rightRail() {
  const p = profile();
  const complete = state.user ? (state.user.cvName ? 100 : 75) : 75;
  const events = preview ? [
    { message: 'Your Linear application moved to Interview', created_at: ago(.15), symbol: 'chat', color: 'purple' },
    { message: 'You saved a role at Miro', created_at: ago(.3), symbol: 'bookmark', color: 'orange' },
    { message: 'A new chapter with Spotify? Offer received.', created_at: ago(2), symbol: 'briefcase', color: 'green' },
  ] : state.activities.slice(0, 3);
  return `<aside class="right-rail">
    <section class="agent-card"><div class="card-header"><div class="agent-symbol">${icon('sparkles')}</div><span class="live-pill"><i></i>${state.user?.agentEnabled ? 'Agent active' : preview ? 'Meet your agent' : 'Agent paused'}</span></div><h3>Your search,<br>on autopilot.</h3><p>A fresh set of opportunities.<br>A little closer to your next step.</p><div class="agent-details"><span>${icon('globe')} ${esc(p.country)}</span><span>${icon('clock')} Every 24 hours</span></div><div class="agent-next"><span>${preview ? 'Ready when you are' : 'Last successful refresh'}</span><strong>${preview ? 'Set up your daily search' : relative(state.lastSync)}</strong></div><button class="button agent-button" data-action="${state.user ? 'refresh' : 'register'}">${icon(busy ? 'clock' : 'refresh')}${busy ? 'Searching public feeds...' : state.user ? 'Run my agent' : 'Activate my job agent'}${icon('arrow')}</button><button class="agent-settings" data-action="nav:agent">Manage agent ${icon('chevron')}</button></section>
    <section class="panel profile-card"><div class="card-header"><h3>A stronger profile.<br>Better possibilities.</h3><span class="progress-label">${complete}%</span></div><div class="progress-track"><div class="progress-fill ${complete === 100 ? 'complete' : ''}"></div></div><p>${state.user?.cvName ? 'Your profile is ready. Keep your preferences up to date.' : 'Add your CV to keep everything you need for your next application in one place.'}</p><button class="text-button" data-action="${state.user ? 'nav:profile' : 'register'}">${state.user?.cvName ? 'Review your profile' : 'Complete your profile'} ${icon('arrow')}</button></section>
    <section class="panel activity-panel"><div class="card-header"><h3>Little steps, big moves</h3>${icon('clock')}</div><div class="activity-list">${events.length ? events.map((e, i) => `<div class="activity-item"><span class="activity-symbol ${e.color || ['purple', 'green', 'orange'][i % 3]}">${icon(e.symbol || 'briefcase')}</span><div><p>${esc(e.message)}</p><small>${relative(e.created_at)}</small></div></div>`).join('') : '<p class="muted">Your application updates and listing changes will appear here.</p>'}</div><button class="text-button" data-action="notifications">All activity ${icon('arrow')}</button></section>
    <div class="rail-note">${icon('shield')} A personal search. Always your call.<br>No applications sent without you.</div>
  </aside>`;
}
function renderApplications() {
  const apps = applications();
  return `${pageHeading('EVERY STEP COUNTS', 'Your next chapter, in progress<span class="brand-dot">.</span>', 'One place for every application, conversation, and little win.', button('Find a new opportunity', 'nav:discover', 'button primary', 'plus'))}
    <div class="info-banner">${icon('help')} Your tracker is private. Employer updates for in-app applications are shown separately below. External applications are still tracked manually.</div>
    ${(state.recruitment?.applications || []).map(a=>`<section class="panel settings-panel"><h3>${esc([...state.jobs,...(state.ownedJobs || [])].find(j=>j.id===a.jobId)?.title || a.jobId)}</h3><p>Employer stage: <strong>${esc(a.status)}</strong>${a.interviewAt?` · Interview: ${esc(new Date(a.interviewAt).toLocaleString())}`:''}</p><p>Current CV shared: ${a.cvShared?'Yes':'No'}</p>${button('View application & manage consent',`job:${esc(a.jobId)}`,'button secondary')}</section>`).join('')}
    ${!apps.length ? empty('Your story starts with one application', 'Find a role, apply on the original platform, then add it to your tracker.', button('Discover jobs', 'nav:discover', 'button primary', 'search')) : `<div class="pipeline">${['Applied', 'Interview', 'Offer', 'Rejected', 'Withdrawn'].map((status, i) => `<section class="pipeline-column"><div class="pipeline-title"><span class="pipeline-dot stage-${i}"></span><h3>${status}</h3><span>${apps.filter(a => a.status === status).length}</span></div>${apps.filter(a => a.status === status).map(a => { const j = activeJobs().find(j => j.id === a.jobId); return j ? `<button class="application-card" data-action="job:${esc(j.id)}">${logo(j)}<h4>${esc(j.title)}</h4><p>${esc(j.company)}</p><span>${icon('clock')} Updated ${relative(a.updatedAt)}</span>${a.followUp ? `<span class="follow-up">${icon('calendar')} Follow up: ${esc(a.followUp)}</span>` : ''}</button>` : ''; }).join('') || '<div class="pipeline-empty">Room for your next step</div>'}</section>`).join('')}</div>`}`;
}
function renderSaved() {
  const list = activeJobs().filter(j => saved().includes(j.id));
  return `${pageHeading('GOOD THINGS ARE WORTH KEEPING', 'A little possibility, saved<span class="brand-dot">.</span>', 'The roles that caught your eye. Come back when the moment feels right.')}${list.length ? `<div class="saved-grid">${list.map(jobCard).join('')}</div>` : empty('Something good will catch your eye', 'Tap the bookmark on any job to keep it here.', button('Find opportunities', 'nav:discover', 'button primary', 'search'))}`;
}
function profileFields(p) {
  if(p.accountType==='recruiter') return `<div class="form-grid"><label>Full name<input name="name" required minlength="2" maxlength="80" value="${esc(p.name || '')}"></label><label>Professional title<input name="role" required maxlength="120" value="${esc(p.role || 'Recruiter')}"></label><label>Country<select name="country">${state.countries.map(c=>`<option ${c===(p.country || 'Tunisia')?'selected':''}>${esc(c)}</option>`).join('')}</select></label></div><input type="hidden" name="workMode" value="Any"><input type="hidden" name="skills" value=""><p class="muted">Recruiter account. Account type cannot be changed after registration.</p>`;
  return `<div class="form-grid">
    <label>Full name<input name="name" required minlength="2" maxlength="80" value="${esc(p.name || '')}" autocomplete="name"></label>
    <label>Target role<input name="role" required maxlength="120" value="${esc(p.role || '')}" placeholder="e.g. QA Engineer"></label>
    <label>Your country<select name="country" required>${state.countries.map(c => `<option ${c === (p.country || 'Tunisia') ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
    <label>Work arrangement<select name="workMode">${['Any', 'Remote', 'On-site'].map(m => `<option ${m === p.workMode ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
    <label class="full-width">Skills (comma separated)<input name="skills" maxlength="500" value="${esc(p.skills || '')}" placeholder="JavaScript, SQL, Playwright"><small>Preference scores use these keywords. CV evidence is assessed separately.</small></label>
    ${['linkedin','github','gitlab'].map(key => `<label class="full-width">${{ linkedin: 'LinkedIn', github: 'GitHub', gitlab: 'GitLab' }[key]} profile<input type="url" name="${key}" maxlength="300" value="${esc(p[key] || '')}" placeholder="https://${key}.com/${key === 'linkedin' ? 'in/' : ''}your-profile"></label>`).join('')}
    </div><label class="checkbox-label"><input type="checkbox" name="agentEnabled" ${p.agentEnabled !== false ? 'checked' : ''}><span><strong>Keep my search moving</strong><small>Include new matches in an optional daily email digest. Pausing does not suppress confirmed closure alerts for saved or tracked jobs.</small></span></label>`;
}
function renderProfile() {
  const p = profile();
  if(isRecruiter()) return `${pageHeading('YOUR ACCOUNT','Recruiter settings','Manage your personal login details. Your company and vacancies are in Recruitment dashboard.')}<section class="panel settings-panel"><form id="profile-form">${profileFields(p)}<div class="field-error" id="form-error" role="alert"></div><button type="submit" class="button primary">Save account</button></form><p>${esc(p.email)}</p><div class="detail-actions">${button('Sign out','logout','button secondary')}${button('Sign out all devices','logout-all','button secondary')}${button('Delete account','delete-account','text-button danger')}</div></section>`;
  const accountSecurity = state.user ? `<section class="panel settings-panel"><h3>Session security</h3><p class="muted">Using a shared computer, or concerned someone else has access? Sign out every active session, including this one.</p>${button('Sign out all devices', 'logout-all', 'button secondary', 'shield')}</section>` : '';
  return `${pageHeading('A SEARCH THAT FEELS LIKE YOU', 'Your next step starts with you<span class="brand-dot">.</span>', 'A few preferences now. More meaningful opportunities ahead.')}
    ${!state.user ? `<div class="info-banner">${icon('user')} This is a sample profile. Create your account to save your own preferences. ${button('Get started', 'register', 'text-button')}</div>` : ''}${accountSecurity}
    <div class="settings-grid"><section class="panel settings-panel"><div class="section-title"><h2>Make it personal</h2>${icon('user')}</div><form id="profile-form">${profileFields(p)}<div class="form-actions"><span class="muted">${state.user ? esc(state.user.email) : 'Preview account'}</span><button class="button primary" type="submit">Save preferences ${icon('check')}</button></div></form></section>
    <div><section class="panel settings-panel"><h2>Your private CV evidence</h2><p class="muted">PDF or TXT, up to ${state.hosted ? 4 : 5} MB. Selectable text is extracted privately; no external AI or job provider receives your CV. Scanned PDFs need pasted text.</p><label class="upload-zone">${icon('upload')}<strong>${esc(state.user?.cvName || 'Choose your CV')}</strong><input type="file" id="profile-cv" accept=".pdf,.txt,application/pdf,text/plain" aria-label="Upload CV"></label>${state.user?.cvName ? `<div class="cv-actions"><a class="text-button" href="/api/cv">Download CV ${icon('external')}</a>${button('Remove CV', 'remove-cv', 'text-button danger')}</div>` : ''}${button(state.user?.hasCvText ? 'Review CV text' : 'Paste CV text', 'cv-evidence', 'button secondary', 'file')}<p class="muted">Review extraction before relying on coverage scores. Up to 20 PDF pages / 60,000 characters are analyzed.</p></section>
    <section class="panel settings-panel"><h2>Import your LinkedIn export</h2><p class="muted">Upload your own Profile.csv, Skills.csv, PDF or TXT. Review and edit suggestions before saving. No scraping, passwords or cookies.</p><a class="text-button" href="https://www.linkedin.com/help/linkedin/answer/a1339364/downloading-your-account-data" target="_blank" rel="noopener noreferrer">Get your LinkedIn export ${icon('external')}</a><label class="upload-zone">${icon('upload')}<strong>Choose an export file</strong><input type="file" id="linkedin-import" accept=".pdf,.txt,.csv" aria-label="Import LinkedIn export"></label></section>
    ${renderEmail()}${state.user ? `<section class="panel settings-panel account-panel"><h3>Your account</h3>${button('Sign out', 'logout', 'button secondary', 'logout')}${button('Delete account & all personal data', 'delete-account', 'text-button danger delete-account')}</section>` : ''}</div></div>`;
}
function renderEmail() {
  const em = state.email || {};
  return `<section class="panel settings-panel"><h2>A daily email, only if you want</h2><p class="muted">New matches and confirmed closures of saved/tracked jobs. At most one digest per 24 hours, only when something changes. Your first window starts after consent. No Telegram, SMS or WhatsApp.</p>
    ${!state.user ? button('Create your account', 'register', 'button secondary') : !em.configured ? '<div class="info-banner">Email delivery is not configured by the administrator yet. In-app updates still work.</div>' : em.verified ? `<form id="email-preferences-form"><label class="checkbox-label"><input type="checkbox" name="enabled" ${em.enabled ? 'checked' : ''}><span>I consent to daily email alerts. I can disable them here at any time.</span></label><label>Minimum preference match (%)<input type="number" min="40" max="100" name="minScore" value="${em.minScore || 60}" required></label><button type="submit" class="button primary">Save email preferences</button></form>` : `${button('Email me a confirmation code', 'email-link', 'button secondary')}${em.pending ? `<form id="email-confirm-form"><label>Email code<input name="code" pattern="[0-9]{6}" maxlength="6" inputmode="numeric" autocomplete="one-time-code" required></label><label class="checkbox-label"><input type="checkbox" name="consent" required><span>I consent to daily email alerts and can disable them at any time.</span></label><button class="button primary" type="submit">Confirm & enable</button></form>` : ''}`}
    ${em.delivery ? `<p class="muted">Latest attempt: ${esc(em.delivery.status)}. ${esc(em.delivery.error || '')} “Sent” means accepted by SMTP, not guaranteed inbox delivery.</p>` : ''}
    <div class="privacy-note">${icon('shield')} Your email provider receives your email address and generic notifications, not CVs, skills, notes or job details. Open your dashboard for details.</div></section>`;
}
async function updateDiscovery() {
  const request = ++discoveryRequest, target = $('#discovery-links');
  if (!target) return;
  try {
    const result = await api(`discovery?${new URLSearchParams({ country, role: query || state.user?.role || '' })}`);
    if (request === discoveryRequest && target.isConnected) target.innerHTML = result.links.map(link => `<a class="button secondary" href="${esc(link.url)}" target="_blank" rel="noopener noreferrer">${esc(link.name)} ${icon('external')}</a>`).join('');
  } catch (error) { if (target.isConnected) target.textContent = error.message; }
}
function renderEvidence(result) {
  return `<div class="info-banner"><div><strong>CV keyword coverage: ${result.coverage === null ? 'not available' : `${result.coverage}%`}</strong><p>${esc(result.explanation)}</p></div></div>
    ${!result.hasCvText ? '<p>Add or review your CV text in Profile & preferences first.</p>' : ''}
    <p><strong>Evidence found:</strong> ${esc(result.matched.join(', ') || 'No detected keywords found in CV text.')}</p>
    <p><strong>Not found in CV:</strong> ${esc(!result.hasCvText ? 'Add CV text before assessing gaps.' : result.missing.join(', ') || 'No gaps detected in the recognized keywords.')}</p>
    <p class="muted">Recognized listing keywords: ${esc(result.detectedSkills.join(', ') || 'None in the supported dictionary. Review the advertisement manually.')}. Add truthful examples and check qualifications, language, seniority and work authorization yourself.</p>`;
}
function renderInterview() {
  const jobs = [...new Map([...(state.jobs || []), ...(state.ownedJobs || [])].map(j => [j.id,j])).values()];
  if (!jobs.some(j => j.id === quizJobId && !j.closed)) quizJobId = '';
  return `${pageHeading('PRACTICE WITH PURPOSE', 'Interview practice', 'Private French/English QCMs based on the role and recognized topics. These are examples, not predicted employer questions.')}
    ${!state.user ? empty('Practice in your workspace', 'Sign in for private preparation.', button('Sign in', 'login')) : `<section class="panel settings-panel"><form id="quiz-form">
    <label>Job<select name="jobId" id="quiz-job"><option value="">Paste an external listing</option>${jobs.filter(j => !j.closed).map(j => `<option value="${esc(j.id)}" ${quizJobId === j.id ? 'selected' : ''}>${esc(j.title)} - ${esc(j.company)}</option>`).join('')}</select></label>
    <div id="manual-job" ${quizJobId ? 'hidden' : ''}><label>Job title<input name="title" maxlength="120" ${quizJobId ? 'disabled' : 'required'}></label><label>Company<input name="company" maxlength="120" ${quizJobId ? 'disabled' : 'required'}></label><label>Advertisement text<textarea name="description" rows="6" maxlength="18000" ${quizJobId ? 'disabled' : 'required'}></textarea></label></div>
    <div class="form-grid"><label>Language<select name="language"><option value="fr">French</option><option value="en">English</option></select></label><label>Interview topic<select name="family">${['auto','developer','qa','hr','finance','sales','design','operations','general'].map(f=>`<option value="${f}">${f==='auto'?'Detect from job title':f.toUpperCase()}</option>`).join('')}</select></label></div>
    <div class="field-error" id="form-error" role="alert"></div><div class="detail-actions"><button type="submit" class="button primary">Prepare QCM</button>${button('Analyze CV gaps', 'analyze-external', 'button secondary')}</div></form><div id="external-analysis" aria-live="polite"></div></section><section id="quiz-result" aria-live="polite"></section>`}`;
}
function renderAgent() {
  return `${pageHeading('LET POSSIBILITY COME TO YOU', 'A little momentum. Every day<span class="brand-dot">.</span>', 'A scheduled search that brings available public listings into one calm place.', `<button class="button primary" data-action="refresh" ${busy ? 'disabled' : ''}>${icon('refresh')}${busy ? 'Refreshing...' : 'Refresh live feeds'}</button>`)}
    <div class="settings-grid"><section class="panel settings-panel"><h2>Your daily search</h2><p class="muted">Country defaults to Tunisia for new accounts. Change it in your profile or explore any country with the search filter. Scores are transparent keyword heuristics, not hiring predictions.</p><div class="info-banner">${icon('clock')}${state.hosted ? 'Catalog refresh: daily at 06:00 UTC. Email checks: hourly at :15 UTC.' : 'The agent runs while this Node server is online.'} One digest window per 24 hours after consent, subject to quotas and delivery retries. A paused agent suppresses new-match emails, not saved/tracked closure alerts.</div>${button('Edit search & email preferences', state.user ? 'nav:profile' : 'register', 'button primary', 'settings')}<h3>Listing availability</h3><p class="muted">Himalayas expiry dates and explicit closure responses are honored. Availability checks are bounded, so not every listing is rechecked every hour. Missing results, 404s and connection failures never prove closure. Employer replies and interview decisions remain manually tracked.</p></section>
    <section class="panel settings-panel"><h2>Connected public sources</h2><p class="muted">Limited recent pages, not every job platform or every vacancy worldwide.</p>${['Arbeitnow','Arbeitnow UK','Jobicy','Himalayas','Himalayas Tunisia'].map(name => { const s = state.sync.sources.find(s => s.name === name); return `<div class="source-row"><span class="source-logo">${name[0]}</span><div><strong>${esc(name)}</strong><small>${name.startsWith('Himalayas') ? 'Worldwide remote jobs, with country/timezone eligibility' : name === 'Jobicy' ? 'Geographically restricted remote roles' : name === 'Arbeitnow UK' ? 'United Kingdom' : 'Germany & European employers'}</small></div><span class="source-status ${s?.ok ? 'ok' : s ? 'failed' : ''}">${s?.ok ? `${s.count} jobs` : s ? 'Unavailable' : 'Ready'}</span></div>${s && !s.ok ? `<p class="field-error">${esc(s.error)}</p>` : ''}`; }).join('')}<p class="muted">Last successful sync: ${state.lastSync ? new Date(state.lastSync).toLocaleString() : 'Not yet run'}. Tanitjobs/Keejob/Google searches are external links in Discover jobs, not automatically imported feeds.</p></section></div>`;
}
function renderRecruitment() {
  if(!isRecruiter()) return empty('Recruiter workspace','Use a separate recruiter account to manage vacancies.');
  const workspace=state.recruitment, company=workspace.company || {}, post=editingPosting || {country:'Tunisia',status:'draft',type:'Full-time'};
  const applicants=workspace.applicants.filter(a=>applicantStage==='all' || a.status===applicantStage);
  return `${pageHeading('BUILD YOUR NEXT TEAM','Recruitment dashboard','Publish vacancies, manage consenting applicants and prepare interviews.',`<div class="detail-actions">${button('Reload workspace','reload-hiring','button secondary')}${button('New vacancy','new-posting','button primary')}</div>`)}
    <div class="settings-grid"><section class="panel settings-panel"><h2>Company profile</h2><form id="company-form"><label>Company name<input name="name" required minlength="2" maxlength="120" value="${esc(company.name || '')}"></label><label>Website (HTTPS)<input name="website" type="url" maxlength="300" value="${esc(company.website || '')}"></label><label>About the company<textarea name="description" rows="4" maxlength="3000">${esc(company.description || '')}</textarea></label><div class="field-error" id="form-error" role="alert"></div><button type="submit" class="button primary">Save company</button></form></section>
    <section class="panel settings-panel" id="posting-editor"><h2>${editingPosting?'Edit vacancy':'Create vacancy'}</h2><form id="posting-form"><input type="hidden" name="id" value="${esc(post.id || '')}"><label>Job title<input name="title" required minlength="2" maxlength="120" value="${esc(post.title || '')}"></label><div class="form-grid"><label>Country<select name="country">${state.countries.map(c=>`<option ${c===post.country?'selected':''}>${esc(c)}</option>`).join('')}</select></label><label>Location<input name="location" maxlength="150" value="${esc(post.location || '')}"></label><label>Contract type<input name="type" maxlength="60" value="${esc(post.type)}"></label><label>Salary<input name="salary" maxlength="150" value="${esc(post.salary || '')}"></label></div><label>Skills (comma separated)<input name="skills" maxlength="500" value="${esc(post.skills || '')}"></label><label>Description<textarea name="description" required minlength="80" maxlength="18000" rows="7">${esc(post.description || '')}</textarea></label><label class="checkbox-label"><input type="checkbox" name="remote" ${post.remote?'checked':''}>Remote (eligibility remains the selected country)</label><label>Posting status<select name="status">${['draft','open','closed'].map(s=>`<option ${s===post.status?'selected':''}>${s}</option>`).join('')}</select></label><p class="muted">Only open vacancies appear in public results. The company name is copied when saving a vacancy.</p><div class="field-error" id="form-error" role="alert"></div><button type="submit" class="button primary">Save vacancy</button></form></section></div>
    <section class="panel settings-panel"><h2>Your vacancies (${workspace.postings.length})</h2>${workspace.postings.map(p=>`<div class="source-row"><div><strong>${esc(p.title)}</strong><small>${esc(p.country)} · ${esc(p.status)} · ${workspace.applicants.filter(a=>a.jobId===p.id).length} applications</small></div>${button('Edit / publish / close',`edit-posting:${esc(p.id)}`,'button secondary')}</div>`).join('') || '<p>No vacancies yet. Save your company first.</p>'}</section>
    <section class="panel settings-panel"><h2>Applicant pipeline</h2><label>Stage<select id="applicant-stage">${['all','Applied','Shortlisted','Interview','Offer','Rejected','Withdrawn'].map(s=>`<option ${s===applicantStage?'selected':''}>${s}</option>`).join('')}</select></label><p class="muted">Only people who applied to your vacancies are visible. Notes are private to your recruiter account. Interview times below are entered in UTC and shown in local time to candidates. QCM practice scores are never shared.</p>
    ${applicants.map(a=>`<article class="applicant-card"><h3>${esc(a.name)} — ${esc(workspace.postings.find(p=>p.id===a.jobId)?.title || a.jobId)}</h3><p>${esc(a.email)} · ${esc(a.status)} · ${esc(new Date(a.createdAt).toLocaleString())}</p><p class="job-description">${esc(a.message || 'No message provided.')}</p>${a.cvAvailable?`<a class="button secondary" href="/api/recruitment/cv/${encodeURIComponent(a.id)}">Download shared CV</a>`:'<p class="muted">No current CV access: not shared, replaced, removed or withdrawn.</p>'}
    ${a.status==='Withdrawn'?'<p>Candidate withdrew. Further review is disabled.</p>':`<form class="review-form" data-id="${esc(a.id)}"><div class="form-grid"><label>Stage<select name="status">${['Applied','Shortlisted','Interview','Offer','Rejected'].map(s=>`<option ${s===a.status?'selected':''}>${s}</option>`).join('')}</select></label><label>Interview date/time (UTC)<input type="datetime-local" name="interviewAt" value="${a.interviewAt?esc(new Date(a.interviewAt).toISOString().slice(0,16)):''}"></label></div><label>Recruiter-private notes<textarea name="notes" rows="3" maxlength="5000">${esc(a.notes)}</textarea></label><div class="field-error" id="form-error" role="alert"></div><button type="submit" class="button secondary">Save applicant update</button></form>`}</article>`).join('') || '<p>No applicants in this stage yet.</p>'}</section>`;
}

function openModal(html, cls = '') {
  modalTrigger = document.activeElement;
  $('#overlay').innerHTML = `<div class="modal-backdrop"><section class="modal ${cls}" role="dialog" aria-modal="true" aria-label="Nextstep dialog" tabindex="-1"><button class="icon-button modal-close" data-action="close" aria-label="Close dialog">${icon('close')}</button>${html}</section></div>`;
  document.body.classList.add('modal-open');
  setTimeout(() => ($('input:not([type=file]),select,button:not(.modal-close)', $('#overlay')) || $('.modal')).focus(), 0);
}
function closeModal() {
  $('#overlay').innerHTML = '';
  document.body.classList.remove('modal-open');
  if (modalTrigger?.isConnected) modalTrigger.focus();
}
function auth(mode = 'register', step = 1) {
  authMode = mode;
  authStep = step;
  const login = mode === 'login';
  openModal(`<div class="modal-brand"><img src="/favicon.svg" width="38" height="38" alt="">nextstep.</div><div class="eyebrow">${login ? 'YOUR NEXT CHAPTER IS WAITING' : `LET'S MAKE THIS YOURS \u00b7 STEP ${step} OF 2`}</div><h2>${login ? 'Good to have you back.' : step === 1 ? 'Big possibilities.<br>One small first step.' : 'What does your next step look like?'}</h2><p class="muted">${login ? 'Sign in to pick up where you left off.' : step === 1 ? 'Create your personal workspace. Less searching, more possibility.' : 'Set your preferences. You can change them whenever life changes.'}</p><form id="auth-form"><div id="form-error" class="field-error" role="alert"></div>${step === 1 ? `<label>Email address<input name="email" type="email" required autocomplete="email" placeholder="you@example.com" value="${esc(authDraft.email || '')}"></label><label>Password<input name="password" type="password" required minlength="10" maxlength="128" autocomplete="${login ? 'current-password' : 'new-password'}" placeholder="At least 10 characters" value="${esc(authDraft.password || '')}"></label>` : `${profileFields(authDraft)}${state.hosted ? '<p class="muted">Confirm your email first, then upload your private PDF/TXT CV (up to 4 MB) in Profile & preferences.</p>' : `<label class="compact-upload">${icon('upload')}<span>Add your CV <small>(optional, PDF / TXT, max. 5 MB)</small></span><input name="cv" type="file" accept=".pdf,.txt,application/pdf,text/plain"></label>`}`}<button class="button primary full-button" type="submit">${login ? 'Sign in' : step === 1 ? 'Build my workspace' : 'Find my next step'} ${icon('arrow')}</button></form>${state.hosted && login ? `<div class="auth-switch">${button('Forgot password?', 'recover', 'text-button')} ${button('Resend confirmation', 'resend-confirmation', 'text-button')}</div>` : ''}<div class="auth-switch">${login ? 'New here?' : step === 1 ? 'Already have a workspace?' : 'Need to change your email?'} <button class="text-button" data-action="${login ? 'register' : step === 1 ? 'login' : 'auth-back'}">${login ? 'Create an account' : step === 1 ? 'Sign in' : 'Go back'}</button></div><div class="privacy-note">${icon('shield')} Your CV stays private. Your next move stays yours.</div>`, 'auth-modal');
  if(!login && step===1) $('#auth-form').insertAdjacentHTML('afterbegin','<label>Account type<select name="accountType" required><option value="jobseeker">I am looking for a job</option><option value="recruiter">I am recruiting / posting jobs</option></select><small>Choose once. Job seekers and recruiters use separate accounts.</small></label>');
  if(!login && step===2 && authDraft.accountType==='recruiter') $('.compact-upload')?.remove();
}
function emailForm(kind) {
  const email = $('#auth-form input[name=email]')?.value || $('#login-form input[name=email]')?.value || '';
  openModal(`<h2>${kind === 'recover' ? 'A fresh start for your password.' : 'Confirm your next step.'}</h2><p class="muted">Enter your email address. If it is eligible, we will send a ${kind === 'recover' ? 'recovery' : 'confirmation'} link.</p><form id="auth-email-form" data-kind="${kind}"><label>Email address<input type="email" name="email" autocomplete="email" value="${esc(email)}" required></label><div class="field-error" id="form-error" role="alert"></div><button class="button primary" type="submit">Send email</button></form>`);
}
function recoveryForm() {
  openModal(`<h2>Choose a new password.</h2><p class="muted">Resetting ${esc(state.recoveryEmail)}. This recovery session expires after 10 minutes and cannot access a workspace.</p><form id="password-recovery-form"><label>New password<input type="password" name="password" autocomplete="new-password" minlength="10" maxlength="128" required></label><div class="field-error" id="form-error" role="alert"></div><button class="button primary" type="submit">Update password & sign out all devices</button></form>`);
}
async function jobDetail(id) {
  let job = [...activeJobs(), ...(state.ownedJobs || [])].find(j => j.id === id);
  if (!preview) {
    job = (await api(`jobs/${encodeURIComponent(id)}`)).job;
  }
  if (!job) return;
  const app = applications().find(a => a.jobId === id);
  openModal(`<div class="detail-heading">${logo(job)}<span class="match-badge">${icon('sparkles')}${job.score !== undefined ? `${job.score}% preference match` : esc(job.source)}</span></div><h2>${esc(job.title)}</h2><p class="detail-company">${esc(job.company)} <span>\u00b7 ${esc(job.location)}</span></p><div class="job-tags"><span>${job.remote ? 'Remote' : 'On-site'}</span><span>${esc(job.type)}</span>${job.tags.map(t => `<span>${esc(t)}</span>`).join('')}</div><div class="detail-salary">${esc(job.salary)}</div>${preview ? '<div class="info-banner">This is an illustrative listing, not a real vacancy.</div>' : `<div class="detail-actions"><a class="button primary" href="${esc(job.url)}" target="_blank" rel="noopener noreferrer">View & apply on ${esc(job.source)} ${icon('external')}</a><button class="button secondary" data-action="save:${esc(id)}">${icon('bookmark')}${saved().includes(id) ? 'Saved' : 'Save job'}</button></div>`}${job.matchedSkills?.length ? `<p class="matching-skills">${icon('sparkles')} Matching skills: ${esc(job.matchedSkills.join(', '))}</p>` : ''}<h3>About this opportunity</h3><p class="job-description">${esc(job.description)}</p><p class="muted">Posted ${new Date(job.publishedAt).toLocaleDateString()} \u00b7 Source: ${esc(job.source)}. Availability and country eligibility must be verified with the provider. Absence from a refresh does not confirm closure.</p><hr><h3>${app ? 'Your application' : 'Make your next move'}</h3><p class="muted">Apply on the source website first, then track your progress here.</p><form id="application-form" data-id="${esc(id)}"><div class="form-grid"><label>Application status<select name="status">${['Applied', 'Interview', 'Offer', 'Rejected', 'Withdrawn'].map(s => `<option ${s === app?.status ? 'selected' : ''}>${s}</option>`).join('')}</select></label><label>Follow-up date<input type="date" name="followUp" value="${esc(app?.followUp || '')}"></label><label class="full-width">Private notes<textarea name="notes" rows="3" maxlength="5000" placeholder="Contacts, interview details, or a reminder for future you...">${esc(app?.notes || '')}</textarea></label></div><div class="field-error" id="form-error" role="alert"></div><button class="button primary" type="submit">${icon('check')}${app ? 'Save update' : 'Add to my applications'}</button></form>`, 'detail-modal');
  if (!preview) {
    const actions = $('.detail-actions', $('.detail-modal'));
    if(job.source==='Nextstep') {
      $('a',actions)?.remove();
      const submission=state.recruitment?.applications?.find(a=>a.jobId===id);
      const form=$('#application-form');
      form.previousElementSibling.textContent='Your tracker below is private. In-app employer updates and CV sharing are separate.';
      form.insertAdjacentHTML('beforebegin',submission?`<section class="panel settings-panel"><h3>In-app application: ${esc(submission.status)}</h3>${submission.interviewAt?`<p>Interview: ${esc(new Date(submission.interviewAt).toLocaleString())}</p>`:''}${submission.status!=='Withdrawn'?`<form id="consent-form" data-id="${esc(id)}"><label class="checkbox-label"><input name="shareCv" type="checkbox" ${submission.cvShared?'checked':''} ${!state.user?.cvName?'disabled':''}>Share my current CV</label><label class="checkbox-label"><input name="consent" type="checkbox">I explicitly agree to share this current CV with this employer if enabled above.</label><div class="field-error" id="form-error" role="alert"></div><button type="submit" class="button secondary">Update CV sharing</button> ${button('Withdraw application',`withdraw:${esc(id)}`,'text-button danger')}</form><p class="muted">Replacing/removing your CV revokes access to the old version. Previously downloaded files cannot be recalled; hosted download links expire within 60 seconds.</p>`:'<p>Your application is withdrawn; CV access is revoked.</p>'}</section>`:!job.closed?`<section class="panel settings-panel"><h3>Apply directly in Nextstep</h3>${!state.user?'<p>Sign in as a job seeker to apply.</p>':''}<form id="native-apply-form" data-id="${esc(id)}"><label>Message to employer (optional)<textarea name="message" rows="3" maxlength="2000"></textarea></label><label class="checkbox-label"><input name="shareCv" type="checkbox" ${!state.user?.cvName?'disabled':''}>Optionally share my current CV with this employer</label><label class="checkbox-label"><input name="consent" type="checkbox" required>I agree to share my name, email and this message with the employer for this application.</label><div class="field-error" id="form-error" role="alert"></div><button type="submit" class="button primary">Submit application</button></form></section>`:'');
    }
    if (job.closed) actions.innerHTML = '<strong>This listing is confirmed closed. Application history is retained.</strong>';
    else if (job.availabilityUnknown) actions.insertAdjacentHTML('beforebegin', '<div class="info-banner">The provider could not confirm availability (not proof of closure). Verify on the original site.</div>');
    actions.insertAdjacentHTML('afterend', `<div class="detail-actions">${button('Analyze CV gaps', `analyze-job:${esc(id)}`, 'button secondary')}${button('Practice interview QCM', `quiz-job:${esc(id)}`, 'button secondary')}</div><div id="job-analysis" aria-live="polite"></div>${job.sourceUrl ? `<a class="text-button" href="${esc(job.sourceUrl)}" target="_blank" rel="noopener noreferrer">Source: ${esc(job.source)} ${icon('external')}</a>` : ''}`);
  }
}
function notifications() {
  const due = state.applications.filter(a => a.followUp && a.followUp <= new Date().toLocaleDateString('en-CA') && !['Rejected', 'Withdrawn', 'Offer'].includes(a.status));
  openModal(`<div class="modal-symbol">${icon('bell')}</div><h2>Your little steps, all together.</h2><p class="muted">Application updates, listing changes, and follow-up reminders.</p>${preview ? '<div class="info-banner">Your preview uses sample activity. Create an account to track real updates.</div>' : ''}${due.map(a => { const j = state.jobs.find(j => j.id === a.jobId); return `<button class="reminder-row" data-action="job:${esc(a.jobId)}">${icon('calendar')} Follow up: ${esc(j?.company || 'Application')} \u00b7 ${esc(a.followUp)} ${icon('arrow')}</button>`; }).join('')}${state.activities.length ? `<div class="activity-list">${state.activities.map(e => `<div class="activity-item"><span class="activity-symbol purple">${icon('briefcase')}</span><div><p>${esc(e.message)}</p><small>${new Date(e.created_at).toLocaleString()}</small></div></div>`).join('')}</div>` : empty('A little quiet. A lot of possibility.', 'Your real activity will appear here as you save jobs and track applications.')}`);
}
async function refreshFeeds() {
  if (busy) return;
  if (state.hosted && !requireAccount()) return;
  busy = true;
  render();
  try {
    const result = await api('refresh', 'POST');
    await load();
    preview = false;
    const failed = result.sources.filter(s => !s.ok);
    toast(failed.length ? `Refreshed with ${failed.length} source unavailable. See My job agent for details.` : result.cached ? result.message : `${result.added} new listings, ${result.updated} changed. Your live search is ready.`, failed.length > 0);
  } catch (e) { toast(e.message, true); await load().catch(e => toast(e.message, true)); }
  finally { busy = false; render(); }
}
async function upload(file) {
  const maximum = state.hosted ? state.cvMaxBytes : 5 * 1024 * 1024;
  if (!file || file.size === 0 || file.size > maximum) throw new Error(`Choose a PDF or TXT CV up to ${maximum / 1024 / 1024} MB.`);
  const type = file.name.toLowerCase().endsWith('.txt') ? 'text/plain' : file.type;
  if (!['application/pdf', 'text/plain'].includes(type)) throw new Error('Please use a PDF or TXT CV.');
  const content = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('Could not read the file. Please try again.'));
    reader.readAsDataURL(file);
  });
  const result = await api('cv', 'POST', { name: file.name, type, content });
  return result;
}
async function updateResults() {
  try {
    await fetchHostedJobs();
    if ($('#job-results')) $('#job-results').innerHTML = jobResults();
    if (state.hosted && !preview && $('.jobs-section .count-pill')) $('.jobs-section .count-pill').textContent = state.paging.total;
    await updateDiscovery();
  } catch (e) { toast(e.message, true); }
}
function requireAccount() {
  if (state.user && !preview) return true;
  authDraft = {};
  auth();
  return false;
}
document.addEventListener('click', async event => {
  const control = event.target.closest('[data-action]');
  if (!control) {
    if (event.target.classList.contains('modal-backdrop')) closeModal();
    return;
  }
  event.preventDefault();
  const [action, ...rest] = control.dataset.action.split(':');
  const arg = rest.join(':');
  try {
    if (action === 'nav') { jobsRequest++; view = arg; query = ''; tab = 'all'; source = 'all'; closeModal(); render(); window.scrollTo({ top: 0 }); if (['overview', 'discover'].includes(view)) await updateResults(); }
    if (action === 'register' || action === 'login') { authDraft = {}; auth(action); }
    if(action==='browse-public') { guestBrowsing=true; preview=false; view='discover'; closeModal(); await fetchHostedJobs(); render(); }
    if(action==='new-posting') { editingPosting=null; render(); $('#posting-editor').scrollIntoView(); }
    if(action==='reload-hiring') { await load(); render(); toast('Recruitment workspace reloaded.'); }
    if(action==='edit-posting') { editingPosting=state.recruitment.postings.find(p=>p.id===arg); render(); $('#posting-editor').scrollIntoView(); }
    if(action==='withdraw') openModal(`<h2>Withdraw this application?</h2><p>This cannot be undone. The employer will no longer be able to download your CV through this application.</p>${button('Confirm withdrawal',`withdraw-confirm:${esc(arg)}`,'button destructive')}`);
    if(action==='withdraw-confirm' && requireAccount()) { await api('recruitment/consent','POST',{jobId:arg,shareCv:false,withdraw:true}); await load(); closeModal(); render(); toast('Application withdrawn and CV access revoked.'); }
    if (action === 'recover' || action === 'resend-confirmation') emailForm(action);
    if (action === 'auth-back') auth('register', 1);
    if (action === 'close') closeModal();
    if (action === 'menu') $('.sidebar').classList.toggle('open');
    if (action === 'notifications') notifications();
    if (action === 'job') await jobDetail(arg);
    if (action === 'tab') {
      if (arg === 'best' && !state.user && !preview) { toast('Create a profile to get preference-based matches.'); return; }
      tab = arg; render(); await updateResults();
    }
    if (action === 'clear-filters') { query = ''; country = 'All countries'; source = 'all'; tab = 'all'; render(); await updateResults(); }
    if (action === 'load-more') { control.disabled = true; await fetchHostedJobs(true); if ($('#job-results')) $('#job-results').innerHTML = jobResults(); }
    if (action === 'toggle-data') {
      if (state.user) return await refreshFeeds();
      await updateResults();
    }
    if (action === 'refresh') await refreshFeeds();
    if (action === 'save' && requireAccount()) {
      control.disabled = true;
      const result = await api('saved', 'POST', { jobId: arg });
      await load(); render();
      if ($('.detail-modal')) await jobDetail(arg);
      toast(result.saved ? 'A little possibility, saved.' : 'Removed from your saved jobs.');
    }
    if (action === 'logout' || action === 'logout-all') { await api(action, 'POST'); await load(); preview = false; guestBrowsing=false; editingPosting=null; currentQuiz=null; country = 'Tunisia'; view = 'overview'; render(); toast(action === 'logout-all' ? 'All sessions have been signed out.' : 'Signed out. Your progress is saved.'); }
    if (action === 'remove-cv') { await api('cv', 'DELETE'); await load(); render(); toast('CV removed.'); }
    if (action === 'email-link' && requireAccount()) {
      control.disabled = true;
      await api('email/link', 'POST');
      await load(); render(); toast('Check your email for a six-digit confirmation code.');
    }
    if (action === 'cv-evidence' && requireAccount()) {
      const result = await api('profile/evidence');
      openModal(`<h2>Review your private CV text</h2><p class="muted">Correct extraction or paste selectable text. Only this text powers CV keyword coverage. It is not sent to external AI.</p><form id="evidence-form"><label>CV text<textarea name="text" rows="16" maxlength="60000">${esc(result.text)}</textarea></label><div class="field-error" id="form-error" role="alert"></div><button type="submit" class="button primary">Save CV evidence</button></form>`);
    }
    if (action === 'analyze-job' && requireAccount()) {
      control.disabled = true;
      const result = await api('career/analyze', 'POST', { jobId: arg });
      if ($('#job-analysis')) $('#job-analysis').innerHTML = renderEvidence(result);
      control.disabled = false;
    }
    if (action === 'quiz-job' && requireAccount()) { quizJobId = arg; currentQuiz=null; view = 'interview'; closeModal(); render(); }
    if (action === 'analyze-external' && requireAccount()) {
      const form = $('#quiz-form');
      if (!form.reportValidity()) return;
      control.disabled = true;
      const result = await api('career/analyze', 'POST', Object.fromEntries(new FormData(form)));
      $('#external-analysis').innerHTML = renderEvidence(result);
      control.disabled = false;
    }
    if (action === 'delete-account') openModal(`<h2>Ready to leave this chapter?</h2><p class="muted">This permanently deletes your account, CV and extracted text, email preferences, notes, saved jobs and application history. This cannot be undone.</p><form id="delete-account-form"><label>Confirm your current password<input type="password" name="password" autocomplete="current-password" maxlength="128" required></label><div class="field-error" id="form-error" role="alert"></div><div class="detail-actions">${button('Keep my workspace', 'close', 'button secondary')}<button class="button destructive" type="submit">Permanently delete account</button></div></form>`);
    if (action === 'filters') openModal(`<div class="modal-symbol">${icon('filter')}</div><h2>A little more focus.</h2><p class="muted">Choose a connected source.</p><form id="filter-form"><label>Job source<select name="source">${['all', ...(state.hosted && !preview ? state.sourceNames : new Set(activeJobs().map(j => j.source)))].map(s => `<option value="${esc(s)}" ${source === s ? 'selected' : ''}>${s === 'all' ? 'All connected sources' : esc(s)}</option>`).join('')}</select></label><button class="button primary" type="submit">Apply filter ${icon('check')}</button></form>`);
    if (action === 'help') openModal(`<h2>Small steps. Real possibilities.</h2><div class="help-steps"><h3>1. Choose your account</h3><p>Job seekers and recruiters register separately. Choose your country (Tunisia by default). Candidates can upload a private CV and review its extracted text or import their own LinkedIn export. Nothing is scraped.</p><h3>2. Explore or recruit</h3><p>Public feeds and Nextstep vacancies appear inside the list. Google, Tanitjobs and Keejob searches are external. Recruiters manage their company, draft/open/closed jobs and consenting applicants in Recruitment dashboard.</p><h3>3. Prepare and apply</h3><p>Analyze CV coverage and practice French/English role-specific QCMs with explanations. Results remain private in your browser. Apply directly to Nextstep jobs with explicit data-sharing consent; apply on the source site for external jobs. Your personal tracker is separate from employer stages.</p><h3>4. Stay updated</h3><p>Opt into daily email once SMTP is configured. In-app employer stages and interview dates are available in My applications. Revoke CV access or withdraw there. No inbox reading, automatic applying, external AI or hiring predictions.</p></div>${button('Find my next step', state.user ? 'nav:discover' : 'register', 'button primary', 'arrow')}`);
  } catch (e) { toast(e.message, true); control.disabled = false; }
});
document.addEventListener('input', event => {
  if (event.target.id === 'job-search') {
    query = event.target.value;
    clearTimeout(searchTimer);
    if (state.hosted && !preview) searchTimer = setTimeout(updateResults, 300);
    else updateResults();
  }
});
document.addEventListener('change', async event => {
  if (event.target.id === 'country-filter') { country = event.target.value; updateResults(); }
  if (event.target.id === 'sort-filter') { sort = event.target.value; updateResults(); }
  if (event.target.id === 'profile-cv') {
    if (!requireAccount()) return;
    try { const result = await upload(event.target.files[0]); await load(); render(); toast(result.warning || 'Your CV is safely in your workspace. Review its extracted text.', Boolean(result.warning)); }
    catch (e) { toast(e.message, true); }
  }
  if(event.target.id==='applicant-stage') { applicantStage=event.target.value; render(); }
  if (event.target.id === 'quiz-job') {
    quizJobId = event.target.value;
    currentQuiz=null; $('#quiz-result').innerHTML='';
    $('#manual-job').hidden = Boolean(quizJobId);
    for (const field of $('#manual-job').querySelectorAll('input,textarea')) { field.disabled = Boolean(quizJobId); field.required = !quizJobId; }
  }
  if (event.target.id === 'linkedin-import') {
    if (!requireAccount()) return;
    const file = event.target.files[0];
    if (!file) return;
    try {
      const max = (state.hosted ? 4 : 5) * 1024 * 1024;
      if (!file.size || file.size > max) throw new Error(`Choose a file up to ${max / 1024 / 1024} MB.`);
      const extension = file.name.split('.').at(-1).toLowerCase();
      const type = { pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv' }[extension];
      if (!type) throw new Error('Choose a PDF, TXT or CSV export.');
      event.target.disabled = true;
      const content = await new Promise((resolve,reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('The export could not be read.')); reader.readAsDataURL(file); });
      const result = await api('profile/import', 'POST', { type, content });
      if (!Object.keys(result.proposal).length) throw new Error('No supported profile fields were recognized. Update your profile manually or try Profile.csv / Skills.csv.');
      openModal(`<h2>Review LinkedIn suggestions</h2><p class="muted">${esc(result.notice)} Country mentions may describe past experience; confirm your current search country.</p><form id="import-profile-form">${profileFields({ ...state.user, ...result.proposal })}<div class="field-error" id="form-error" role="alert"></div><button type="submit" class="button primary">Confirm & save reviewed profile</button></form>`);
    } catch (error) { toast(error.message, true); }
    finally { event.target.disabled = false; event.target.value = ''; }
  }
});
document.addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.target;
  const formId = form.getAttribute('id');
  const data = Object.fromEntries(new FormData(form));
  const submit = $('button[type=submit]', form);
  const errorEl = $('#form-error', form);
  if (errorEl) errorEl.textContent = '';
  try {
    if (formId === 'auth-form' || formId==='login-form') {
      if(formId==='login-form') { authMode='login'; authStep=1; authDraft={}; }
      if (authMode === 'register' && authStep === 1) {
        authDraft = { ...data, country: 'Tunisia', workMode: 'Any', agentEnabled: true };
        auth('register', 2);
        return;
      }
      submit.disabled = true;
      const file = data.cv;
      const payload = { ...authDraft, ...data, agentEnabled: data.agentEnabled === 'on' };
      delete payload.cv;
      const result = await api(authMode === 'login' ? 'login' : 'register', 'POST', payload);
      authDraft = {};
      if (result.confirmationRequired) {
        openModal(`<h2>Your next step is in your inbox.</h2><p class="muted">${esc(result.message)}</p>${button('Sign in after confirming', 'login', 'button primary')}${button('Resend confirmation email', 'resend-confirmation', 'text-button')}`);
        return;
      }
      let uploadError;
      if (authMode === 'register' && file?.size) {
        try { uploadError = (await upload(file)).warning; } catch (e) { uploadError = e.message; }
      }
      await load(); preview = false; guestBrowsing=false; country = state.user.country; await fetchHostedJobs(); closeModal(); view = isRecruiter()?'hiring':'overview'; render();
      toast(uploadError ? `Your account is ready. CV needs attention: ${uploadError}` : 'Your next chapter starts here. Welcome to your workspace.', Boolean(uploadError));
    }
    if (['profile-form','import-profile-form'].includes(formId)) {
      if (!requireAccount()) return;
      submit.disabled = true;
      await api('profile', 'PUT', { ...data, agentEnabled: data.agentEnabled === 'on' });
      country = data.country;
      await load(); closeModal(); render(); toast('Preferences saved. Your matches have a fresh perspective.');
    }
    if (formId === 'application-form') {
      if (!requireAccount()) return;
      submit.disabled = true;
      await api('application', 'PUT', { ...data, jobId: form.dataset.id });
      await load(); closeModal(); render(); toast('A little progress, all saved.');
    }
    if (formId === 'filter-form') { source = data.source; closeModal(); render(); await updateResults(); }
    if (formId === 'auth-email-form') {
      submit.disabled = true;
      const result = await api(form.dataset.kind === 'recover' ? 'password-reset' : 'resend-confirmation', 'POST', data);
      closeModal(); toast(result.message);
    }
    if (formId === 'password-recovery-form') {
      submit.disabled = true;
      await api('password-reset/complete', 'POST', data);
      await load(); preview = true; country = 'All countries'; view = 'overview'; render(); auth('login');
      toast('Password updated. All sessions were signed out. Sign in with your new password.');
    }
    if (formId === 'email-confirm-form') {
      if (!requireAccount()) return;
      submit.disabled = true;
      await api('email/confirm', 'POST', { code: data.code, consent: data.consent === 'on' });
      await load(); render(); toast('Email verified. Your daily alerts are enabled.');
    }
    if (formId === 'email-preferences-form') {
      if (!requireAccount()) return;
      submit.disabled = true;
      await api('email/preferences', 'PUT', { enabled: data.enabled === 'on', minScore: Number(data.minScore) });
      await load(); render(); toast('Alert preferences saved. The next daily window starts now.');
    }
    if (formId === 'evidence-form' && requireAccount()) {
      submit.disabled = true;
      await api('profile/evidence', 'PUT', { text: data.text }); await load(); closeModal(); render(); toast('Private CV evidence saved.');
    }
    if (formId === 'quiz-form' && requireAccount()) {
      submit.disabled = true;
      currentQuiz = await api('career/quiz', 'POST', data);
      $('#quiz-result').innerHTML=`<section class="panel settings-panel"><h2>${esc(currentQuiz.family.toUpperCase())} · ${esc(currentQuiz.language.toUpperCase())}</h2><p>${esc(currentQuiz.notice)}</p><form id="quiz-answers">${currentQuiz.questions.map((q,i)=>`<fieldset class="quiz-question"><legend>${i+1}. ${esc(q.question)}</legend>${q.options.map((o,index)=>`<label class="checkbox-label"><input type="radio" name="${esc(q.id)}" value="${index}" required>${esc(o)}</label>`).join('')}</fieldset>`).join('')}<button type="submit" class="button primary">Check my answers</button></form><div id="quiz-feedback" aria-live="polite"></div></section>`;
      submit.disabled = false;
    }
    if(formId==='quiz-answers' && currentQuiz) {
      const correct=currentQuiz.questions.filter(q=>Number(data[q.id])===q.answer).length;
      $('#quiz-feedback').innerHTML=`<h3>${correct}/${currentQuiz.questions.length} — ${Math.round(correct/currentQuiz.questions.length*100)}%</h3>${currentQuiz.questions.map(q=>`<p><strong>${esc(q.topic)}: ${Number(data[q.id])===q.answer?'✓':'✗'} ${esc(q.options[q.answer])}</strong><br>${esc(q.explanation)}</p>`).join('')}<p class="muted">Practice only. Your responses and score stay in this browser page and are not submitted to employers.</p>`;
    }
    if(['company-form','posting-form','native-apply-form','consent-form'].includes(formId) || form.classList.contains('review-form')) {
      if(!requireAccount()) return;
      submit.disabled=true;
      const action={'company-form':'company','posting-form':'posting','native-apply-form':'apply','consent-form':'consent'}[formId] || 'review';
        const payload={...data};
        if(action==='posting') payload.remote=data.remote==='on';
      if(['apply','consent'].includes(action)) Object.assign(payload,{jobId:form.dataset.id,shareCv:data.shareCv==='on',consent:data.consent==='on',withdraw:false});
      if(action==='review') { payload.id=form.dataset.id; payload.interviewAt=data.interviewAt?`${data.interviewAt}:00Z`:null; }
      await api(`recruitment/${action}`,'POST',payload);
      if(action==='posting') editingPosting=null;
      if(action==='company') { await load(); submit.disabled=false; toast('Company profile saved.'); return; }
      await load(); closeModal(); render(); toast('Saved successfully.');
    }
    if (formId === 'delete-account-form') {
      submit.disabled = true;
      await api('account', 'DELETE', { password: data.password });
      closeModal(); await load(); preview = false; guestBrowsing=false; country = 'Tunisia'; view = 'overview'; render();
      toast('Your account and personal data have been deleted.');
    }
  } catch (e) {
    if (errorEl) errorEl.textContent = e.message;
    else toast(e.message, true);
    if (submit) submit.disabled = false;
  }
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { closeModal(); $('.sidebar')?.classList.remove('open'); }
  if (event.key === 'Tab' && $('.modal')) {
    const focusable = [...$('.modal').querySelectorAll('button:not(:disabled),a,input,select,textarea')].filter(el => el.offsetParent !== null);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
});
try {
  await load();
  preview = false;
  if (state.user) country = state.user.country;
  if(isRecruiter()) view='hiring';
  await fetchHostedJobs();
  render();
  const parameters = new URLSearchParams(location.search);
  if (state.passwordRecovery) recoveryForm();
  else if (parameters.get('confirmed') === '1') { auth('login'); toast('Email confirmed. Sign in to open your workspace.'); }
  if (parameters.has('reset') || parameters.has('confirmed')) history.replaceState(null, '', '/');
} catch (e) {
  $('#app').innerHTML = `<div class="boot"><h2>We couldn't open your workspace.</h2><p>${esc(e.message)}</p><a href="/">Try again</a></div>`;
}

let checkingUpdates = false;
let updateErrorShown = false;
let lastUpdateCheck = 0;
async function checkUpdates() {
  if (!state.user || checkingUpdates || document.hidden || $('.modal') || ['profile','interview','hiring'].includes(view) || document.activeElement?.matches('input,select,textarea')) return;
  if (state.hosted && Date.now() - lastUpdateCheck < 60000) return;
  lastUpdateCheck = Date.now();
  checkingUpdates = true;
  try {
    const next = await api(state.hosted ? 'state?summary=1' : 'state');
    const signature = s => JSON.stringify([s.user, s.saved, s.applications, s.activities, s.sync, s.email, s.ownedJobs?.map(j => [j.id,j.closed]), !s.hosted && s.jobs?.map(j => [j.id,j.closed])]);
    const changed = signature(next) !== signature(state);
    state = { ...state, ...next };
    if(changed && state.user) state.recruitment=await api('recruitment');
    if (changed && state.hosted && ['overview', 'discover'].includes(view)) await fetchHostedJobs();
    updateErrorShown = false;
    if (!state.user) {
      preview = false;
      guestBrowsing=false;
      country = 'Tunisia';
      view = 'overview';
      toast('Your session expired. Sign in again to continue your search.');
    }
    if (changed) render();
  } catch (e) {
    if (!updateErrorShown) toast(`Could not check for updates: ${e.message}`, true);
    updateErrorShown = true;
  } finally { checkingUpdates = false; }
}
setInterval(checkUpdates, state.hosted ? 600000 : 60000);
window.addEventListener('focus', checkUpdates);
