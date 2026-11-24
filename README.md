# Nextstep

A responsive job-search and recruitment dashboard with two deployment modes:

- **Netlify + Supabase:** static dashboard, serverless API/scheduled functions, managed email/password authentication, Postgres and private CV storage.
- **Local Node + SQLite:** persistent server with private document extraction and optional SMTP notifications. No job-feed API keys are required. Existing local data is preserved.

**Nothing has been deployed.** Tests use a PostgreSQL test engine, simulated Auth/Storage and fake email delivery. Real Supabase, SMTP, function packaging and Netlify schedules still require live verification.

## Run locally

Requires Node.js **22.13 or newer**, including its built-in `node:sqlite` module (experimental on Node 22).

```powershell
npm ci
npm start
```

Open **http://localhost:3000**. The first page is sign-in. Choose job seeker or recruiter when registering; these are separate, immutable account types. Existing accounts remain job seekers. "Browse public jobs" opens real listings without signup. Run validation with `npm test`.

## Features

- Account signup and login, salted password hashes, expiring HttpOnly sessions.
- Onboarding for name, role, country (Tunisia by default), skills, work arrangement, optional CV, LinkedIn, GitHub and GitLab profiles.
- Private PDF/TXT CV storage: 5 MB locally / 4 MB hosted. Bounded worker-based text extraction (20 PDF pages, 60,000 characters, 5-second timeout); review/paste text for scanned or unreadable files. No OCR or external AI.
- Separate preference match and CV keyword coverage, including evidence not found in the CV. These are not hiring probabilities or proof of ability.
- LinkedIn export proposals from your own Profile.csv, Skills.csv, PDF or TXT, with explicit editable confirmation. No LinkedIn scraping or automatic synchronization.
- Private French/English interview QCMs per job or pasted advertisement, with role detection, topic override, explanations and browser-only scoring. Original question bank, not external AI or predictions of employer questions. Motivation letters have been removed.
- Recruiter workspace: company profile, draft/open/closed vacancies, consenting in-app applicants, hiring stages, recruiter-private notes and UTC interview scheduling.
- In-app applications share name/email/message only after explicit consent, with optional current-CV sharing. Candidates can revoke sharing or withdraw; replacing/removing the CV revokes access to its old version. Previously downloaded files cannot be recalled; hosted signed links remain usable for at most 60 seconds. Recruiters cannot browse a candidate directory or private CV evidence. Employer updates appear separately from the candidate's personal tracker.
- Country, keyword, remote, source, and recency filters; transparent preference match scores.
- Saved jobs and application pipeline with manually maintained statuses, private notes, and follow-up dates.
- In-app activity and follow-up reminders, plus detected listing changes for tracked jobs.
- Daily public-feed refresh: Netlify's UTC schedule, or the local scheduler while the server is running.
- Optional daily email digests for new eligible matches and confirmed closures of saved/tracked jobs, with thresholds, explicit consent and delivery status. Local users must verify their notification email first. Telegram is retired.
- Stronger asynchronous password hashing, hashed session tokens, sign-out-all-devices, and password confirmation before account deletion.
- Account deletion, including associated CV, sessions, saved jobs, notes, and activity.
- Responsive layouts, keyboard-accessible dialogs, and reduced-motion support.

## Public job sources

The server connects to [Arbeitnow](https://www.arbeitnow.com/blog/job-board-api) (Germany), its UK feed, [Jobicy](https://jobicy.com/jobs-rss-feed), [Himalayas](https://himalayas.app/api) (worldwide remote roles plus a Tunisia-focused page), and [Remotive](https://remotive.com/remote-jobs/api). These listings and recruiter-published Nextstep vacancies appear inside the same searchable list. Each listing credits its source; attribution and original application URLs are preserved. Feed requests do not send account details, CVs or personal preferences.

Remotive's public feed is delayed 24 hours. Listings and details are accessible without registration, with visible Remotive attribution and original links. A durable per-source six-hour cooldown includes failed attempts; manual global refresh cannot bypass it. Do not redistribute Remotive listings to Google Jobs, LinkedIn or other third-party aggregators. Review source terms before launch.

This is **not universal platform coverage**. Discover jobs also supplies country/role-specific external searches for Google, LinkedIn, Indeed and Himalayas, plus Tanitjobs/Keejob/ANETI for Tunisia. No authorized public feed was verified for Tanitjobs/Keejob, so these are clearly labelled links, not imported listings. Opening external searches shares those search terms with that service. Paste an advertisement into Interview practice for private analysis and preparation. No Google or LinkedIn scraping is performed; Google's Indexing API does not retrieve Google Jobs results.

Only a bounded recent page per source is imported. Country and timezone restrictions are honored for Himalayas. Expired Himalayas listings are excluded from discovery; explicit expiry/HTTP 410 closes them, removes the full description and records a closure event. Details are checked before displaying a live Himalayas description/apply link (verification cached for 15 minutes), and bounded hourly maintenance checks a small batch. HTTP 404, missing feed entries and network failures never prove closure. Other providers have no implemented authoritative closure signal. No promise of detecting every closure or notifying immediately. Untracked listings older than 45 days are hidden; owned history is retained.

Match scores are keyword-based, not AI hiring predictions: skills contribute 40%, target-role words 35%, country eligibility 15%, and work arrangement 10%. Country-level filtering recognizes worldwide and broad European eligibility but cannot establish visa/work authorization or exact regional eligibility. The general Arbeitnow feed does not supply structured countries: country labels are inferred only from explicit country names or a limited set of recognizable cities. Ambiguous locations such as "Remote job" or "Hybrid" remain "Not specified" and are visible under "All countries", not incorrectly treated as globally eligible.

## Local agent behavior

The server fetches feeds on startup. A minute-level scheduler checks whether at least one account has the daily agent enabled and whether 24 hours have elapsed since the last attempt. Feed data is shared; manual refreshes use a global 15-minute cooldown and concurrent requests share one refresh. Partial failures are shown in the agent panel rather than presented as a fully successful search.

The agent compares listing content and records changes for tracked applications. Signed-in dashboards check for updates while visible without interrupting profile edits, recruitment forms or interview practice. Optional email alerts are described below. It does not read inboxes, contact employers, automatically apply, infer hiring decisions or send browser push. External employer responses remain manually tracked; Nextstep recruiters update in-app applications directly. The agent is deterministic scheduling and matching, not an LLM integration.

The scheduler only runs while the server is online. For continuous daily operation, deploy it on a persistent Node host with a persistent data volume and process supervision. A laptop that is off or sleeping cannot refresh.

## Local persistence and deployment

Data lives in `data\nextstep.sqlite` by default and survives restarts. This directory is excluded from Git. CVs and personal data are **not encrypted by the application**: use an encrypted private volume, restrict filesystem permissions, and encrypt backups. Avoid shared/synced data folders for private CVs. Keep a single Node instance with its database on a local persistent disk, not a network filesystem or ephemeral hosting volume.

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `HOST` | `127.0.0.1` | Must remain loopback; a local HTTPS reverse proxy handles public access |
| `DATA_DIR` | `data` beside the server | Persistent private database location |
| `NODE_ENV` | unset | Set to `production` on the public server |
| `PUBLIC_ORIGIN` | unset | Required HTTPS origin in production, without a trailing slash, e.g. `https://jobs.example.com` |
| `TRUST_PROXY` | unset | Must be `true` in production; only a loopback proxy is supported |
| `COOKIE_SECURE` | `false` locally | Production always forces Secure cookies, regardless of this setting |
| `DISABLE_FEEDS` | `false` | Disable startup and scheduled refresh, useful for isolated tests |
| `SMTP_HOST`, `SMTP_PORT` | unset | Optional notification SMTP server; TLS port 465 or STARTTLS 587 |
| `SMTP_USER`, `SMTP_PASS` | unset | Server-only SMTP credentials |
| `NOTIFICATION_FROM` | unset | Verified plain sender email address |

Example in PowerShell:

```powershell
$env:DATA_DIR = 'C:\NextstepPrivateData'
npm start
```

### Security guarantees and remaining launch requirements

Production refuses to start without an HTTPS public origin and trusted local reverse proxy configuration. It rejects plaintext upstream requests and incorrect host/origin headers. Production sessions use `__Host-` cookies with `Secure`, `HttpOnly`, and `SameSite=Strict`; the app supplies HSTS and browser security headers. Raw session tokens are not stored in the database. Existing sessions from the earlier version must sign in again. SQLite secure-delete is enabled to reduce deleted-page remnants; this is not guaranteed physical erasure of WAL files, snapshots, disks, or backups, so encryption and retention controls remain necessary.

Passwords use asynchronous scrypt (`N=65536, r=8, p=2`, 64-byte output, random salts), with at most two concurrent derivations. Older hashes are verified and upgraded on successful login. Account deletion requires the current password. Sign-out-all-devices revokes every session for that account.

The app also limits request sizes, connections and timeouts, and applies per-IP/per-email authentication limits. These limits are **in memory for one process** and reset at restart; they are not a distributed anti-abuse service. HTTPS enforcement does not replace correct firewall/proxy configuration.

**This is not a security certification or a promise of perfect protection.** Local mode has no email verification or recovery; the hosted mode below adds these managed flows. Before unrestricted public signup, validate the hosted setup, add abuse/bot protection and upload malware scanning, and arrange security monitoring, backups/restore tests and a privacy/retention policy. MFA/passkeys are not implemented. Review job-provider terms before public/commercial distribution.

## Deploy on Netlify + Supabase (selected hosting)

Use your **own dedicated Supabase project**, not a project shared with another application's users or permissive Storage policies. Local accounts, passwords and CVs are **not uploaded or migrated**: hosted users register separately. Do not copy the local database to Netlify.

### 1. Create the Netlify project

- Create a **new private Git repository containing only this app's source**. This workspace is inside a home-directory Git repository: do not publish that parent repository. Exclude `data`, `node_modules`, populated environment files, private CVs and credentials.
- Import that app repository into Netlify, choose a permanent project name, and note `https://YOUR-SITE.netlify.app`. A custom domain is not required for the website.
- Netlify reads [netlify.toml](./netlify.toml): build `npm run build`, publish `public`, functions `netlify/functions`, Node 22. **Do not use a static-only drag-and-drop deploy.**
- The first build will intentionally fail until the environment variables below exist. Do not remove the configuration checks.

### 2. Create the hosted database and private bucket

In your Supabase project's **SQL Editor**, run these complete migrations in order:

1. [001_nextstep.sql](./supabase/migrations/001_nextstep.sql)
2. [002_telegram.sql](./supabase/migrations/002_telegram.sql)
3. [003_career_email.sql](./supabase/migrations/003_career_email.sql)
4. [004_recruitment.sql](./supabase/migrations/004_recruitment.sql)

Run all four, including historical migration 002 on a fresh install. They create namespaced `ns_` tables, per-user RLS, private CV evidence, transactional operations, encrypted sessions, the private `nextstep-cvs` bucket, recruitment operations and an email outbox. They can be rerun and do not import local data. Recruitment tables have no direct authenticated/anonymous access: role-checked user-JWT RPCs return only owned data. Account type is set at initial signup, not editable profile metadata. Deleting a recruiter closes/anonymizes its shared jobs and removes its private postings/applicants; candidates retain their personal tracker. Historical Telegram tables remain inactive; no active Telegram API, UI or scheduled delivery remains. Existing unrelated permissive Storage policies can undermine isolation: use a dedicated project.

### 3. Configure confirmed-email authentication and production SMTP

In **Supabase Authentication**:

- Enable Email/password and **Confirm email**. Use a minimum password length of 10 or more.
- Set **Site URL** to exactly `https://YOUR-SITE.netlify.app`; allow `https://YOUR-SITE.netlify.app/auth/callback` as a redirect. Do not allow arbitrary preview domains or wildcards for production.
- Under **SMTP settings**, configure a real transactional sender before public signup. Supabase's default sender is restricted and is not a production sender for arbitrary users. SMTP credentials belong in **Supabase**, not browser code or chat.
- Free SMTP allowances exist, but provider approval, sending limits and sender/domain verification still apply. Some require a domain you own, which is not included with Netlify's free subdomain. Do not assume a personal Gmail address or an unverified Netlify subdomain will be accepted.
- Customize **Confirm sign up** to contain:

  ```html
  <a href="{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&amp;type=email">Confirm my email</a>
  ```

- Customize **Reset password** to contain:

  ```html
  <a href="{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&amp;type=recovery">Reset my password</a>
  ```

These token-hash templates are required: default fragment-based confirmation links do not establish this application's server-side session. Disable email-provider link tracking if it rewrites authentication links. Email confirmation deliberately **does not automatically log in** the browser; users sign in with their password afterwards. Recovery sessions can only reset a password, expire after 10 minutes, and sign out all app devices when completed.

Official references: [Supabase SMTP](https://supabase.com/docs/guides/auth/auth-smtp), [email templates](https://supabase.com/docs/guides/auth/auth-email-templates).

### 4. Set server-only Netlify environment variables

Use Netlify's project environment-variable settings, available to **builds and functions**, for the production deployment:

| Variable | Value |
| --- | --- |
| `PUBLIC_ORIGIN` | `https://YOUR-SITE.netlify.app`, no trailing slash |
| `SUPABASE_URL` | Your HTTPS Supabase project URL, no trailing slash |
| `SUPABASE_PUBLISHABLE_KEY` | Project publishable key |
| `SUPABASE_SECRET_KEY` | **Server-only** project secret key |
| `SESSION_ENCRYPTION_KEY` | A new random 32-byte key, base64 encoded |

Legacy `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` are supported instead of the corresponding new keys. Never interchange the public and privileged keys. Find keys in your Supabase project's API settings/Connect dialog. Never put a secret/service-role key into `public`, a Git repository, screenshots or chat.

Generate the session key **locally**, then paste it directly into Netlify:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Keep the key stable across deployments. Rotation requires invalidating encrypted sessions (`delete from public.ns_sessions;` in the SQL Editor); users then sign in again. [.env.example](./.env.example) contains names only, not credentials. It is not automatically loaded by Node: for private local build validation use `node --env-file=.env scripts/build-netlify.mjs`.

Do **not** set `TRUST_PROXY`, `DATA_DIR`, or VM-specific settings for Netlify. Preview/branch URLs cannot use the private production API. Use a separate project/database and explicit origin if you later add previews.

### 5. Deploy and verify before inviting users

1. Redeploy after setting environment variables. Build validation covers the API, two scheduled functions and PDF worker without putting credentials in public files. Netlify must include `pdf-worker.mjs` and the declared external runtime packages; the configuration specifies these.
2. Open `https://YOUR-SITE.netlify.app/healthz`, then the dashboard. Sign up with an email you control; verify that no workspace or CV upload is available before confirmation.
3. Receive the **real SMTP email**, follow its link and sign in. Test password recovery and resend confirmation too.
4. In Netlify **Functions**, select `refresh-jobs` and use **Run now**. Check logs and **My job agent** for source counts/failures. Automatic refresh runs daily at **06:00 UTC**, only on published deployments; no laptop must remain on.
5. Upload a small selectable-text PDF and TXT (hosted maximum **4 MB**). Verify extraction, private evidence editing, download, replacement, deletion and a scanned-PDF warning. Preview a LinkedIn CSV import, analyze CV gaps, and complete French/English interview QCMs for developer and HR roles.
6. With separate controlled recruiter/candidate accounts, publish a vacancy, apply with explicit consent, change the employer stage/interview date and verify CV replacement/revocation/withdrawal. Check cross-recruiter isolation and that neither recruiter notes nor candidate CV evidence leaks to the other party.
7. With two separate test accounts, verify that each sees only its own CV, applications, saved jobs and notes. Test sign-out-all, password-protected account deletion, and persistence after redeployment. Delete test accounts afterwards.
8. Check Netlify/Supabase usage and function errors. Enable account MFA for your hosting administrators. Configure monitoring, bot mitigation, retention/privacy notices and backup/restore procedures before unrestricted public signup.

Dashboard pages contain at most 60 description-free listing summaries per request, with **Load more**, server-side geographic/full-text filters and on-demand descriptions. Background checks run every 10 minutes while visible and skip job pages unless data changed. Authentication tokens never enter localStorage: opaque Secure/HttpOnly/SameSite cookies reference encrypted server-side tokens. Private data always bypasses the CDN cache. Sign-out-all immediately deletes app sessions.

CVs and extracted text are private, not malware-scanned or application-level encrypted. CV text is excluded from state/poll payloads and available only through the owning account's private tools. The SMTP provider receives a recipient address and generic notifications, not CVs/skills/notes/job details. Signed CV download links are temporary bearer links (60 seconds). Interrupted operations may leave unreferenced private files; monitor Storage quotas/orphans. Deletion does not instantly erase provider backups or already delivered emails.

### 6. Optional daily email notifications

Supabase Auth SMTP is for signup/recovery only. Job alerts require SMTP settings **separately in Netlify**: set all of `SMTP_HOST`, `SMTP_PORT` (465/587), `SMTP_USER`, `SMTP_PASS`, `NOTIFICATION_FROM`, or leave all five unset. Partial settings fail explicitly. Use an approved verified sender and an exact HTTPS `PUBLIC_ORIGIN`. A provider's free allowance is quota-limited; domain verification or ownership may be required.

Users enable alerts in **Profile & preferences** and choose a minimum preference score. Hosted accounts already have confirmed email; local accounts must request an emailed six-digit, ten-minute, account-bound code and explicitly consent (five incorrect attempts invalidate it). No digest is sent merely because an account exists.

`email-digests` runs hourly at **:15 UTC**, checking up to 100 due accounts and dispatching at most five queued emails per invocation. A due window begins 24 hours after consent/settings changes. Only new geography/work-mode-eligible matches and supported saved/tracked closure events trigger a digest; pausing the agent suppresses new matches but not closures. This is not an immediate alert service or an inbox integration.

Use Netlify **Run now**, then verify a real opted-in recipient receives an alert after its first daily window and a subsequent matching import. Inspect status and spam folders. “Sent” means SMTP accepted the message, not inbox delivery. Queues use persistent leases, consent rechecks and up to five hourly retries. Disabling alerts removes pending work. Ambiguous SMTP acceptance/process interruption can cause a duplicate retry; delivery is best-effort, not exactly-once. SMTP failures are shown without exposing provider credentials.

### Free-tier limits

Official pricing currently lists [Netlify Free](https://www.netlify.com/pricing/) at **300 credits/month**, with production deployments using credits, and [Supabase Free](https://supabase.com/pricing) at **500 MB database**, **1 GB Storage**, **50,000 MAU**, and **5 GB egress** (plus a separate cached allowance). Inactive free Supabase projects can pause. Limits and prices can change: check your own account, enable usage notifications, and do not enable paid upgrades automatically.

This supports a quota-limited public beta, **not unlimited hosting for everyone**. SMTP has independent limits. Scheduled functions require a published deployment and successful executions; quotas, provider failures and exhausted deadlines can delay updates. See [Netlify scheduled functions](https://docs.netlify.com/build/functions/scheduled-functions/) and [function limits](https://docs.netlify.com/build/functions/configuration/).

Hosted cleanup removes expired sessions/link codes and rate-limit records, completed notification history after 30 days, events/activity after 90 days, and old untracked/unsaved listings after 90 days. Tracked/saved jobs are retained until their owners delete their data. No automatic backup or guaranteed restore is included by this app.

### Optional alternative: Linux VM, Caddy, systemd

The files in [deploy](./deploy/) are templates for an Ubuntu/systemd host. **Nothing has been deployed or provisioned automatically.**

1. Only if deliberately choosing a VM instead of Netlify: create a Linux VM and persistent encrypted storage in your own cloud account; provider charges may apply. Enable MFA on that account. Configure SSH keys, disable password/root SSH access, and limit SSH ingress to your administrator IP. Permit public TCP 80/443 at the cloud and OS firewalls; **never expose port 3000 or SQLite**.
2. Install a supported Node version (22.13+; preferably a maintained LTS), and Caddy using their official installation instructions. The service assumes Node is at `/usr/bin/node`; adjust `ExecStart` if needed.
3. Copy the application to `/opt/nextstep` using an authorized transfer. Do not copy local databases, CVs, test accounts, `.env` files, or credentials into a public repository. Create a dedicated, unprivileged `nextstep` service user/group. Application files should be root-owned and not writable by this user.
4. Run `npm ci --omit=dev` in the application directory. Copy [nextstep.env.example](./deploy/nextstep.env.example) to `/etc/nextstep.env`, set `PUBLIC_ORIGIN` to your HTTPS domain, and restrict it to root/nextstep (`0640`). Leave all five SMTP settings empty unless enabling alerts. Never commit or paste secrets into a chat.
5. Copy [nextstep.service](./deploy/nextstep.service) to `/etc/systemd/system/nextstep.service`. Its hardening settings create `/var/lib/nextstep` privately, run without root, and restrict filesystem writes. Review the settings for your OS.
6. Point your domain's DNS at the VM. Replace `jobs.example.com` in [Caddyfile](./deploy/Caddyfile) with exactly the same host as `PUBLIC_ORIGIN`, and install it as `/etc/caddy/Caddyfile`. Caddy obtains/renews the TLS certificate; the template overwrites forwarded headers so clients cannot choose their own IP/scheme.
7. On that **Linux server**, validate/reload Caddy, reload systemd, then enable/start `nextstep`. Verify `https://YOUR-DOMAIN/healthz` returns `{"ok":true}`, HTTP navigations upgrade to HTTPS, and direct public port 3000 is unreachable. Confirm the browser receives a Secure `__Host-nextstep` cookie. Test a real signup/CV upload/logout and verify data survives a service restart.
8. Configure encrypted, off-instance SQLite-consistent backups (use the SQLite backup API/CLI, not an arbitrary live copy of only the main WAL database file). Test restore to a separate private environment. Add uptime/disk-space/error monitoring and patching before opening public signup.

## Telegram retirement

Telegram delivery and routes are disabled; the old schedule was removed. Historical migrations/modules remain only for compatibility and regression coverage. Remove obsolete bot environment variables and unregister any old webhook directly with Telegram before upgrading an existing deployment. No real bot was configured by this project.

### Other notification channels

- **WhatsApp:** [Meta's current pricing](https://business.whatsapp.com/products/platform-pricing) is per delivered message, varying by destination/category. Some customer-service replies qualify as free, but unattended proactive job alerts are not generally a free channel. Approved templates, opt-in and potentially provider fees apply.
- **SMS:** [Production SMS has destination/carrier/number charges](https://www.twilio.com/en-us/sms/pricing); trial credits are not an unlimited free production solution.
- **Browser push:** a useful next addition without SMS fees, but it needs HTTPS, opt-in permission, service-worker subscriptions and platform support. Not implemented here.
