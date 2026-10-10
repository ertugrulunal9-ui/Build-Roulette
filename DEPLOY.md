# Deploying Build Roulette on free plans

The whole production setup, step by step, in the order that works. Everything here is on a
free plan (the user's decision of 2026-10-09, docs/08-free-tier.md):

| Part | Where | Free limit that matters |
|---|---|---|
| Web app (`apps/web`): static files + one small Function on `/battles/*` (link previews) | Cloudflare Pages, project `build-roulette-web` | 100,000 Function requests a day (fails open) |
| Sandbox shell (`apps/sandbox-shell`): runs players' builds, plus the capture gate | Cloudflare Pages, project `build-roulette-sandbox` | none in practice |
| npm packages for the builds | public esm.sh | none (community service, no SLA) |
| Database, Auth, Realtime, Storage, the `jobs` Edge Function (screenshots and deletes) | Supabase, Free plan | 500 MB database, 1 GB storage, 5 GB egress a month, a pause after 7 idle days (docs/08 §6) |
| Screenshots | Cloudflare Browser Rendering (REST API) | 10 browser-minutes a day, then the players' own thumbnails |
| Keep-alive against the 7-day pause | GitHub Actions (`.github/workflows/keep-alive.yml`) | ~31 of 2,000 free minutes a month on a private repository |
| Optional: error reports, analytics, bot protection | Sentry, PostHog, Cloudflare Turnstile | free tiers |

About 1,000 battles a month fit, and the screenshots of the first ~2,750 battles fit in the
storage (docs/07 §7.8 says what to upgrade first and when). Plan on one to two hours. Nothing
here costs money; no credit card is needed (Cloudflare and Supabase may ask for one for other
products: skip them).

Dashboard labels move from time to time. Where a menu path below does not match, search the
dashboard for the setting's name. Steps that could not be tried here (no accounts are
reachable from the development container) are written from the vendors' documentation.

## 0. On your machine

- Node.js 22 and pnpm 10 (`corepack enable` gives the pnpm version in `package.json`), git,
  curl, openssl. Docker is **not** needed for the deploy.
- The repository, with its dependencies:
  ```sh
  git clone <your repository URL> build-roulette && cd build-roulette
  pnpm install --frozen-lockfile
  ```
- Every command below runs from the repository root.
- **Keep the values in one file** as you collect them. `.env.deploy` is ignored by git
  (`.env.*` in `.gitignore`); keep it private and back it up in a password manager:
  ```sh
  cat > .env.deploy <<'ENV'
  # Cloudflare (§2)
  CLOUDFLARE_ACCOUNT_ID=
  APP_URL=https://build-roulette-web.pages.dev
  SHELL_URL=https://build-roulette-sandbox.pages.dev/v1/
  PKG_CDN_URL=https://esm.sh
  BROWSER_RENDERING_API_TOKEN=
  TURNSTILE_SITE_KEY=
  # Supabase (§3)
  SUPABASE_REF=
  SUPABASE_URL=
  SUPABASE_ANON_KEY=
  # Generated secrets (§3.8)
  JOBS_CRON_SECRET=
  CAPTURE_HMAC_SECRET=
  ENV
  chmod 600 .env.deploy
  ```
  Load it into a shell with `set -a; . ./.env.deploy; set +a` before the commands that use
  `$…`.

## 1. Accounts

1. **Cloudflare**, Free plan: <https://dash.cloudflare.com/sign-up>.
2. **Supabase**, Free plan: <https://supabase.com/dashboard> (sign in with GitHub or email).
   The Free plan allows two active projects.
3. **GitHub**: the repository (it runs the keep-alive, §5). Public or private both work;
   §5 explains the difference.
4. Optional:
   - **Cloudflare Turnstile** (bot protection for anonymous sign-up; same Cloudflare account):
     §2.4.
   - **Sentry** (browser error reports) and **PostHog** (product analytics, EU region):
     `apps/web/DEPLOY.md` → "Observability" → "Accounts" says how to set each project up
     (IP storage off, allowed domains). Without them nothing is sent.

## 2. Cloudflare

### 2.1 Log in from this machine

```sh
pnpm --filter @br/web exec wrangler login        # opens a browser once
pnpm --filter @br/web exec wrangler whoami       # shows the account name and id
```

Put the **account id** in `.env.deploy` as `CLOUDFLARE_ACCOUNT_ID` (also on the dashboard:
Workers & Pages → Overview, right column).

### 2.2 Create the two Pages projects

The names become the free addresses `https://<name>.pages.dev`. The two must be **different
sites** (the shell runs untrusted code; `pages.dev` is on the Public Suffix List, so two
projects are two sites).

```sh
pnpm --filter @br/web exec wrangler pages project create build-roulette-web --production-branch main
pnpm --filter @br/web exec wrangler pages project create build-roulette-sandbox --production-branch main
```

If Cloudflare adds a suffix to a name that was taken, use the address it prints in
`APP_URL` and `SHELL_URL` (`SHELL_URL` ends with `/v1/`), and in every command below. Using
other project names: also change `name` in `apps/web/wrangler.jsonc`.

### 2.3 Browser Rendering (the screenshots)

Dashboard → My Profile → API Tokens → **Create Token** → **Create Custom Token**:

- Permissions: **Account → Browser Rendering → Edit**;
- Account Resources: Include → your account;
- Continue → Create Token. Copy it once into `.env.deploy` as `BROWSER_RENDERING_API_TOKEN`.

Browser Rendering's REST API is included in Workers Free: 10 browser-minutes a day, one
request every 10 seconds; the `jobs` function stays inside both (docs/08 §5.4).

### 2.4 Turnstile (optional)

Dashboard → **Turnstile** → **Add widget**: a name, the hostname(s) of the app
(`build-roulette-web.pages.dev`, and a custom domain if you have one), widget mode **Managed**,
→ Create. Copy the **site key** into `.env.deploy` as `TURNSTILE_SITE_KEY`; keep the **secret
key** for Supabase (§3.6).

## 3. Supabase

All `supabase` commands use the CLI version this repository is tested with:
`npx -y supabase@2.119.0 …`.

### 3.1 Create the project

Dashboard → **New project**: your organization (Free plan), a name (`build-roulette`), a
**database password** (generate one and store it in your password manager), the region
closest to most players → Create. When it is ready, Project Settings → General shows the
**Project ID** (the "ref", 20 letters): put it in `.env.deploy` as `SUPABASE_REF`, and
`SUPABASE_URL=https://<ref>.supabase.co`.

### 3.2 Link this repository to it

```sh
set -a; . ./.env.deploy; set +a
npx -y supabase@2.119.0 login                                   # opens a browser once
npx -y supabase@2.119.0 link --project-ref "$SUPABASE_REF"     # asks for the database password
```

### 3.3 Create the schema (`db push`)

```sh
npx -y supabase@2.119.0 db push        # every migration in supabase/migrations, in order; confirm with Y
```

This creates the tables, the RPCs, the storage buckets, `pg_cron` with its schedules, `pg_net`
and the vote categories and card deck. Then check it in the dashboard's **SQL Editor**:

```sql
select jobname, schedule from cron.job order by jobname;
-- 6 rows: br-cron-history-cleanup, br-event-logs-prune, br-jobs-run, br-rate-events-prune,
--         br-sweep-deadlines (5 seconds), br-sweep-ttl, and nothing else
select id, public from storage.buckets order by id;
-- ephemeral-builds false, screenshots true
select count(*) from public.prompt_cards;   -- 130
```

### 3.4 The API key the app uses

Project Settings → **API Keys**: copy the **publishable** key (`sb_publishable_…`), or the
legacy **anon** key (a long `eyJ…` JWT, under "Legacy API keys"), into `.env.deploy` as
`SUPABASE_ANON_KEY`. Both work everywhere below. It is public by design: it goes into the web
app's files. **Never** use the secret or `service_role` key in the app (the web build refuses
to finish when it finds one).

### 3.5 The first admin (moderator)

Authentication → **Users** → **Add user** → **Create new user**: an email address, a long
password, **Auto Confirm User** checked → Create. Then in the SQL Editor (with that email):

```sql
insert into private.admins (user_id, note)
select id, 'moderator' from auth.users where email = 'mod@example.com';
```

The admin signs in at `<APP_URL>/admin/sign-in` (after §4). More moderators: the same two
steps; removing one: `supabase/README.md` → "Admins".

### 3.6 Auth settings

- Authentication → **Sign In / Providers**: **Allow anonymous sign-ins** ON (players never
  register). Keep **Email** enabled (moderators sign in with email and password). "Allow
  manual linking" is not used yet; leave it as it is.
- Authentication → **URL Configuration**: **Site URL** = `APP_URL`; add `APP_URL` (and a
  custom domain, if any) to **Redirect URLs**.
- Authentication → **Rate Limits**: keep the defaults (anonymous sign-ins: 30 an hour per IP
  address).
- **CAPTCHA, only with Turnstile:** do this right after §4.2 has deployed the app with the
  site key (the app sends a Turnstile token from then on; with CAPTCHA on and an app without
  the key, nobody can sign in). Authentication → **Attack Protection** (on older dashboards
  Settings → Authentication → Bot and Abuse Protection) → **Enable CAPTCHA protection**,
  provider **Cloudflare Turnstile**, the Turnstile **secret** key → Save. It also covers the
  moderators' password sign-in (the admin page sends a token too).

### 3.7 Realtime settings

Project Settings → **Realtime** (or Realtime → Settings):

- **Database connection pool size** (Realtime's authorization pool): Free projects run on the
  Nano compute size, whose default is 2 (Supabase's Realtime docs). If the field can be
  changed on your plan, set it to **10** (docs/07 §7.5.4: battle-start joins). If it cannot,
  leave it: the clients stagger their joins (T-029), measured at p95 156 ms even with a pool
  of 1.
- If the page offers a switch for public channels ("Allow public access" or similar), it can
  be off: the game uses private channels only.

### 3.8 The screenshot and delete jobs (the `jobs` Edge Function)

1. **Two secrets**, generated once (keep them in `.env.deploy`):
   ```sh
   sed -i.bak "s/^JOBS_CRON_SECRET=.*/JOBS_CRON_SECRET=$(openssl rand -hex 32)/; s/^CAPTURE_HMAC_SECRET=.*/CAPTURE_HMAC_SECRET=$(openssl rand -hex 32)/" .env.deploy && rm .env.deploy.bak
   set -a; . ./.env.deploy; set +a
   ```
   `JOBS_CRON_SECRET` lets pg_cron start the function; `CAPTURE_HMAC_SECRET` is shared with the
   sandbox shell's capture gate (§4.1).
2. **The function's secrets** (through a temporary file, so they stay out of the shell
   history):
   ```sh
   umask 077
   cat > /tmp/br-jobs.env <<ENV
   JOBS_CRON_SECRET=$JOBS_CRON_SECRET
   CAPTURE_SHELL_URL=${SHELL_URL}capture
   CAPTURE_HMAC_SECRET=$CAPTURE_HMAC_SECRET
   PKG_CDN_URL=$PKG_CDN_URL
   BROWSER_RENDERING_ACCOUNT_ID=$CLOUDFLARE_ACCOUNT_ID
   BROWSER_RENDERING_API_TOKEN=$BROWSER_RENDERING_API_TOKEN
   ENV
   npx -y supabase@2.119.0 secrets set --env-file /tmp/br-jobs.env
   rm /tmp/br-jobs.env
   npx -y supabase@2.119.0 secrets list        # names and digests only
   ```
   `CAPTURE_SHELL_URL` is the shell's capture page (`https://build-roulette-sandbox.pages.dev/v1/capture`).
   Supabase sets `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` for the function itself. The
   optional settings and their defaults (all fit the free plans) are listed in
   `apps/web/DEPLOY.md` → "Screenshots and jobs", step 4.
3. **Deploy the function** (bundled by Supabase, no Docker):
   ```sh
   npx -y supabase@2.119.0 functions deploy jobs --no-verify-jwt --use-api
   ```
   `--no-verify-jwt` is required (also in `supabase/config.toml`): pg_cron sends the cron
   secret, not a user's token.
4. **Tell the database where the function is** (Vault), in the SQL Editor, with your values:
   ```sql
   select vault.create_secret('https://<ref>.supabase.co/functions/v1/jobs', 'br_jobs_function_url');
   select vault.create_secret('<JOBS_CRON_SECRET>', 'br_jobs_cron_secret');
   ```
   (Print the second value with `grep JOBS_CRON_SECRET .env.deploy`. To rotate it later:
   `supabase/README.md` → "Jobs".)
5. **Check:**
   ```sh
   curl -sS -X POST "$SUPABASE_URL/functions/v1/jobs?wait=1" -H "x-br-cron-secret: $JOBS_CRON_SECRET"
   # → 200 {"run":"…","stoppedBy":"empty","jobs":[]}; a 500 lists the settings that are wrong
   curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$SUPABASE_URL/functions/v1/jobs"   # → 401
   ```

## 4. Cloudflare Pages

### 4.1 The sandbox shell (first: the app's build needs its address)

```sh
set -a; . ./.env.deploy; set +a
# The capture gate's secret, before the deploy (a Pages secret applies to the next deployment):
printf %s "$CAPTURE_HMAC_SECRET" | \
  pnpm --filter @br/web exec wrangler pages secret put CAPTURE_HMAC_SECRET --cwd ../sandbox-shell --project-name build-roulette-sandbox
# Build: which app origins may frame the shell, and the package CDN its CSP allows.
BR_APP_ORIGINS="$APP_URL" BR_PKG_CDN_URL="$PKG_CDN_URL" pnpm --filter @br/sandbox-shell build
pnpm --filter @br/web exec wrangler pages deploy dist --cwd ../sandbox-shell --project-name build-roulette-sandbox --branch main
```

- `BR_APP_ORIGINS`: comma-separated; add a custom domain of the app here when you add one.
  `BR_PKG_CDN_URL` must be the same CDN as the app's `NEXT_PUBLIC_PKG_CDN_URL` and the
  function's `PKG_CDN_URL`.
- `--cwd ../sandbox-shell` keeps wrangler away from the web app's `wrangler.jsonc`
  (`pnpm --filter @br/web exec` runs in `apps/web`, where wrangler is installed).
- Check: `curl -sS -o /dev/null -w '%{http_code}\n' "${SHELL_URL}capture"` answers **403**
  (the gate refuses an unsigned request); **503** means the secret is missing.

### 4.2 The web app

```sh
set -a; . ./.env.deploy; set +a
NEXT_PUBLIC_SUPABASE_URL="$SUPABASE_URL" \
NEXT_PUBLIC_SUPABASE_ANON_KEY="$SUPABASE_ANON_KEY" \
NEXT_PUBLIC_SANDBOX_SHELL_URL="$SHELL_URL" \
NEXT_PUBLIC_PKG_CDN_URL="$PKG_CDN_URL" \
NEXT_PUBLIC_SITE_URL="$APP_URL" \
NEXT_PUBLIC_TURNSTILE_SITE_KEY="$TURNSTILE_SITE_KEY" \
  pnpm --filter @br/web build
pnpm --filter @br/web pages:deploy --branch main
```

- Every value is baked in at build time (the bundles, the CSP in `_headers`, the link-preview
  Function); there is nothing to set on the Pages project. A changed value means build and
  deploy again.
- Optional, in the same build command: `NEXT_PUBLIC_SENTRY_DSN`,
  `NEXT_PUBLIC_SENTRY_ENVIRONMENT` (default `production`), `NEXT_PUBLIC_POSTHOG_KEY`,
  `NEXT_PUBLIC_POSTHOG_HOST` (default `https://eu.i.posthog.com`), `BR_RELEASE` (default: the
  git commit). An empty `NEXT_PUBLIC_TURNSTILE_SITE_KEY` means no Turnstile.
- With Turnstile: now turn on CAPTCHA in Supabase (§3.6).
- Workers & Pages → `build-roulette-web` → Settings → Functions: keep the default **fail
  open** for the Functions' daily request limit (past 100,000 requests a day `/battles/*`
  answers without its link preview instead of an error page).
- A custom domain (optional, later): `apps/web/DEPLOY.md` → "Custom domain"; then rebuild the
  app with `NEXT_PUBLIC_SITE_URL` set to it, add it to `BR_APP_ORIGINS` and rebuild the
  shell, and add it to Supabase's URL configuration and the Turnstile widget.

## 5. GitHub: the keep-alive

Supabase pauses a Free project after 7 days without user activity; the game's own background
jobs do not count (docs/08 §6.2). The workflow **Keep Supabase awake** calls the database once a
day and fails (GitHub emails you) when the project is paused, restricted or read-only.

1. Repository → Settings → **Secrets and variables** → **Actions**:
   - **Variables** tab → New repository variable: `SUPABASE_URL` = `https://<ref>.supabase.co`;
   - **Secrets** tab → New repository secret: `SUPABASE_ANON_KEY` = the key of §3.4.

   Or with the GitHub CLI: `gh variable set SUPABASE_URL --body "$SUPABASE_URL"` and
   `printf %s "$SUPABASE_ANON_KEY" | gh secret set SUPABASE_ANON_KEY`.
2. Actions → **Keep Supabase awake** → **Run workflow**. The run's summary shows "Supabase is
   awake"; `/admin` → Health → Plan usage shows "last ping … ago" from then on.
3. **Make sure it keeps running:**
   - Settings → Notifications: keep email notifications for failed Actions runs on.
   - **Private repository:** GitHub Free includes 2,000 Actions minutes a month. The keep-alive
     uses about 31. The **CI** workflow (`.github/workflows/ci.yml`) runs nine jobs on every
     push and **every night** (roughly 80–100 runner minutes a run, estimated): the nightly
     run alone would use more than the monthly allowance, and when the minutes run out, the
     keep-alive stops too. On a private repository, remove the `schedule:` trigger from
     `ci.yml` (or set a spending limit, or make the repository public).
   - **Public repository:** Actions minutes are free, but GitHub disables scheduled workflows
     after 60 days without a commit. The workflow re-enables itself on each run (assumed to
     reset that clock; GitHub does not document it). If it is disabled anyway, Actions →
     Keep Supabase awake → Enable workflow; Supabase also emails a week before it pauses.
4. **CI** needs no secrets or variables: it tests against a local stack in each job. Deploys are
   not automated (no Cloudflare token in GitHub); they are the commands of §4.

## 6. Smoke checks

1. **Automatic checks** (headers and CSP, real 404s, the shells, the link-preview Function and
   its Supabase call, the shell's CSP and capture gate, Auth with anonymous sign-ins,
   `keep_alive`, the `jobs` function with its secrets):
   ```sh
   set -a; . ./.env.deploy; set +a
   node scripts/deploy-check.mjs --app "$APP_URL" --shell "$SHELL_URL" --supabase "$SUPABASE_URL"
   ```
   It reads `SUPABASE_ANON_KEY` and `JOBS_CRON_SECRET` from the environment and exits 1 on any
   FAIL, naming what is wrong. One WARN remains until step 3 (`--battle`).
2. **Play.** Open `APP_URL` in two browsers (one private window): **Create room** in one,
   join with the code or link in the other, start a battle (a 5-minute limit is quickest), ship
   in both, reveal, vote, and see the results. Also try a solo battle from `/play`.
3. **Screenshots.** Within a minute or two of RESULTS the builds' screenshots appear on the
   results page (`/battles/<id>`, linked from the results). Dashboard → Edge Functions → `jobs`
   → Logs shows `capture.rendered`. Then with that battle id:
   ```sh
   node scripts/deploy-check.mjs --app "$APP_URL" --shell "$SHELL_URL" --supabase "$SUPABASE_URL" --battle <battle id>
   ```
4. **Link preview** (what Slack, Discord or X read):
   ```sh
   curl -sS -D - -A 'Slackbot-LinkExpanding 1.0' "$APP_URL/battles/<battle id>" \
     | grep -i -E '^(HTTP|x-br-preview|content-security-policy)|og:(title|image)"'
   ```
   `200`, `x-br-preview: battle`, the battle's `og:title`, and its rank-1 screenshot as
   `og:image`. Paste the link into a chat to see the card.
5. **Admin.** `APP_URL/admin/sign-in` with the moderator of §3.5 → **Health**: the sweeps ran
   seconds ago, "Screenshots, last 24 h" counts the battle's captures, Plan usage shows the
   storage and database meters and the keep-alive's last ping, no findings. With Sentry:
   **Send a test error to Sentry** and find it in Sentry within a minute.
6. **Two days later:** the keep-alive ran twice (Actions), and the SQL Editor shows the daily
   sweeps: `select jobname, max(start_time) from cron.job_run_details d join cron.job using (jobid) group by 1;`.

## 7. Rehearse the runbooks (the M5 exit criterion)

M5 is signed off when every runbook in `docs/runbooks/` has been rehearsed once on a deployed
copy. Do it before you announce the game: until then this deployment is the staging copy
(a separate staging copy needs a second Supabase project, which the Free plan allows, and two
more Pages projects). For each one: follow **Symptoms → Confirm → Mitigate → Verify** on a
situation you create, and note what was unclear.

| Runbook | Drill |
|---|---|
| [stuck-battle](docs/runbooks/stuck-battle.md) | Start a solo battle; in the SQL Editor `select cron.unschedule('br-sweep-deadlines');` and let the timer run out (the client still nudges: close the tab). Confirm with Health, mitigate with the runbook (reschedule the sweep: its step 1). |
| [capture-backlog](docs/runbooks/capture-backlog.md) | Set the function's daily budget to zero (`npx -y supabase@2.119.0 secrets set BROWSER_BUDGET_MS_PER_DAY=0`), play a solo battle: the screenshot is the client thumbnail ("fallback" in Health). Then unset it (`secrets unset BROWSER_BUDGET_MS_PER_DAY`). |
| [package-cdn-outage](docs/runbooks/package-cdn-outage.md) | In a browser's DevTools → Network → block `esm.sh`, then start a build in a new room: the preview reports the package server; the runbook's esm.sh section. |
| [realtime-quota](docs/runbooks/realtime-quota.md) | Run its Confirm queries during the two-browser battle; read the dashboard's Realtime usage. (Reaching Free's 20 Presence messages a second needs ~10 busy rooms: not worth forcing.) |
| [supabase-outage](docs/runbooks/supabase-outage.md) | Pause the project (Project Settings → General → Pause project) for a few minutes during a battle in a test room, restore it, then follow Mitigate (deadlines, deletes, Health). |
| [free-plan-quotas](docs/runbooks/free-plan-quotas.md) | The paused project of the previous drill: run **Keep Supabase awake** while paused (it must fail with "PAUSED"), then again after the restore. Lower the storage limit (`update private.ops_settings set storage_limit_bytes = 1000000;`) and see Health's finding; set it back to `1000000000`. |
| [takedown-abuse](docs/runbooks/takedown-abuse.md) | Report a build of the test battle from another browser, take it down in `/admin`, check the results page, the history and the link preview. |
| [removed-content-still-visible](docs/runbooks/removed-content-still-visible.md) | After that takedown, run its Confirm checks: the screenshot file answers 4xx within a minute, the preview shows the static card. |

## 8. Later

- **Redeploying** after a code change: `npx -y supabase@2.119.0 db push` (new migrations,
  always first), `functions deploy jobs --no-verify-jwt --use-api` when
  `supabase/functions/jobs` changed, then the shell (§4.1) if `apps/sandbox-shell` changed,
  then the app (§4.2). Re-run `scripts/deploy-check.mjs`.
- **Rollback** of a Pages deployment: Workers & Pages → the project → Deployments → an older
  one → Rollback (instant). Migrations are not rolled back.
- **Every week or month:** Supabase → Organization → **Usage** (egress, Realtime messages,
  MAU) and `/admin` → Health → Plan usage (storage, database). docs/07 §7.8 says when to
  upgrade; `docs/runbooks/free-plan-quotas.md` what to do near a limit.
- **Rotating secrets:** the cron secret (`supabase/README.md` → "Jobs"), the capture secret
  (Pages secret + function secret, then redeploy the shell), the Browser Rendering token
  (function secret), the anon key (rebuild the app and update the GitHub secret).

## Every setting, and where it goes

Checked against the code (`grep` of every environment read in `apps/web`, `apps/sandbox-shell`,
`apps/capture-worker/src/edge` and the workflows).

| Setting | Set where | Value |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | web build (§4.2) | `https://<ref>.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` (or `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`) | web build | the publishable or anon key |
| `NEXT_PUBLIC_SANDBOX_SHELL_URL` | web build | `https://build-roulette-sandbox.pages.dev/v1/` |
| `NEXT_PUBLIC_PKG_CDN_URL` | web build | `https://esm.sh` |
| `NEXT_PUBLIC_SITE_URL` | web build | the app's address (or custom domain) |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | web build, optional | the Turnstile site key |
| `NEXT_PUBLIC_SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_ENVIRONMENT` | web build, optional | Sentry |
| `NEXT_PUBLIC_POSTHOG_KEY`, `NEXT_PUBLIC_POSTHOG_HOST` | web build, optional | PostHog |
| `BR_RELEASE` | web build, optional | release name (default: the commit) |
| `BR_APP_ORIGINS` | shell build (§4.1) | the app's origin(s), comma-separated |
| `BR_PKG_CDN_URL` | shell build | `https://esm.sh` (the default) |
| `CAPTURE_HMAC_SECRET` | Pages secret of `build-roulette-sandbox` **and** function secret | 64 hex characters, the same in both |
| `JOBS_CRON_SECRET` | function secret **and** Vault `br_jobs_cron_secret` | 64 hex characters, the same in both |
| `CAPTURE_SHELL_URL` | function secret | `https://build-roulette-sandbox.pages.dev/v1/capture` |
| `PKG_CDN_URL` | function secret | `https://esm.sh` |
| `BROWSER_RENDERING_ACCOUNT_ID`, `BROWSER_RENDERING_API_TOKEN` | function secrets | Cloudflare account id; the token of §2.3 |
| `BROWSER_BUDGET_MS_PER_DAY`, `BROWSER_RENDERING_MIN_INTERVAL_MS`, `BROWSER_RESERVE_MS`, `CAPTURE_TIMEOUT_MS`, `CAPTURE_SIGNED_URL_TTL_S`, `JOBS_RUN_WINDOW_MS`, `JOBS_RUN_HARD_STOP_MS`, `JOBS_PUBLIC_SUPABASE_URL`, `BROWSER_RENDERING_API_URL`, `LOG_LEVEL` | function secrets, optional | defaults fit the free plans (`apps/capture-worker/src/edge/config.ts`) |
| `br_jobs_function_url` | Vault | `https://<ref>.supabase.co/functions/v1/jobs` |
| `SUPABASE_URL` | GitHub variable (keep-alive) | `https://<ref>.supabase.co` |
| `SUPABASE_ANON_KEY` | GitHub secret (keep-alive) | the publishable or anon key |
| `private.ops_settings` | SQL, optional | the plan limits behind Health's meters (Free's by default) |

Not used by the free setup: `SENTRY_DSN` and the other settings of the self-hosted capture
worker (`apps/capture-worker/.env.example`) and of our own package CDN (`apps/pkg-cdn`); the
`jobs` function logs to Supabase (Edge Functions → `jobs` → Logs) and reports nothing to Sentry.
