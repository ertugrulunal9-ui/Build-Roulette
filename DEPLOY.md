# Deploying Build Roulette on free plans

The whole production setup, step by step, in the order that works. Everything here is on a
free plan (the user's decision of 2026-10-09, docs/08-free-tier.md):

| Part | Where | Free limit that matters |
|---|---|---|
| Web app (`apps/web`): static files + one small Worker on `/battles/*` (link previews) | Cloudflare Workers with static assets, Worker `build-roulette-web` on your Cloudflare account (**A**): `https://build-roulette-web.<subdomain A>.workers.dev` | static files: free and unlimited; 100,000 Worker requests a day for `/battles/*` (after that, until 00:00 UTC, `/battles/*` shows Cloudflare's "rate limited" page) |
| Sandbox shell (`apps/sandbox-shell`): runs players' imported sites (its service worker `/v2/sw.js` serves them), plus the capture gate | Cloudflare Workers with static assets, Worker `build-roulette-sandbox` on a **second** free Cloudflare account (**B**): `https://build-roulette-sandbox.<subdomain B>.workers.dev/v2/` | none in practice (only `/v2/capture` runs the Worker: a few requests per battle; `/v2/sw.js` and the shell are static files) |
| Database, Auth, Realtime, Storage, the `jobs` Edge Function (screenshots and deletes) | Supabase, Free plan | 500 MB database, 1 GB storage, 5 GB egress a month, a pause after 7 idle days (docs/08 §6) |
| Screenshots | Cloudflare Browser Rendering (REST API) | 10 browser-minutes a day, then the players' own thumbnails |
| Keep-alive against the 7-day pause | GitHub Actions (`.github/workflows/keep-alive.yml`) | ~31 of 2,000 free minutes a month on a private repository |
| Optional: error reports, analytics, bot protection | Sentry, PostHog, Cloudflare Turnstile | free tiers |

About 1,000 battles a month fit, and the screenshots of the first ~2,750 battles fit in the
storage (docs/07 §7.8 says what to upgrade first and when; both figures were estimated before
import mode, whose site packs are larger downloads than the old bundles: to be re-measured,
docs/08 §6). Plan on one to two hours. Nothing
here costs money; no credit card is needed (Cloudflare and Supabase may ask for one for other
products: skip them).

**Why Workers on `workers.dev`, not Pages (T-043).** The first deploy (2026-10) used
Cloudflare Pages, but `*.pages.dev` is blocked in Turkey (a court/federation order of 2025-11,
reported active again in 2026-08), where the players are. A Worker on `*.workers.dev` opens
there without a VPN, so both sites are Workers with static assets now, still on free plans
(docs/08-free-tier.md §2–§3).

**Players build on their own computers (M6, docs/09).** They import the built site (the
`dist/` folder or a `.zip`) into the BUILD stage. There is no editor, no bundler and no
package CDN to deploy: the sandbox shell serves each imported site from a service worker.

**Why a second Cloudflare account.** The sandbox shell runs players' code, so it must be
another *site* than the app (docs/01 §1.1, docs/03 §3.5: the preview iframe's
`allow-same-origin` is safe only because of that). A Worker's address is
`<worker>.<account subdomain>.workers.dev`, and the Public Suffix List lists `workers.dev` but
not `*.workers.dev`, so the site is `<account subdomain>.workers.dev`: two Workers of one
account are one site. The shell therefore goes to a second free account, whose own subdomain is
another site. The deploy refuses to put both on the same account.

Dashboard labels move from time to time. Where a menu path below does not match, search the
dashboard for the setting's name. Steps that could not be tried here (no accounts are
reachable from the development container) are written from the vendors' documentation.

There are two ways to do it:

- **From a browser, with GitHub Actions** (recommended, next section): you create the
  accounts and tokens, paste them into GitHub, and click **Run workflow**. The workflow runs
  §2.2, §3.2–§3.8, §4 and §6.1 for you.
- **From your own machine** (§0–§4): the same steps, command by command.

§5–§8 (keep-alive, smoke checks, runbooks, later) apply to both.

## Deploy with GitHub Actions (recommended)

The workflow **Deploy** (`.github/workflows/deploy.yml`; the logic is `scripts/deploy/deploy.mjs`)
runs on GitHub's servers. One run does, in this order:

1. it checks every setting, and both clouds' access (both Cloudflare accounts);
2. it reads each Cloudflare account's workers.dev subdomain, registers one when an account has
   none yet (§2.2), and derives the two addresses from them;
3. it pushes the schema and checks it (§3.2, §3.3);
4. it generates the two secrets (§3.8) and keeps them in Supabase Vault;
5. it sets the Auth settings (§3.6);
6. it deploys the `jobs` function with its secrets (§3.8);
7. it builds and deploys the sandbox shell (account B, with its secret) and the web app
   (account A) as Workers, and makes sure each one's workers.dev address is on (§4);
8. it turns on CAPTCHA when Turnstile is set (§3.6);
9. it lists the moderator (§3.5);
10. it runs `scripts/deploy-check.mjs` (§6.1).

Running it again with nothing changed changes nothing that matters: no new subdomains, no new
secrets.

### A. Accounts and the Supabase project

1. **GitHub**: this repository, with Actions allowed (Settings → Actions → General). The
   workflow appears under **Actions** once `deploy.yml` is on the repository's default branch.
2. **Cloudflare**, Free plan: <https://dash.cloudflare.com/sign-up>. This is account **A**: the
   web app and the screenshots.
3. **A second Cloudflare account**, Free plan, for the sandbox shell: account **B** ("Why a
   second Cloudflare account" above). Sign up again with another email address; a Gmail
   address with `+sandbox` before the `@` (`you+sandbox@gmail.com`) usually works and arrives in
   the same inbox. Nothing else runs on it.
4. **Supabase**, Free plan: <https://supabase.com/dashboard>. Then create **the project**
   (§3.1): a name (`build-roulette`), a generated **database password** (keep it in your
   password manager), the region closest to most players.
5. Optional:
   - a **Turnstile** widget (§2.4), on account A. Its hostname is the app's address, which the
     first run's summary shows; you can add the widget after the first run;
   - **Sentry** and **PostHog** (`apps/web/DEPLOY.md` → "Observability" → "Accounts").

### B. Tokens and keys

| Value | Where to get it |
|---|---|
| Cloudflare **account id** of account A | Signed in to account A: Cloudflare dashboard → Workers & Pages → Overview, right column, "Account ID" (32 characters). |
| Cloudflare **deploy token** of account A | Signed in to account A: My Profile → API Tokens → **Create Token** → **Create Custom Token**. Name: `Build Roulette deploy`. Permissions: **Account → Workers Scripts → Edit**. Account Resources: Include → account A. Continue to summary → Create Token, and copy it (it is shown once). **You already have one from the Pages setup?** Edit it instead ("Moving from Pages to Workers" below): the value stays the same. |
| Cloudflare **account id** of account B | Signed in to account B (the second account): the same place, its "Account ID". It must be another id than A's. |
| Cloudflare **deploy token** of account B | Signed in to account B: the same steps as A's deploy token. Name: `Build Roulette sandbox deploy`. Permissions: **Account → Workers Scripts → Edit**. Account Resources: Include → account B. |
| Cloudflare **screenshot token** | Signed in to account A: a **separate** token. Name: `Build Roulette screenshots`. Permissions: **Account → Browser Run → Edit** (named Browser Rendering before April 2026). It is a separate token on purpose: it is stored in Supabase as a function secret, and a leak there must not let anyone deploy a site. |
| Supabase **access token** | supabase.com → your avatar → **Account** → **Access Tokens** → Generate new token (name: `Build Roulette deploy`). A token scoped to this project works when it has **full access to the project**: the run reads the project and its API keys, runs SQL, and changes the Auth settings, the Edge Functions and their secrets. A legacy token (all projects of the account) works too. |
| **Database password** | The one from §3.1. Forgotten: Project Settings → Database → Reset database password. |
| **Project URL** | `https://<ref>.supabase.co`; the ref is Project Settings → General → **Project ID** (20 letters). |
| **Anon key** | Project Settings → **API Keys**: the publishable key (`sb_publishable_…`) or the legacy anon key (§3.4). Never the secret or `service_role` key: the run refuses them. |
| Optional: Turnstile **site key** and **secret key** | Turnstile → your widget (§2.4). |

**What the tokens can do:**

- A legacy Supabase access token acts as you on **every project** of your Supabase account,
  not only this one; a token scoped to this project reaches only this project. You can revoke
  either at any time: Account → Access Tokens → Revoke. The workflow then fails until you save
  a new one.
- Each deploy token can change any Worker of its own Cloudflare account (and register the
  account's workers.dev subdomain). Revoke it the same way: My Profile → API Tokens, in that
  account.
- Only people with **write access** to the repository can start the workflow. GitHub never
  shows a saved secret again, and does not give secrets to workflows started from forks.

### C. GitHub secrets and variables

Repository → Settings → **Secrets and variables** → **Actions**: secrets on the **Secrets**
tab, variables on the **Variables** tab (New repository secret / New repository variable).
Use the names exactly as written.

| Name | Kind | Needed | Value |
|---|---|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | variable | yes | the account id of account A (B) |
| `CLOUDFLARE_SANDBOX_ACCOUNT_ID` | variable | yes | the account id of account B, the sandbox shell's (B) |
| `SUPABASE_URL` | variable | yes | `https://<ref>.supabase.co` (the keep-alive uses it too, §5) |
| `CLOUDFLARE_API_TOKEN` | secret | yes | the deploy token of account A (B) |
| `CLOUDFLARE_SANDBOX_API_TOKEN` | secret | yes | the deploy token of account B (B) |
| `BROWSER_RENDERING_API_TOKEN` | secret | yes | the screenshot token (B) |
| `SUPABASE_ACCESS_TOKEN` | secret | yes | the access token (B) |
| `SUPABASE_DB_PASSWORD` | secret | yes | the database password (B) |
| `SUPABASE_ANON_KEY` | secret | yes | the publishable or anon key (the keep-alive uses it too, §5) |
| `TURNSTILE_SITE_KEY` | variable | no | Turnstile's site key: the app shows the challenge |
| `TURNSTILE_SECRET_KEY` | secret | no | Turnstile's secret key: with the site key, the run turns CAPTCHA on in Supabase |
| `APP_URL` | variable | no | a custom domain, like `https://play.example.com` (default: the web Worker's own `https://build-roulette-web.<subdomain A>.workers.dev`; a `pages.dev` address is refused) |
| `CF_WORKERS_SUBDOMAIN`, `CF_SANDBOX_WORKERS_SUBDOMAIN` | variables | no | the workers.dev subdomain to register on account A / B **when it has none yet** (defaults `buildroulette` and `buildroulette-sandbox`, with a short random suffix if taken; a name you set is used as is). An account that already has a subdomain keeps it |
| `CF_WEB_WORKER`, `CF_SANDBOX_WORKER` | variables | no | other Worker names (defaults `build-roulette-web` and `build-roulette-sandbox`); the first part of each address. They replace `CF_PAGES_WEB_PROJECT` and `CF_PAGES_SHELL_PROJECT`, which the run no longer reads (delete them). `PKG_CDN_URL` is not read either since import mode (M6): delete it; the run warns while it is set |
| `NEXT_PUBLIC_SENTRY_DSN` | variable | no | Sentry's DSN (browser error reports) |
| `NEXT_PUBLIC_POSTHOG_KEY`, `NEXT_PUBLIC_POSTHOG_HOST` | variables | no | PostHog (analytics; the host defaults to `https://eu.i.posthog.com`) |

Nothing else is needed. The run reads (or registers) both accounts' workers.dev subdomains,
derives the two addresses from them, generates the cron and capture secrets, and sets the
function's settings itself.

### D. Run it

1. Actions → **Deploy** → **Run workflow**, target **check** → Run workflow. This run changes
   nothing. It checks:
   - every setting above (missing or malformed ones are all named at once), including that
     accounts A and B are **different** accounts (the same account would put the shell on the
     app's site: the run refuses and says why), and what is missing when account B is not set
     up yet;
   - that the three Cloudflare tokens are active, and that each deploy token can use Workers on
     its own account (it reads the account's workers.dev subdomain: the summary shows it, or
     "none yet" with the name the run will register);
   - that the Supabase project exists and is **healthy** (a paused project is named as such);
   - that the access token can read what the run needs (the project, SQL, the Auth settings,
     the functions' secrets), and that the Supabase CLI accepts it (`supabase link`, which
     only writes files on GitHub's runner). A failure says which part: the token's format or
     permissions, access to the project, or the database password;
   - that the anon key belongs to the project, and that the database password works.

   The run's **summary** (on the run's page, below the job) lists each check.
2. Run it again with target **all**. The first time takes about 10–15 minutes (estimated).
   Its summary shows:
   - the app's address, the sandbox shell's address, the two Cloudflare accounts with their
     workers.dev subdomains, and the Supabase project;
   - each step's outcome: created, unchanged, updated, deployed or skipped;
   - deploy-check's results (one WARN remains until a battle has been played, §6.3);
   - the next steps.
3. Open the app's address: players can play.

If a run fails, its summary names the step and what to fix. Fix it and run again: every step
is safe to repeat. When an account has no workers.dev subdomain yet, the run registers one
(`buildroulette` on A, `buildroulette-sandbox` on B, or `CF_WORKERS_SUBDOMAIN` /
`CF_SANDBOX_WORKERS_SUBDOMAIN`); subdomains are global across Cloudflare, so when the default
is taken it adds a short suffix (`buildroulette-3f9a`) and uses the real address everywhere. A
new address can take a few minutes to answer: the run then gives deploy-check up to about 4
minutes. No secret value appears in the log or the summary: the script masks each one before
it can be printed.

### Moving from Pages to Workers (after the first deploy of T-042)

The first deploy put both sites on Cloudflare Pages (`*.pages.dev`), which is blocked in Turkey.
To move them to `*.workers.dev`:

1. **Edit the existing deploy token** (account A): My Profile → API Tokens → `Build Roulette
   deploy` → ⋯ → **Edit** → **+ Add more** → **Account → Workers Scripts → Edit** → Continue
   to summary → **Update token**. The token's value does not change, so the GitHub secret
   `CLOUDFLARE_API_TOKEN` stays as it is. Account → Cloudflare Pages → Edit can be removed from
   it now (the workflow no longer uses Pages).
2. **Create a second free Cloudflare account** (account B): sign up with another email address;
   Gmail's `+sandbox` alias (`you+sandbox@gmail.com`) usually works.
3. **In account B**, create a token: My Profile → API Tokens → Create Token → Create Custom
   Token, name `Build Roulette sandbox deploy`, **Account → Workers Scripts → Edit**, Account
   Resources: Include → account B → Create Token; copy it. Copy account B's **Account ID** too
   (Workers & Pages → Overview, right column).
4. **Add the new settings** in GitHub (Settings → Secrets and variables → Actions): the
   variable `CLOUDFLARE_SANDBOX_ACCOUNT_ID` (account B's id) and the secret
   `CLOUDFLARE_SANDBOX_API_TOKEN` (account B's token). If you set `CF_PAGES_WEB_PROJECT` or
   `CF_PAGES_SHELL_PROJECT`, delete them; if `APP_URL` is a `pages.dev` address, delete it.
5. **Run** Deploy with target **check**, then with target **all**. The summary shows the new
   addresses. Auth's Site URL moves to the new app address (the old one stays in Redirect URLs
   until you remove it), and the function's `CAPTURE_SHELL_URL` moves to the new shell.
6. With **Turnstile**: add the new app hostname (`build-roulette-web.<subdomain A>.workers.dev`)
   to the widget (Turnstile → the widget → Settings → Hostname management) right away; until
   then the challenge fails and nobody can sign in. The run's summary reminds you.
7. Once the new addresses work (§6), **delete the old Pages projects**: Workers & Pages → the
   project (`build-roulette-web`, then `build-roulette-sandbox`) → Settings → Delete. The
   workflow never deletes them.

### E. What stays manual

- The accounts, the project, the tokens and the settings (A–C).
- **The moderator** (§3.5):
  1. Supabase → Authentication → **Users** → **Add user** → **Create new user**: an email
     address, a long password, **Auto Confirm User** checked → Create.
  2. Actions → Deploy → Run workflow, target **supabase**, **admin_email** = that address.
     The run lists the user in `private.admins` (running it again changes nothing). If the
     user does not exist, the run says so and changes nothing.

  The moderator signs in at `<app address>/admin/sign-in`.
- **The keep-alive** (§5) uses the same `SUPABASE_URL` and `SUPABASE_ANON_KEY`. Run **Keep
  Supabase awake** once by hand, and read §5.3 (private repositories and Actions minutes).
- Optional: Realtime's pool size (§3.7). A custom domain (`apps/web/DEPLOY.md` → "Custom
  domain"): then set `APP_URL`, run **all** again, and add the domain to the Turnstile widget.
- Deleting the old Pages projects, if you deployed with Pages before ("Moving from Pages to
  Workers" above, step 7).
- The checks that need a person: §6.2–§6.6, then the runbook rehearsal (§7).

### F. After a code change

Bring the change to the branch you deploy from. Then Actions → Deploy → Run workflow, pick
that branch in "Use workflow from", target **all**:

- new migrations are applied, in order;
- the function, the shell and the app are rebuilt and deployed again (each deploy is a new
  version of its Worker);
- the subdomains and the secrets stay as they are.

One part only: target **supabase** (migrations, Auth, the function), **shell** or **web**;
each still runs the checks first. A second deploy waits until the first one has finished.
Rollback: §8.

### Running the script on your own machine

The same script runs locally, with the settings of C in `.env.deploy` (§0):

```sh
node --env-file=.env.deploy scripts/deploy/deploy.mjs --target check
```

It needs Node 22, pnpm and the installed dependencies (§0), but no `wrangler login` or
`supabase login`: the tokens are enough (add `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_SANDBOX_API_TOKEN`, `SUPABASE_ACCESS_TOKEN` and `SUPABASE_DB_PASSWORD` to the file
for that). It ignores `SHELL_URL`, `JOBS_CRON_SECRET` and `CAPTURE_HMAC_SECRET` from that file:
it derives the shell's address from account B's workers.dev subdomain and reads the secrets
from Supabase Vault.

## Deploy from your own machine

§0–§4 are the same deploy by hand, command by command. §5–§8 apply to both ways.

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
  # Cloudflare (§2): account A (the app, the screenshots) and account B (the sandbox shell)
  CLOUDFLARE_ACCOUNT_ID=
  CLOUDFLARE_API_TOKEN=
  CLOUDFLARE_SANDBOX_ACCOUNT_ID=
  CLOUDFLARE_SANDBOX_API_TOKEN=
  APP_URL=https://build-roulette-web.<subdomain A>.workers.dev
  SHELL_URL=https://build-roulette-sandbox.<subdomain B>.workers.dev/v2/
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

1. **Cloudflare**, Free plan: <https://dash.cloudflare.com/sign-up>. This is account **A** (the
   web app, Browser Rendering, Turnstile).
2. **A second Cloudflare account**, Free plan, for the sandbox shell: account **B**. Sign up
   again with another email address (Gmail's `+sandbox` alias usually works). Why: "Why a
   second Cloudflare account" at the top.
3. **Supabase**, Free plan: <https://supabase.com/dashboard> (sign in with GitHub or email).
   The Free plan allows two active projects.
4. **GitHub**: the repository (it runs the keep-alive, §5). Public or private both work;
   §5 explains the difference.
5. Optional:
   - **Cloudflare Turnstile** (bot protection for anonymous sign-up; account A): §2.4.
   - **Sentry** (browser error reports) and **PostHog** (product analytics, EU region):
     `apps/web/DEPLOY.md` → "Observability" → "Accounts" says how to set each project up
     (IP storage off, allowed domains). Without them nothing is sent.

## 2. Cloudflare

### 2.1 The two accounts' ids and deploy tokens

wrangler uses an API token per command, so the two accounts never mix (a `wrangler login`
would be one person's login, and account B belongs to another email address). For each
account, signed in to it in the dashboard:

- **Account ID**: Workers & Pages → Overview, right column. Into `.env.deploy`:
  `CLOUDFLARE_ACCOUNT_ID` (A) and `CLOUDFLARE_SANDBOX_ACCOUNT_ID` (B). They must differ.
- **Deploy token**: My Profile → API Tokens → **Create Token** → **Create Custom Token**;
  permissions **Account → Workers Scripts → Edit**, Account Resources: Include → that account;
  Create Token, copy it once into `.env.deploy`: `CLOUDFLARE_API_TOKEN` (A),
  `CLOUDFLARE_SANDBOX_API_TOKEN` (B).

### 2.2 The workers.dev subdomains

Each account needs a **workers.dev subdomain**: the Workers' addresses are
`https://<worker>.<subdomain>.workers.dev` (`build-roulette-web` on A, `build-roulette-sandbox`
on B). Subdomains are global across Cloudflare: pick names nobody has, like `buildroulette`
(A) and `buildroulette-sandbox` (B). An account that already has one keeps it (renaming it
changes every workers.dev address of the account). Check, and register one if there is none,
for account A (then the same with B's id, token and name):

```sh
set -a; . ./.env.deploy; set +a
curl -sS "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/subdomain" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
# {"result":{"subdomain":"…"},"success":true,…}: it has one. Error 10007: none yet; register it:
curl -sS -X PUT "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/subdomain" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'Content-Type: application/json' \
  --data '{"subdomain":"buildroulette"}'
# Error 10031: the name is taken; try another.
```

(Or in the dashboard: Workers & Pages → Overview → the subdomain in the right column. An
interactive `wrangler deploy` also offers to register one.) Then set `APP_URL` and `SHELL_URL`
in `.env.deploy` from the two subdomains (`SHELL_URL` ends with `/v2/`). A new subdomain can
take a few minutes to answer.

### 2.3 Browser Rendering (the screenshots)

Signed in to account A: My Profile → API Tokens → **Create Token** → **Create Custom Token**:

- Permissions: **Account → Browser Run → Edit** (named Browser Rendering before April 2026);
- Account Resources: Include → account A;
- Continue → Create Token. Copy it once into `.env.deploy` as `BROWSER_RENDERING_API_TOKEN`.

Browser Rendering's REST API is included in Workers Free: 10 browser-minutes a day, one
request every 10 seconds; the `jobs` function stays inside both (docs/08 §5.4).

### 2.4 Turnstile (optional)

Account A's dashboard → **Turnstile** → **Add widget**: a name, the hostname(s) of the app
(`build-roulette-web.<subdomain A>.workers.dev`, and a custom domain if you have one), widget
mode **Managed**, → Create. Copy the **site key** into `.env.deploy` as `TURNSTILE_SITE_KEY`;
keep the **secret key** for Supabase (§3.6).

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
   BROWSER_RENDERING_ACCOUNT_ID=$CLOUDFLARE_ACCOUNT_ID
   BROWSER_RENDERING_API_TOKEN=$BROWSER_RENDERING_API_TOKEN
   ENV
   npx -y supabase@2.119.0 secrets set --env-file /tmp/br-jobs.env
   rm /tmp/br-jobs.env
   npx -y supabase@2.119.0 secrets list        # names and digests only
   ```
   `CAPTURE_SHELL_URL` is the shell's capture page (`${SHELL_URL}capture`:
   `https://build-roulette-sandbox.<subdomain B>.workers.dev/v2/capture`). A `PKG_CDN_URL`
   secret left from before import mode is ignored; delete it with
   `npx -y supabase@2.119.0 secrets unset PKG_CDN_URL` (the Deploy workflow does).
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

## 4. Cloudflare Workers

### 4.1 The sandbox shell, on account B (first: the app's build needs its address)

```sh
set -a; . ./.env.deploy; set +a
# Build: which app origins may frame the shell.
BR_APP_ORIGINS="$APP_URL" pnpm --filter @br/sandbox-shell build
# Deploy to account B, with the capture gate's secret in the same version (a private file,
# deleted right after; the secret never goes on a command line):
umask 077 && printf '{"CAPTURE_HMAC_SECRET":"%s"}' "$CAPTURE_HMAC_SECRET" > /tmp/br-shell-secrets.json
CLOUDFLARE_ACCOUNT_ID="$CLOUDFLARE_SANDBOX_ACCOUNT_ID" CLOUDFLARE_API_TOKEN="$CLOUDFLARE_SANDBOX_API_TOKEN" \
  pnpm --filter @br/sandbox-shell workers:deploy --secrets-file /tmp/br-shell-secrets.json
rm /tmp/br-shell-secrets.json
```

- `workers:deploy` is `wrangler deploy` with `apps/sandbox-shell/wrangler.jsonc`: the Worker
  `build-roulette-sandbox` (the capture gate, `dist/worker.js`) with `dist/` as its static
  assets; only `/v2/capture` runs the Worker. `--secrets-file` sets the Worker secret
  `CAPTURE_HMAC_SECRET` with the version, which also works on the very first deploy (a secret
  cannot be put on a Worker that does not exist yet). A later deploy without the file keeps the
  secret. `--name <other>` deploys under another name.
- `BR_APP_ORIGINS`: comma-separated; add a custom domain of the app here when you add one.
- **The service worker:** the shell registers `/v2/sw.js` (the site worker, docs/09 §9.3) with
  scope `/`, and it serves each imported site. `dist/_headers` gives it
  `Service-Worker-Allowed: /` and `Cache-Control: no-store`; nothing to set by hand.
- Check: `curl -sS -o /dev/null -w '%{http_code}\n' "${SHELL_URL}capture"` answers **403**
  (the gate refuses an unsigned request); **503** means the secret is missing.
  `curl -sS -o /dev/null -D - "${SHELL_URL}sw.js"` answers **200** with a JavaScript
  `content-type` and `service-worker-allowed: /` (deploy-check checks both).

### 4.2 The web app, on account A

```sh
set -a; . ./.env.deploy; set +a
NEXT_PUBLIC_SUPABASE_URL="$SUPABASE_URL" \
NEXT_PUBLIC_SUPABASE_ANON_KEY="$SUPABASE_ANON_KEY" \
NEXT_PUBLIC_SANDBOX_SHELL_URL="$SHELL_URL" \
NEXT_PUBLIC_SITE_URL="$APP_URL" \
NEXT_PUBLIC_TURNSTILE_SITE_KEY="$TURNSTILE_SITE_KEY" \
  pnpm --filter @br/web build
pnpm --filter @br/web workers:deploy        # CLOUDFLARE_ACCOUNT_ID and _API_TOKEN: account A's
```

- `workers:deploy` is `wrangler deploy` with `apps/web/wrangler.jsonc`: the Worker
  `build-roulette-web` (the link previews, `dist/worker.js`) with `out/` as its static assets;
  only `/battles/*` runs the Worker.
- Every value is baked in at build time (the bundles, the CSP in `_headers`, the link-preview
  Worker); there is nothing to set on the Worker. A changed value means build and deploy again.
- Optional, in the same build command: `NEXT_PUBLIC_SENTRY_DSN`,
  `NEXT_PUBLIC_SENTRY_ENVIRONMENT` (default `production`), `NEXT_PUBLIC_POSTHOG_KEY`,
  `NEXT_PUBLIC_POSTHOG_HOST` (default `https://eu.i.posthog.com`), `BR_RELEASE` (default: the
  git commit). An empty `NEXT_PUBLIC_TURNSTILE_SITE_KEY` means no Turnstile.
- With Turnstile: now turn on CAPTCHA in Supabase (§3.6).
- **The daily limit:** static files are free and unlimited, but each view of `/battles/{id}`
  runs the Worker, and Workers Free allows 100,000 Worker requests a day per account (reset
  00:00 UTC). Past that, `/battles/*` shows Cloudflare's "temporarily rate limited" page until
  the reset, while every other page keeps working. Pages Functions had a "fail open" setting
  for this; Workers have none (docs/08 §3.5). At ~1,000 battles a month this is far away.
- A custom domain (optional, later): `apps/web/DEPLOY.md` → "Custom domain"; then rebuild the
  app with `NEXT_PUBLIC_SITE_URL` set to it, add it to `BR_APP_ORIGINS` and rebuild the
  shell, and add it to Supabase's URL configuration and the Turnstile widget.

## 5. GitHub: the keep-alive

Supabase pauses a Free project after 7 days without user activity; the game's own background
jobs do not count (docs/08 §6.2). The workflow **Keep Supabase awake** calls the database once a
day and fails (GitHub emails you) when the project is paused, restricted or read-only.

1. Repository → Settings → **Secrets and variables** → **Actions** (already done if you set up
   the Deploy workflow: same names):
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
4. **CI** needs no secrets or variables: it tests against a local stack in each job. Nothing
   deploys on a push: a deploy runs only when someone starts the **Deploy** workflow ("Deploy
   with GitHub Actions"), the only workflow that reads the Cloudflare and Supabase tokens.

## 6. Smoke checks

1. **Automatic checks** (headers and CSP, real 404s, the shells, the link-preview Worker and
   its Supabase call, the shell's CSP, its site worker `/v2/sw.js`, its capture gate and that
   its Worker code is not served,
   Auth with anonymous sign-ins, `keep_alive`, the `jobs` function with its secrets):
   ```sh
   set -a; . ./.env.deploy; set +a
   node scripts/deploy-check.mjs --app "$APP_URL" --shell "$SHELL_URL" --supabase "$SUPABASE_URL"
   ```
   It reads `SUPABASE_ANON_KEY` and `JOBS_CRON_SECRET` from the environment and exits 1 on any
   FAIL, naming what is wrong. One WARN remains until step 3 (`--battle`).
2. **Play.** Open `APP_URL` in two browsers (one private window): **Create room** in one,
   join with the code or link in the other, start a battle (a 10-minute limit is quickest),
   import a built site in both (any `dist/` folder or `.zip`; `/try` checks one without a
   battle), ship, reveal, vote, and see the results. Also try a solo battle from `/play`.
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
more Workers under other names: `CF_WEB_WORKER`, `CF_SANDBOX_WORKER`). For each one: follow **Symptoms → Confirm → Mitigate → Verify** on a
situation you create, and note what was unclear.

| Runbook | Drill |
|---|---|
| [stuck-battle](docs/runbooks/stuck-battle.md) | Start a solo battle; in the SQL Editor `select cron.unschedule('br-sweep-deadlines');` and let the timer run out (the client still nudges: close the tab). Confirm with Health, mitigate with the runbook (reschedule the sweep: its step 1). |
| [capture-backlog](docs/runbooks/capture-backlog.md) | Set the function's daily budget to zero (`npx -y supabase@2.119.0 secrets set BROWSER_BUDGET_MS_PER_DAY=0`), play a solo battle: the screenshot is the client thumbnail ("fallback" in Health). Then unset it (`secrets unset BROWSER_BUDGET_MS_PER_DAY`). Run its step 7 check of the site worker too. |
| [realtime-quota](docs/runbooks/realtime-quota.md) | Run its Confirm queries during the two-browser battle; read the dashboard's Realtime usage. (Reaching Free's 20 Presence messages a second needs ~10 busy rooms: not worth forcing.) |
| [supabase-outage](docs/runbooks/supabase-outage.md) | Pause the project (Project Settings → General → Pause project) for a few minutes during a battle in a test room, restore it, then follow Mitigate (deadlines, deletes, Health). |
| [free-plan-quotas](docs/runbooks/free-plan-quotas.md) | The paused project of the previous drill: run **Keep Supabase awake** while paused (it must fail with "PAUSED"), then again after the restore. Lower the storage limit (`update private.ops_settings set storage_limit_bytes = 1000000;`) and see Health's finding; set it back to `1000000000`. |
| [takedown-abuse](docs/runbooks/takedown-abuse.md) | Report a build of the test battle from another browser, take it down in `/admin`, check the results page, the history and the link preview. |
| [removed-content-still-visible](docs/runbooks/removed-content-still-visible.md) | After that takedown, run its Confirm checks: the screenshot file answers 4xx within a minute, the preview shows the static card. |

## 8. Later

### Deploying M6 (import mode)

The release that turns the editor into imports (docs/09) changes the database, the jobs
function, the shell and the app together: shell v2 (`/v2/`), the site pack `site.bin`, new
storage file names and the 10–45 minute time limits. Deploy all four in one go (the Deploy
workflow's target **all**; by hand: `db push`, `functions deploy jobs`, §4.1, §4.2), then run
`scripts/deploy-check.mjs`.

- **Battles running during the deploy** may end DNF: their autosaves and ships use the old
  file names (`bundle.js`, `source.json`), which the new database refuses and does not ship.
  Deploy when few battles run; nothing else is lost (finished battles keep their results and
  screenshots).
- **Cloudflare Browser Rendering must run service workers** for the v2 capture page (it loads
  the site through `/v2/sw.js`). This could not be verified from the development container.
  If the screenshots come back blank or failed after the deploy, the game still works: each
  build falls back to the player's client thumbnail. To check: `/admin` → **Health** →
  "Screenshots, last 24 h" (captured vs. fallback / failed), and Edge Functions → `jobs` →
  Logs: `capture.rendered` / `capture.captured` lines are real screenshots,
  `capture.render_unusable` followed by `capture.fallback` are thumbnails
  ([capture-backlog.md](docs/runbooks/capture-backlog.md) step 7).
- Delete the `PKG_CDN_URL` variable and function secret if they are still set (the Deploy
  workflow deletes the secret and warns about the variable).

- **Redeploying** after a code change: with the workflow, Actions → Deploy → Run workflow,
  target **all** ("Deploy with GitHub Actions" → F). By hand: `npx -y supabase@2.119.0 db push`
  (new migrations, always first), `functions deploy jobs --no-verify-jwt --use-api` when
  `supabase/functions/jobs` changed, then the shell (§4.1) if `apps/sandbox-shell` changed,
  then the app (§4.2). Re-run `scripts/deploy-check.mjs`.
- **Rollback** of a Worker (the app on account A, the shell on account B): Workers & Pages →
  the Worker → Deployments → an older version → Rollback (instant; or `wrangler rollback` in
  `apps/web` / `apps/sandbox-shell` with that account's token). Migrations are not rolled
  back.
- **Every week or month:** Supabase → Organization → **Usage** (egress, Realtime messages,
  MAU) and `/admin` → Health → Plan usage (storage, database). docs/07 §7.8 says when to
  upgrade; `docs/runbooks/free-plan-quotas.md` what to do near a limit.
- **Rotating secrets:** the cron secret (`supabase/README.md` → "Jobs"), the capture secret
  (the shell Worker's secret, deployed with `--secrets-file` as in §4.1, + the function
  secret), the Browser Rendering token
  (function secret), the anon key (rebuild the app and update the GitHub secret). With the
  workflow: update the GitHub secret and run **all**. For the two generated secrets, first
  delete the Vault entry in the SQL Editor
  (`delete from vault.secrets where name = 'br_jobs_cron_secret';`, or
  `'br_capture_hmac_secret'`), then run **all**: it generates a new one and sets it everywhere.

## Every setting, and where it goes

Checked against the code (`grep` of every environment read in `apps/web`, `apps/sandbox-shell`,
`apps/capture-worker/src/edge`, `scripts/deploy` and the workflows). With the Deploy workflow,
you set only the GitHub variables and secrets (the last rows); it sets everything above them.

| Setting | Set where | Value |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | web build (§4.2) | `https://<ref>.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` (or `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`) | web build | the publishable or anon key |
| `NEXT_PUBLIC_SANDBOX_SHELL_URL` | web build | `https://build-roulette-sandbox.<subdomain B>.workers.dev/v2/` |
| `NEXT_PUBLIC_SITE_URL` | web build | the app's address (or custom domain) |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | web build, optional | the Turnstile site key |
| `NEXT_PUBLIC_SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_ENVIRONMENT` | web build, optional | Sentry |
| `NEXT_PUBLIC_POSTHOG_KEY`, `NEXT_PUBLIC_POSTHOG_HOST` | web build, optional | PostHog |
| `BR_RELEASE` | web build, optional | release name (default: the commit) |
| `BR_APP_ORIGINS` | shell build (§4.1) | the app's origin(s), comma-separated |
| `CAPTURE_HMAC_SECRET` | Worker secret of `build-roulette-sandbox` (account B) **and** function secret (the Deploy workflow keeps it in Vault `br_capture_hmac_secret` too) | 64 hex characters, the same in all |
| `JOBS_CRON_SECRET` | function secret **and** Vault `br_jobs_cron_secret` | 64 hex characters, the same in both |
| `CAPTURE_SHELL_URL` | function secret | `https://build-roulette-sandbox.<subdomain B>.workers.dev/v2/capture` |
| `BROWSER_RENDERING_ACCOUNT_ID`, `BROWSER_RENDERING_API_TOKEN` | function secrets | account A's id; the token of §2.3 |
| `BROWSER_BUDGET_MS_PER_DAY`, `BROWSER_RENDERING_MIN_INTERVAL_MS`, `BROWSER_RESERVE_MS`, `CAPTURE_TIMEOUT_MS`, `CAPTURE_SIGNED_URL_TTL_S`, `JOBS_RUN_WINDOW_MS`, `JOBS_RUN_HARD_STOP_MS`, `JOBS_PUBLIC_SUPABASE_URL`, `BROWSER_RENDERING_API_URL`, `LOG_LEVEL` | function secrets, optional | defaults fit the free plans (`apps/capture-worker/src/edge/config.ts`) |
| `br_jobs_function_url` | Vault | `https://<ref>.supabase.co/functions/v1/jobs` |
| `SUPABASE_URL` | GitHub variable (keep-alive and Deploy) | `https://<ref>.supabase.co` |
| `SUPABASE_ANON_KEY` | GitHub secret (keep-alive and Deploy) | the publishable or anon key |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_SANDBOX_ACCOUNT_ID` | GitHub variables (Deploy) | the ids of Cloudflare accounts A (the app) and B (the sandbox shell); they must differ |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_SANDBOX_API_TOKEN`, `BROWSER_RENDERING_API_TOKEN`, `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD` | GitHub secrets (Deploy) | "Deploy with GitHub Actions" → B, C |
| `TURNSTILE_SECRET_KEY` | GitHub secret (Deploy), optional | the Turnstile secret key; the run puts it in Supabase's CAPTCHA settings |
| `TURNSTILE_SITE_KEY`, `APP_URL`, `CF_WORKERS_SUBDOMAIN`, `CF_SANDBOX_WORKERS_SUBDOMAIN`, `CF_WEB_WORKER`, `CF_SANDBOX_WORKER`, `NEXT_PUBLIC_SENTRY_DSN`, `NEXT_PUBLIC_POSTHOG_KEY`, `NEXT_PUBLIC_POSTHOG_HOST` | GitHub variables (Deploy), optional | the run turns them into the build settings and function secrets above ("Deploy with GitHub Actions" → C) |
| `private.ops_settings` | SQL, optional | the plan limits behind Health's meters (Free's by default) |

Not used by the free setup: `SENTRY_DSN` and the other settings of the self-hosted capture
worker (`apps/capture-worker/.env.example`); the `jobs` function logs to Supabase (Edge
Functions → `jobs` → Logs) and reports nothing to Sentry.

No longer used since import mode (M6): `PKG_CDN_URL` (GitHub variable and function secret),
`BR_PKG_CDN_URL` (shell build) and `NEXT_PUBLIC_PKG_CDN_URL` (web build). Values left behind
are ignored; delete them.
