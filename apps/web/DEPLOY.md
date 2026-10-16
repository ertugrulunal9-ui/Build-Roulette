# Deploying `@br/web` to Cloudflare Workers with static assets (free)

> **The step-by-step deploy of the whole free setup** (the two Cloudflare accounts, Supabase,
> the jobs function, both Workers, the keep-alive, smoke checks, the runbook rehearsal) is
> [`DEPLOY.md`](../../DEPLOY.md) at the repository root (T-036); its section "Deploy with
> GitHub Actions" does all of it from a browser (T-042). This file is the web app's
> reference: what the build produces, its settings, the link-preview Worker, observability
> and caching.

The web app is a **static site** (T-037, the user's option C after T-033: Next.js on Workers
Free does not fit the 10 ms CPU limit, docs/08-free-tier.md). `next build` exports every page
as a file (`output: 'export'`) into `apps/web/out/`, served as the **static assets of a
Cloudflare Worker** on `workers.dev` (T-043; Cloudflare Pages before, but `*.pages.dev` is
blocked in Turkey: docs/08-free-tier.md §2.7): static requests are free, unlimited, and are
not Worker invocations. Everything else happens in the browser, against Supabase. One
exception, **`/battles/*`**: the Worker's own code (T-038, `dist/worker.js`; a Pages Function
until T-043) writes each battle's own link preview (title, `og:*`) into the shell; it fits
Workers Free's 10 ms with a wide margin (docs/08-free-tier.md §3). The configuration is
`apps/web/wrangler.jsonc`.

What a deploy uploads (`apps/web/out/` as the assets and `dist/worker.js` as the Worker,
measured on 2026-10-09):

| | |
|---|---|
| Pages | `/`, `/play`, `/try`, `/admin`, `/admin/sign-in`, `404.html`, and three **shells**: `/r` (every room), `/battles` (every battle's results), `/u` (every player's history) |
| `_redirects` | `/playground /try 301` (the editor's old page, M6), then `/r/:code /r 200`, `/battles/:id /battles 200`, `/u/:id /u 200`: rewrites, so `/battles/{id}` is answered with the shell and keeps its URL; the page reads the id in the browser and loads its data (`src/lib/hosting/shells.ts`) |
| `_headers` | the security headers (a Content-Security-Policy, no framing, `nosniff`, referrer and permissions policies), a year's cache for `/_next/static/*`, `noindex` for `/admin` (`src/lib/hosting/pages-config.ts`) |
| `dist/worker.js` (outside `out/`) | the link-preview Worker (T-038): 13 KiB (5 KiB gzip), bundled from `src/lib/hosting/preview-worker.ts` with this build's `NEXT_PUBLIC_*` values and the `/*` headers of `_headers`; deployed as is (`main`, `no_bundle`) |
| `run_worker_first: ["/battles/*"]` (wrangler.jsonc) | the only paths that invoke the Worker; every other request is a static file, and an unknown path gets `404.html` from the assets (`not_found_handling: "404-page"`) |
| Assets | JS/CSS chunks, `og-card.png`, `icon.svg` (no bundler or `esbuild.wasm` since M6: players import built sites) |
| Size | 87 files, 1.7 MiB; JS 1.4 MiB (465 KiB gzip) (measured on 2026-10-16, T-047) |

`pnpm build` runs `next build` and then `scripts/pages-config.ts`, which writes `_headers`,
`_redirects` and `dist/worker.js` and **fails the build** if `404.html` or a shell is missing,
if any file (the Worker included) holds a Supabase key other than the public anon key (a
service-role or user JWT, an `sb_secret_` key, or the value of `SUPABASE_SERVICE_ROLE_KEY` /
`SERVICE_ROLE_KEY` / `SUPABASE_SECRET_KEY` from the build's environment), or if a host limit
would be exceeded. It prints the export's size and the Worker's.

Everything below runs from the repository root. Nothing here is needed for local work.

## Try it locally first (no account needed)

```sh
pnpm --filter @br/web build        # next build + _headers/_redirects → apps/web/out/, dist/worker.js
pnpm --filter @br/web preview      # wrangler dev: http://localhost:3000
```

`preview` is `wrangler dev` (Cloudflare's local runtime, workerd, with the static-assets
router): the same rewrites, headers, 404 handling and link-preview Worker on `/battles/*` as
production. Every e2e suite runs against it (`e2e/app-server.ts`). `/try` and `/play`
also need the sandbox shell
(`pnpm --filter @br/web dev:sandbox`, or `dev:solo`'s services), and every page that reads
data needs the local Supabase stack (`supabase/README.md`).

Wrangler prints `Unable to fetch the Request.cf object` when it cannot reach
`workers.cloudflare.com` (for example behind a proxy): harmless, it falls back to placeholder
geo data.

## One-time setup

1. **A Cloudflare account** (<https://dash.cloudflare.com/sign-up>): account A. The **Free
   plan** is enough: Workers Free covers the static assets and the one small Worker. (The
   sandbox shell is a Worker on a **second** account: the root `DEPLOY.md` says why.)
2. **Credentials:** `CLOUDFLARE_ACCOUNT_ID` and an API token in `CLOUDFLARE_API_TOKEN` with
   Account → Workers Scripts → Edit (root `DEPLOY.md` §2.1), or `wrangler login` (opens a
   browser once) when this account is the only one you use from this machine.
3. **The account's workers.dev subdomain** (once per account; root `DEPLOY.md` §2.2). The
   Worker's address is `https://<name>.<subdomain>.workers.dev`, `name` from
   `apps/web/wrangler.jsonc` (`build-roulette-web`). No project to create: the first
   `wrangler deploy` creates the Worker.
4. **The sandbox shell must allow the app's origin.** It bakes the origins that may frame it
   into its CSP and its `postMessage` checks at build time:
   ```sh
   BR_APP_ORIGINS=https://build-roulette-web.<subdomain>.workers.dev \
     pnpm --filter @br/sandbox-shell build
   ```
   (`BR_APP_ORIGINS`: add the custom domain, if any, comma-separated;
   `apps/sandbox-shell/scripts/build.ts`.) The shell serves each imported site from its
   service worker `/v2/sw.js` (docs/09 §9.3), with `Service-Worker-Allowed: /` from its
   `_headers`; there is nothing else to set for it.

## Deploying

```sh
NEXT_PUBLIC_SUPABASE_URL=https://<project>.supabase.co \
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon or publishable key> \
NEXT_PUBLIC_SANDBOX_SHELL_URL=https://build-roulette-sandbox.<subdomain B>.workers.dev/v2/ \
NEXT_PUBLIC_SITE_URL=https://build-roulette-web.<subdomain>.workers.dev \
  pnpm --filter @br/web build
pnpm --filter @br/web workers:deploy
```

- `workers:deploy` is `wrangler deploy` (it uploads `out/` and `dist/worker.js` as
  `wrangler.jsonc` says, as a new version, live at once on the Worker's workers.dev address
  and custom domains). `--name <other>` deploys under another name. Per-version preview
  addresses are off (`preview_urls: false`): the sandbox shell would not allow them anyway.
- **No package CDN since M6** (docs/09): players build with their own tools and import the
  built site, so the app neither bundles code nor fetches packages, and its CSP has no CDN in
  `connect-src` and no `'wasm-unsafe-eval'`. `NEXT_PUBLIC_PKG_CDN_URL` is ignored; delete it
  from old build scripts.
- **Every setting is baked in at build time.** `NEXT_PUBLIC_*` values are inlined into the
  bundles, and the build's `_headers` allows exactly those hosts in its CSP (Supabase, the
  sandbox shell, Sentry, PostHog, Turnstile). The link-preview Worker gets
  the same values the same way: it calls `get_public_battle` at `NEXT_PUBLIC_SUPABASE_URL`
  with `NEXT_PUBLIC_SUPABASE_ANON_KEY` (the public anon key; a publishable key works too),
  and uses `NEXT_PUBLIC_SITE_URL` for `og:url` and the canonical link (without it, the
  request's own origin). There are no runtime variables or secrets on the Worker: change a
  value, build again, deploy again. Without them the build points at the local
  stack and the local dev servers.
- **`NEXT_PUBLIC_SITE_URL` matters more since T-038:** it is the origin of every absolute URL
  in a preview (the static card, `og:url`, the canonical link). Set it to the address people
  share (the custom domain if there is one), so previews reached through the workers.dev
  address point at it too.
- The anon/publishable key is public by design. **No secret goes into this build**: the
  service-role key and the Turnstile secret belong to Supabase and the capture worker, never
  to the web app (`pages-config.ts` refuses to finish a build that contains one).
- **Rollback:** Workers & Pages → `build-roulette-web` → Deployments → a previous version →
  Rollback (instant; or `wrangler rollback`), or deploy an older build again.
- Cloudflare building on every push (Workers Builds) is not set up: the Deploy workflow
  (root `DEPLOY.md`) builds on GitHub and uploads.

### Deploying M6 (import mode)

Deploy the database migration, the `jobs` function, the sandbox shell (v2, with its service
worker) and this app **together** (root `DEPLOY.md` §8, "Deploying M6"): the new app speaks
only protocol v2 and stores `site.bin`. Battles running during the deploy may end DNF (their
autosaves use the old file names). Cloudflare Browser Rendering must run service workers for
the v2 capture page; if screenshots come back blank or failed after the deploy, the client
thumbnails still fill in: check `/admin` → Health → "Screenshots, last 24 h" and the `jobs`
function's logs (`capture.render_unusable`, `capture.fallback`), and see
`docs/runbooks/capture-backlog.md` step 7.

## The link-preview Worker (T-038)

Nothing to configure for it to work; four things to know:

1. **It shares Workers Free's 100,000 requests a day** with every other Worker on account A
   (there is no other: T-034's jobs run on Supabase, next section; the sandbox shell is on
   account B), counted from 00:00 UTC. Only `/battles/*` counts: one request per view of a
   results page, by a person or by a crawler. When that allowance is spent, Cloudflare
   answers `/battles/*` with its own 429 "temporarily rate limited" page until 00:00 UTC;
   every other page is static and keeps working. (Pages Functions could "fail open" to the
   static shell; Workers have no such setting: docs/08-free-tier.md §2.7.)
2. **CPU:** measured locally at 1.2–1.7 ms per request warm (median; p95 ≤ 3.2 ms) and
   3.2–4.2 ms in a fresh isolate (median; worst sample 8.8 ms), against the 10 ms limit
   (docs/08-free-tier.md §3.3; Cloudflare's own CPUs may be slower or faster). After a
   deploy, the Worker's metrics in Workers & Pages → `build-roulette-web` show the CPU time
   per invocation: it should stay well below 10 ms, with errors near zero.
3. **Its log:** `pnpm --filter @br/web exec wrangler tail build-roulette-web` (account A's
   credentials) shows a line `battle preview: fail open (timeout|error|shape) for /battles/<id>` whenever Supabase
   did not answer in 1.5 s; the page itself is unaffected.
4. **Check it after a deploy:**
   ```sh
   curl -sS -D - -A 'Slackbot-LinkExpanding 1.0' https://<site>/battles/<a finished battle> \
     | grep -i -E '^(HTTP|x-br-preview|content-security-policy)|og:(title|image)"'
   ```
   expects `200`, `x-br-preview: battle`, the CSP, the battle's `og:title` and the rank-1
   screenshot (or `og-card.png`). An unknown id answers `404` with `x-br-preview: not-found`.
   Then paste a battle link into the debugger of a network you care about (e.g. the Facebook
   Sharing Debugger, the LinkedIn Post Inspector) to see the card.

## Screenshots and jobs (the `jobs` Edge Function, T-034)

Screenshots, and the deletes of finished battles' files and of taken-down screenshots, run in
the Supabase Edge Function `jobs` (`supabase/functions/jobs`). pg_cron starts it every minute
through pg_net when a job is due, and it renders with **Cloudflare Browser Rendering's REST
API** (Workers Free: 10 browser-minutes a day; the function stops at 9.5 and then uses the
players' own thumbnails). Design and limits: docs/08-free-tier.md §5. Nothing else runs all
the time. Run these steps once, after the database migrations (`supabase db push`), the
sandbox shell and the app:

1. **The Browser Rendering credentials** (Cloudflare dashboard):
   - **Account ID:** Workers & Pages → Overview, right column (also in the dashboard URL).
   - **API token:** My Profile → API Tokens → Create Token → Custom token, with the permission
     **Account → Browser Rendering → Edit**, limited to this account. Copy the token once.
     Per Cloudflare's docs; not tried here (no account).
2. **The capture secret.** This is the sandbox shell's capture gate secret, the Worker secret
   `CAPTURE_HMAC_SECRET` of `build-roulette-sandbox` on account B; it is deployed with the
   shell (`wrangler deploy --secrets-file`, root `DEPLOY.md` §4.1). The function needs the
   same value.
   ```sh
   CAPTURE_HMAC_SECRET=$(openssl rand -hex 32)
   ```
   The shell must be built from T-034 or later: the function reads the capture page's
   `data-br-*` report (docs/03 "Capture on the free plan").
3. **The Supabase CLI** linked to the project: `npx -y supabase@2.119.0 login`, then
   `npx -y supabase@2.119.0 link --project-ref <ref>` (the ref is in the project URL
   `https://<ref>.supabase.co`).
4. **The function's secrets.** They go in a file so they stay out of the shell history; delete
   it afterwards:
   ```sh
   JOBS_CRON_SECRET=$(openssl rand -hex 32)
   cat > /tmp/jobs.env <<ENV
   JOBS_CRON_SECRET=$JOBS_CRON_SECRET
   CAPTURE_SHELL_URL=https://build-roulette-sandbox.<subdomain B>.workers.dev/v2/capture
   CAPTURE_HMAC_SECRET=$CAPTURE_HMAC_SECRET
   BROWSER_RENDERING_ACCOUNT_ID=<account id>
   BROWSER_RENDERING_API_TOKEN=<API token>
   ENV
   npx -y supabase@2.119.0 secrets set --env-file /tmp/jobs.env
   rm /tmp/jobs.env
   ```
   - `CAPTURE_SHELL_URL`: the shell's capture page, i.e. `NEXT_PUBLIC_SANDBOX_SHELL_URL` with
     `capture` instead of the trailing path. With per-build origins it would be
     `https://{build}.<usercontent>/v2/capture`.
   - `PKG_CDN_URL` is not read any more (M6: a site pack needs no import map); a value left
     from before can be removed (`npx -y supabase@2.119.0 secrets unset PKG_CDN_URL`).
   - Supabase sets `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` itself.
   - Optional, with their defaults: `BROWSER_BUDGET_MS_PER_DAY` (570000),
     `BROWSER_RENDERING_MIN_INTERVAL_MS` (10000, the free plan's one request per 10 s),
     `CAPTURE_TIMEOUT_MS` (35000), `JOBS_RUN_WINDOW_MS` (50000),
     `JOBS_RUN_HARD_STOP_MS` (140000; up to 390000 on a paid plan), `LOG_LEVEL` (info).
   - `npx -y supabase@2.119.0 secrets list` shows the names (digests, not values).
5. **Deploy the function.** `supabase/config.toml` already has `verify_jwt = false` for it:
   pg_cron sends the cron secret, not a user's token. The flag repeats it.
   ```sh
   npx -y supabase@2.119.0 functions deploy jobs --no-verify-jwt --use-api
   ```
   (`--use-api` bundles on Supabase's side, so Docker is not needed.)
6. **Tell the database where the function is, and its secret** (Vault). Run this once in the
   SQL editor with the real values. To rotate later, use
   `vault.update_secret((select id from vault.secrets where name = 'br_jobs_cron_secret'), '<new>')`
   together with step 4.
   ```sql
   select vault.create_secret('https://<ref>.supabase.co/functions/v1/jobs', 'br_jobs_function_url');
   select vault.create_secret('<the JOBS_CRON_SECRET value>', 'br_jobs_cron_secret');
   ```
7. **Check it:**
   ```sh
   curl -sS -X POST "https://<ref>.supabase.co/functions/v1/jobs?wait=1" -H "x-br-cron-secret: $JOBS_CRON_SECRET"
   # → 200 {"run":"…","stoppedBy":"empty","jobs":[…]}; 401 without the secret
   ```
   Then play a solo battle. Within a minute of RESULTS its screenshot should be `captured`
   (`/admin` → Health: "Screenshots, last 24 h"), and the function's logs (Edge Functions →
   `jobs` → Logs) show `capture.rendered` with `browserMs`. pg_cron's own calls:
   ```sql
   select r.status_code, r.content, r.created from net._http_response r order by r.created desc limit 5;
   select day, used_ms, renders, refused, rate_limited from private.browser_budget order by day desc limit 7;
   ```

**The self-hosted worker instead** (a paid plan or your own machine: `apps/capture-worker`,
Playwright + sharp, no daily budget): stop the trigger with
`select cron.unschedule('br-jobs-run');`, then run the worker with its `.env`
(`apps/capture-worker/README.md`). To switch back, run
`select cron.schedule('br-jobs-run', '* * * * *', 'select private.run_jobs_function()');`.
The two can also run side by side; `claim_job` hands each job to one of them.

## Custom domain

1. Workers & Pages → `build-roulette-web` → Settings → Domains & Routes → Add → Custom
   domain. A Worker's custom domain must be a domain on Cloudflare (a zone of account A); it
   gets its DNS record and certificate automatically. (Not tried here: no account.)
2. Build with `NEXT_PUBLIC_SITE_URL` set to that origin (absolute `og:image` URLs, through
   `metadataBase` in `src/app/layout.tsx`, and the link previews' `og:url` and canonical
   link), and add it to the sandbox shell's `BR_APP_ORIGINS`; with the Deploy workflow, set
   `APP_URL` and run **all**.
3. Optional: turn the workers.dev address off (`workers_dev: false` in `wrangler.jsonc`), so
   there is one canonical address.

## Security model (what moved where in T-037)

- **The pages are public files.** Anyone can load `/admin`'s script; it holds nothing
  secret. What any page shows comes from Supabase with the visitor's own credentials:
  the anon key for the public pages, a player's anonymous session for the game, a
  moderator's session for `/admin`. Row-level security, the RPC guards and `is_admin()` in
  every admin RPC decide, as before T-037.
- **Admins** sign in in the browser (email + password through supabase-js) into a session
  kept apart from the player's: its own client and storage key, in that tab's
  `sessionStorage` only, never broadcast to other tabs; sign-out revokes it at Supabase Auth.
  The trade-off against T-024's httpOnly cookies is written up in `apps/web/README.md`
  ("Moderation"). Protect `/admin/sign-in` with Supabase Auth's own rate limits and CAPTCHA
  (Turnstile covers password sign-ins too when it is on).
- **Headers** (`out/_headers`): `Content-Security-Policy` with `script-src 'self'` plus the
  SHA-256 of each exported page's inline scripts (no `'unsafe-inline'`, and no
  `'wasm-unsafe-eval'` since M6), `connect-src` / `img-src` / `frame-src` limited to the
  configured hosts, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`; also
  `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy:
  strict-origin-when-cross-origin`, a `Permissions-Policy` that refuses camera, microphone,
  geolocation and the like, `Cross-Origin-Opener-Policy: same-origin` and HSTS. `_headers`
  does not apply to a response the Worker builds itself (it does to the shell the Worker gets
  through `env.ASSETS`), so the link-preview Worker sets the same `/*` headers on its own
  answers (baked in at build time; the e2e check the headers on the Worker's answers under
  `wrangler dev`).
- **The link previews write user data into HTML** (build names, player names, challenge
  texts): every value is HTML-escaped and the tags are written by our code, never parsed from
  the data (`src/lib/hosting/battle-preview.ts`; unit tests try `"><script>` and friends, the
  e2e a real build named that way). They are `<meta>`/`<title>`/`<link>` tags, not scripts:
  the CSP is unchanged.
- **What the app origin never serves:** user-generated HTML or scripts. Builds run on the
  sandbox site (another site, its own CSP), and results show only text and screenshots.

## Observability (T-030)

Error reporting (Sentry) and product analytics (PostHog) are **off until you configure
them**: without the variables below no SDK is loaded, no listener is installed and nothing
is sent (checked by `pnpm --filter @br/web test:e2e:telemetry`). What is sent, and what never
is, is in `apps/web/README.md` "Observability" and `packages/telemetry/src/scrub.ts`. Since
T-037 every web event is the browser's: there is no server to report from.

### Accounts

1. **Sentry** (<https://sentry.io>, the free Developer plan is enough; pick the EU data
   region if you prefer). Create one project, platform *JavaScript*: browser errors and the
   capture worker both report to it, told apart by the `service` and
   `runtime` tags. Copy its DSN (Project → Settings → Client Keys). Then, in Project →
   Settings:
   - Security & Privacy: turn on **Prevent Storing of IP Addresses**; keep the default data
     scrubbers on;
   - Client Keys → the key → **Allowed Domains**: your app origin (the DSN is public by
     design; this stops other sites from posting to it).
2. **PostHog** (<https://posthog.com>, EU Cloud recommended). Create a project and copy its
   **Project API key** (`phc_…`). Project settings: turn on **Discard client IP data**. The
   app does not use posthog-js, so autocapture, session replay and surveys never run; leave
   them off.

### Variables (all at build time)

| Variable | What |
|---|---|
| `NEXT_PUBLIC_SENTRY_DSN` | browser error reporting (its ingest host joins the CSP's `connect-src`) |
| `NEXT_PUBLIC_SENTRY_ENVIRONMENT` | optional, default `production` (e.g. `staging`) |
| `NEXT_PUBLIC_POSTHOG_KEY` | product analytics |
| `NEXT_PUBLIC_POSTHOG_HOST` | default `https://eu.i.posthog.com`; `https://us.i.posthog.com` for a US project |
| `BR_RELEASE` | optional; default the git commit (`build-roulette-web@<sha>` in Sentry) |
| `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE` | **not the web app's**: the self-hosted capture worker's runtime settings (`apps/capture-worker/.env.example`) |

```sh
NEXT_PUBLIC_SENTRY_DSN=https://<key>@<org>.ingest.de.sentry.io/<project> \
NEXT_PUBLIC_POSTHOG_KEY=phc_<key> \
NEXT_PUBLIC_POSTHOG_HOST=https://eu.i.posthog.com \
  pnpm --filter @br/web build        # plus the variables of "Deploying"
pnpm --filter @br/web workers:deploy
```

### Check it after a deploy

- `/admin` → Health → **Send a test error to Sentry**: the page throws "Build Roulette test
  error (thrown from /admin on purpose)" from its own code; Sentry shows it within a minute
  with `runtime: browser` and `route: /admin`. "Error reporting is off in this build" means
  the build had no usable `NEXT_PUBLIC_SENTRY_DSN`.
- Create a room: PostHog → Activity shows `room_created` and `room_joined` within seconds,
  with a 32-character `distinct_id` and no person profile.

### Not done (yet)

- Source maps are not uploaded, so browser stack traces in Sentry point into minified chunks.
  Uploading them needs a Sentry auth token at build time (`sentry-cli sourcemaps upload` on
  `out/_next/static`); add it when the traces are needed.
- No Sentry alerts are created by the code: add an alert rule on new issues for
  `runtime:browser` and on `service:capture-worker` `claim.failed`.

## Caching

There is no app cache to manage any more (T-026's ISR, R2, D1 and Durable Object queue are
gone with the server):

- HTML pages are served with the static assets' default `Cache-Control: public, max-age=0,
  must-revalidate` (browsers revalidate them on every load; Pages had the same);
  `/_next/static/*` is content-hashed and cached for a year (`_headers`). A deploy is visible
  at once.
- `/battles/{id}` is answered by the link-preview Worker with the same `Cache-Control` and
  no ETag, and it caches nothing: every request reads `get_public_battle`, so **a preview
  follows a takedown on the very next request** (no lag on our side). Why no cache, and what
  one would cost: docs/08-free-tier.md §3.4.
- The public pages read `get_public_battle` / `get_player_history` in the browser on every
  load, with `cache: 'no-store'`: **a takedown shows on the very next page load**, whether it
  was made in `/admin` or with SQL. Nothing needs revalidating.
- What can still show a removed build for a while: its screenshot file, until the capture
  worker's takedown job deletes it (seconds), plus up to 5 minutes in browsers and
  Supabase's CDN (the upload's `max-age=300`); and link previews that social networks cached
  on their side (from minutes to days; most have a refresh tool).
  docs/runbooks/removed-content-still-visible.md has the checks.

## Limits to keep in mind (Workers Free, static assets)

Which of these are confirmed in wrangler's source or `wrangler dev`, and which come from
Cloudflare's docs: docs/08-free-tier.md §2.7.

| Limit | Value | Us today |
|---|---|---|
| Requests to static files | unlimited, free, not Worker invocations | every request but `/battles/*` |
| Worker requests | 100,000 a day, shared with every Worker of account A; then Cloudflare's 429 page on `/battles/*` until 00:00 UTC | one per view of `/battles/{id}` (people and crawlers) |
| CPU per Worker request | 10 ms (Workers Free) | median 1.2–1.7 ms warm, 3.2–4.2 ms in a fresh isolate (docs/08 §3.3) |
| `run_worker_first` | path patterns in `wrangler.jsonc` | 1 pattern |
| Files per version | 20,000 | 87 |
| One file | 25 MiB | the largest JS chunk, ~240 KiB |
| `_headers` | 100 rules, 2,000 characters per header line | 4 rules; the CSP line is ~950 characters (10 script hashes), checked by the build |
| `_redirects` | 2,000 static + 100 dynamic rules | 1 static, 3 dynamic |

Link previews per battle (each battle's own title and screenshot in `og:*`) come from the
Worker above; the other shells (`/r/{code}`, `/u/{id}`) keep the generic tags and
`og-card.png`.
