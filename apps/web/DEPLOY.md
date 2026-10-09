# Deploying `@br/web` to Cloudflare Pages (free)

The web app is a **static site** (T-037, the user's option C after T-033: Next.js on Workers
Free does not fit the 10 ms CPU limit, docs/08-free-tier.md). `next build` exports every page
as a file (`output: 'export'`) into `apps/web/out/`, and **Cloudflare Pages** serves those
files. No server and no Worker run for the app: static requests are free, unlimited, and are
not Worker invocations. Everything else happens in the browser, against Supabase.

What a deploy uploads (`apps/web/out/`, measured on 2026-10-09):

| | |
|---|---|
| Pages | `/`, `/play`, `/playground`, `/admin`, `/admin/sign-in`, `404.html`, and three **shells**: `/r` (every room), `/battles` (every battle's results), `/u` (every player's history) |
| `_redirects` | `/r/:code /r 200`, `/battles/:id /battles 200`, `/u/:id /u 200`: rewrites, so `/battles/{id}` is answered with the shell and keeps its URL; the page reads the id in the browser and loads its data (`src/lib/hosting/shells.ts`) |
| `_headers` | the security headers (a Content-Security-Policy, no framing, `nosniff`, referrer and permissions policies), a year's cache for `/_next/static/*`, `noindex` for `/admin` (`src/lib/hosting/pages-config.ts`) |
| Assets | JS/CSS chunks, the bundler worker chunk, `esbuild.wasm` (13.3 MiB), `og-card.png`, `icon.svg` |
| Size | 94 files, 15.8 MiB; JS 2.1 MiB (706 KiB gzip) |

`pnpm build` runs `next build` and then `scripts/pages-config.ts`, which writes `_headers` and
`_redirects` and **fails the build** if `404.html` or a shell is missing, if any file holds a
Supabase key other than the public anon key (a service-role or user JWT, an `sb_secret_` key,
or the value of `SUPABASE_SERVICE_ROLE_KEY` / `SERVICE_ROLE_KEY` / `SUPABASE_SECRET_KEY` from
the build's environment), or if a Pages limit would be exceeded. It prints the export's size.

Everything below runs from the repository root. Nothing here is needed for local work.

## Try it locally first (no account needed)

```sh
pnpm --filter @br/web build        # next build + _headers/_redirects → apps/web/out/
pnpm --filter @br/web preview      # wrangler pages dev: http://localhost:3000
```

`preview` is `wrangler pages dev` (Cloudflare's local Pages server, on workerd): the same
rewrites, headers and 404 handling as production. Every e2e suite runs against it
(`e2e/app-server.ts`). `/playground` and `/play` also need the sandbox servers
(`pnpm --filter @br/web dev:sandbox`, or `dev:solo`'s services), and every page that reads
data needs the local Supabase stack (`supabase/README.md`).

Wrangler prints `Unable to fetch the Request.cf object` when it cannot reach
`workers.cloudflare.com` (for example behind a proxy): harmless, it falls back to placeholder
geo data.

## One-time setup

1. **A Cloudflare account** (<https://dash.cloudflare.com/sign-up>). The **Free plan** is
   enough: Pages has no paid feature this app uses.
2. **Log in from your machine** (opens a browser once):
   ```sh
   pnpm --filter @br/web exec wrangler login
   ```
   For CI, create an API token instead (My Profile → API Tokens → Create Token → "Edit
   Cloudflare Workers" template, which includes Pages) and set `CLOUDFLARE_API_TOKEN` and
   `CLOUDFLARE_ACCOUNT_ID` as CI secrets. The account id is on the Workers & Pages overview.
3. **Create the Pages project** (Direct Upload: you build, wrangler uploads):
   ```sh
   pnpm --filter @br/web exec wrangler pages project create build-roulette-web --production-branch main
   ```
   The name is `name` in `apps/web/wrangler.jsonc`; it becomes the free address
   `https://build-roulette-web.pages.dev` (Cloudflare adds a suffix if the name is taken: use
   what it prints). `apps/web/wrangler.jsonc` is the project's configuration from then on
   (`pages_build_output_dir: ./out`, the compatibility date); Cloudflare shows those settings
   read-only in the dashboard.
4. **The sandbox shell must allow the app's origin.** It bakes the origins that may frame it
   into its CSP and its `postMessage` checks at build time: build it with
   `BR_APP_ORIGINS=https://build-roulette-web.pages.dev` (and the custom domain, if any,
   comma-separated): `apps/sandbox-shell/scripts/build.ts`.

## Deploying

```sh
NEXT_PUBLIC_SUPABASE_URL=https://<project>.supabase.co \
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon or publishable key> \
NEXT_PUBLIC_SANDBOX_SHELL_URL=https://<sandbox>.pages.dev/v1/ \
NEXT_PUBLIC_PKG_CDN_URL=https://<package-cdn-host> \
NEXT_PUBLIC_SITE_URL=https://build-roulette-web.pages.dev \
  pnpm --filter @br/web build
pnpm --filter @br/web pages:deploy --branch main
```

- `pages:deploy` is `wrangler pages deploy` (it uploads `out/` as the config says). With
  `--branch main` (the production branch of step 3) it goes live on the project's address and
  custom domains; any other `--branch` makes a preview deployment on its own
  `https://<hash>.build-roulette-web.pages.dev` address (the sandbox shell does not allow
  preview origins unless you add them to `BR_APP_ORIGINS`, so `/play` and `/playground` only
  work on production there).
- **Every setting is baked in at build time.** `NEXT_PUBLIC_*` values are inlined into the
  bundles, and the build's `_headers` allows exactly those hosts in its CSP (Supabase, the
  sandbox shell, the package CDN, Sentry, PostHog, Turnstile). There are no runtime variables
  or secrets in the Pages project: change a value, build again, deploy again. Without them
  the build points at the local stack and the local dev servers.
- The anon/publishable key is public by design. **No secret goes into this build**: the
  service-role key and the Turnstile secret belong to Supabase and the capture worker, never
  to the web app (`pages-config.ts` refuses to finish a build that contains one).
- **Rollback:** Workers & Pages → `build-roulette-web` → Deployments → a previous production
  deployment → "Rollback to this deployment" (instant), or deploy an older build again.
- **Cloudflare's Git integration** (Cloudflare builds on every push) also works in principle:
  build command `pnpm --filter @br/web build`, build output directory `apps/web/out`, root
  directory the repository root, the `NEXT_PUBLIC_*` values as build environment variables,
  and `NODE_VERSION=22`. Not tested here (no account); Direct Upload above is the path this
  repository is set up for. Git builds count toward Pages Free's 500 builds a month.

## Custom domain

1. Workers & Pages → `build-roulette-web` → Custom domains → Set up a custom domain. A domain
   on Cloudflare gets its DNS record and certificate automatically; for a domain elsewhere,
   add the `CNAME` to `build-roulette-web.pages.dev` that the dashboard shows.
2. Build with `NEXT_PUBLIC_SITE_URL` set to that origin (absolute `og:image` URLs, through
   `metadataBase` in `src/app/layout.tsx`), and add it to the sandbox shell's `BR_APP_ORIGINS`.
3. Optional: a Bulk Redirect from `build-roulette-web.pages.dev` to the custom domain, so
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
- **Headers** (`out/_headers`): `Content-Security-Policy` with `script-src 'self'
  'wasm-unsafe-eval'` plus the SHA-256 of each exported page's inline scripts (no
  `'unsafe-inline'`), `connect-src` / `img-src` / `frame-src` limited to the configured hosts,
  `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`; also
  `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy:
  strict-origin-when-cross-origin`, a `Permissions-Policy` that refuses camera, microphone,
  geolocation and the like, `Cross-Origin-Opener-Policy: same-origin` and HSTS. Pages also
  adds `Access-Control-Allow-Origin: *` to static files by default: harmless here, every file
  is public.
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
   region if you prefer). Create one project, platform *JavaScript*: browser errors, the
   capture worker and the package CDN all report to it, told apart by the `service` and
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
| `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE` | **not the web app's**: the capture worker's and the package CDN's runtime settings (`apps/capture-worker/.env.example`, `apps/pkg-cdn/README.md`) |

```sh
NEXT_PUBLIC_SENTRY_DSN=https://<key>@<org>.ingest.de.sentry.io/<project> \
NEXT_PUBLIC_POSTHOG_KEY=phc_<key> \
NEXT_PUBLIC_POSTHOG_HOST=https://eu.i.posthog.com \
  pnpm --filter @br/web build        # plus the variables of "Deploying"
pnpm --filter @br/web pages:deploy --branch main
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

- HTML pages are served with Pages' default `Cache-Control: public, max-age=0,
  must-revalidate` (browsers revalidate them on every load); `/_next/static/*` is
  content-hashed and cached for a year (`_headers`). A deploy is visible at once.
- The public pages read `get_public_battle` / `get_player_history` in the browser on every
  load, with `cache: 'no-store'`: **a takedown shows on the very next page load**, whether it
  was made in `/admin` or with SQL. Nothing needs revalidating.
- What can still show a removed build for a while: its screenshot file, until the capture
  worker's takedown job deletes it (seconds), plus up to 5 minutes in browsers and
  Supabase's CDN (the upload's `max-age=300`); and link previews that social networks cached
  on their side. docs/runbooks/removed-content-still-visible.md has the checks.

## Limits to keep in mind (Pages Free)

| Limit | Value | Us today |
|---|---|---|
| Requests to static files | unlimited, free, not Worker invocations | every request |
| Files per deployment | 20,000 | 94 |
| One file | 25 MiB | `esbuild.wasm` 13.3 MiB |
| `_headers` | 100 rules, 2,000 characters per header line | 4 rules; the CSP line is ~950 characters (10 script hashes), checked by the build |
| `_redirects` | 2,000 static + 100 dynamic rules | 3 dynamic |
| Builds (Git integration only) | 500 a month | Direct Upload: none |
| Custom domains | 100 per project | 0–1 |

Link previews per battle (each battle's own title and screenshot in `og:*`) need code at the
edge: a Pages Function on `/battles/*` is T-038, measured against Workers Free's 10 ms
first. Until then every shell carries the generic tags and `og-card.png`.
