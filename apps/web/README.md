# @br/web

The Next.js app (App Router), exported as static files (`output: 'export'`) and served as the
static assets of a Cloudflare Worker on `workers.dev` (T-037, T-043; Cloudflare Pages until
T-043; [DEPLOY.md](DEPLOY.md)). There is no server: every page is a file,
and data loads in the browser from Supabase. Routes:

| Route | What |
|---|---|
| `/` | Landing page: the pitch, "Play solo" (`/play`), "Create room" (a name → `create_room` → `/r/{code}`) and "Join with code" (any case, trimmed, or a pasted invite link), "How it works" and "Try an import", then the four steps of a battle as cards. |
| `/play` | The solo game: name → SPIN → BUILD → SHIP → RESULTS → DESTROY. `?battle={id}` resumes a battle after a refresh. |
| `/battles/[id]` | The permanent, shareable results page. One static shell for every battle (`src/app/battles/page.tsx`, "Static site" below): the browser reads the id from the URL and calls `get_public_battle` on every load, so a takedown shows on the next load. The Worker's code (a Pages Function until T-043) serves the shell with each battle's own link preview, and a real 404 for an unknown battle ("Link previews" below). |
| `/try` | "Try an import" (M6, docs/09 §9.5): the BUILD stage's drop zone and live preview without a battle, an account or an upload. The practice page the onboarding links to. `/playground` (the editor's old page) redirects here with a 301 (`REDIRECTS` in `src/lib/hosting/shells.ts`, written to `_redirects`). |
| `/how-it-works` | The guide (T-049, docs/09 §9.6): the game in one minute, the rules for a site (`SITE_LIMITS`), a checklist, tool guides (tabs), a line to add to the prompt (Copy), where each framework writes its build, troubleshooting and a FAQ. A plain static page. |
| `/r/[code]` | A room (M3): join → lobby → SPIN → BUILD → SHIP → REVEAL → VOTE → RESULTS → DESTROY → lobby (rematch). One static shell (`src/app/r/page.tsx`) serves every room: the host rewrites `/r/{code}` to it and the code is read in the browser (T-033, T-037). |
| `/u/[id]` | A player's history (M4): their finished battles, newest first, from `get_player_history` with the anon key, paginated (`?before=…&before_battle=…`). One static shell (`src/app/u/page.tsx`); the browser reads the id and the cursor from the URL and the data on every load. |
| `/admin` | Moderation (M5, T-024), in the browser with the moderator's own session ("Moderation" below): the report queue (dismiss, take down), the battle / room event logs (`?q={battle id or room code}`), the admin log, and **Health** (T-030: `admin_ops_health`, the signals of docs/runbooks/). **The plain "not found" screen for everyone who is not a signed-in admin.** |
| `/admin/sign-in` | The moderators' email/password sign-in (not linked, not indexed). |

## Static site (T-037)

`next build` exports the app to `out/` (`next.config.ts`: `output: 'export'`), then
`scripts/pages-config.ts` adds the host's files and checks the export
(docs/08-free-tier.md §2 has the why and the trade-offs):

- **Shells.** `/r/{code}`, `/battles/{id}` and `/u/{id}` are one exported page each
  (`out/r.html`, `out/battles.html`, `out/u.html`). `out/_redirects` rewrites every such path
  to its shell with status 200, so the URL stays; the page reads its parameter from the
  browser's URL (`src/lib/hosting/shells.ts`, `use-browser-url.ts`) and loads its data
  (`use-remote.ts`): loading, the page, "not found" (a 404-style screen, served with a 200;
  `/battles/{id}` answers a real 404, below), or "could not load" with a retry. The tab title
  is a React `<title>` (`components/DocumentTitle.tsx`; those pages' metadata sets none).
  `next dev` applies the same rewrites (`next.config.ts`, development only).
- **Links to a shell are page loads** (`<a>`, `lib/hosting/navigate.ts`): Next's client
  router would fetch `{path}.txt`, which a shell path does not have.
- **No cache.** The public pages call `get_public_battle` / `get_player_history` with
  `cache: 'no-store'` on every load, so a takedown, made in `/admin` or with SQL, shows on the
  next load. T-026's ISR (R2, D1, the Durable Object queue, `lib/cache/policy.ts`) is gone.
- **Headers** (`out/_headers`, `src/lib/hosting/pages-config.ts`): a Content-Security-Policy
  whose `script-src` lists the SHA-256 of the exported pages' inline scripts (no
  `'unsafe-inline'`) and whose other sources are this build's `NEXT_PUBLIC_*` hosts,
  `frame-ancestors 'none'`, `X-Frame-Options`, `nosniff`, the referrer and permissions
  policies, COOP, HSTS; a year's cache for `/_next/static/*`; `noindex` for `/admin`.
- **Checks** (the build fails): `404.html` and every shell exist; no file holds a Supabase key
  other than the public anon key; the host's limits (header lines ≤ 2,000 characters, rules,
  file count and size); the link import's test-only origins never reach a real build
  (`NEXT_PUBLIC_IMPORT_URL_TEST_ORIGINS` with a Supabase that is not local, or a host that is
  not a local test host, fails; so does a build without it whose files still hold
  `host.docker.internal`, "Import from a link" below).
- **Locally:** `pnpm --filter @br/web preview` serves `out/` and the Worker with `wrangler dev`
  (http://localhost:3000), which applies `_redirects` and `_headers` and runs the link-preview
  Worker for `/battles/*` like production. Every e2e suite uses it.

## Link previews (T-038)

Crawlers (Slack, Discord, X, Facebook…) do not run the page's script, so a static shell alone
would give every battle the same preview. The Worker's code on `/battles/*` fixes that (a
Pages Function until T-043, "the Function" below; docs/08-free-tier.md §3 has the design and
its CPU numbers):

- **Where:** `src/lib/hosting/preview-worker.ts` (the worker entry: the static assets,
  `get_public_battle`, `HTMLRewriter`), `preview-handler.ts` (what it does per request, tested
  in Node), `battle-preview.ts` (the head: pure, tested). `scripts/preview-worker.ts` bundles
  it into `dist/worker.js` (`main` of `wrangler.jsonc`) with the build's `NEXT_PUBLIC_*` values
  and the `/*` headers of `_headers`; `run_worker_first: ["/battles/*"]` in `wrangler.jsonc`
  limits it to `/battles/*`.
- **Per request:** `get_public_battle` with the anon key (the page's own call,
  `lib/solo/public-battle.ts`) and the shell (`/battles`) at once; then the shell with its
  title, description, `og:*` (`og:url`, `og:image` with its size and type), `twitter:*` and
  canonical link replaced by the battle's (`HTMLRewriter`):
  - title: "{rank-1 build} by {builder}", or "{challenge} · Battle results" when rank 1 was
    taken down; description: "Winner: {build} by {builder}." (unless taken down: nobody is
    promoted, T-028) and the challenge's BUILD / RULE / STYLE and time limit;
  - image: the rank-1 screenshot from Storage, or `og-card.png` when rank 1 has none or was
    taken down (`lib/solo/og-image.ts`, T-033; never the next build's);
  - an unknown or not-yet-public battle: status **404** with "Battle not found" and `noindex`
    (still the shell: the browser shows its not-found view); a malformed id: the same 404
    without asking Supabase;
  - **fail open:** Supabase slower than 1.5 s, an error or an odd answer: the shell
    unchanged with 200 (the generic head). Anything else that throws: the static assets'
    plain answer.
- **Escaping:** names and challenge texts are HTML-escaped; the tags are our own strings
  (unit tests round-trip `"><script>` and friends through an HTML parser).
- **Headers:** the Function's answers carry the `_headers` security headers (it sets them
  itself), keep `Cache-Control: max-age=0, must-revalidate`, drop the ETag, and add
  `x-br-preview` (`battle`, `not-found`, `malformed`, `fail-open; reason=…`).
- **No cache:** a takedown changes the preview on the next request.
- **In the browser** the page then hydrates as before; React re-adds the shell's generic
  `og:*` tags after the battle's ones (it matches head tags by content). Only crawlers read
  them, and they read the HTML as sent: the battle's tags come first and are the only ones
  there.
- **Tests:** `src/lib/hosting/*.test.ts`; `e2e/link-preview.spec.ts` (in
  `test:e2e:moderation`: a crawler-style request, 404s, Supabase slow/down on a variant site
  from `scripts/preview-variant.ts`); `moderation.spec.ts` (the preview right after the
  takedown of rank 1); `solo.spec.ts`, `multiplayer.spec.ts` (the rank-1 screenshot as
  `og:image`).
- **CPU:** `pnpm --filter @br/web measure:cpu` (needs the build and the local stack).

## Observability (T-030)

Error reporting (Sentry) and product analytics (PostHog), both **off unless configured**
(DEPLOY.md "Observability" has the setup; `src/lib/telemetry/`):

- **Browser errors:** `src/instrumentation-client.ts` starts `client-errors.ts` only with
  `NEXT_PUBLIC_SENTRY_DSN`: two listeners keep the page's first errors, and when the browser
  is idle the Sentry chunk (`sentry-browser.ts`, ~28 KiB gzip, never loaded without a DSN)
  takes over with an allowlist of integrations (no breadcrumbs, no console, no session
  pings, no `addEventListener` wrapping) and `allowUrls` = the page's own origin, so the
  sandbox iframe's errors (another origin) and build code can never be reported.
  `app/global-error.tsx` reports render errors the window never sees.
- **No server errors** since T-037: the app is a static site. (`@br/telemetry`'s server
  reporter on `@sentry/core` stays, for the capture worker.)
- **Privacy:** every event goes through `scrubSentryEvent` (`packages/telemetry`): no query
  strings or fragments, route templates instead of paths (`/r/[code]`), UUIDs, emails and
  tokens masked in messages, no breadcrumbs, `extra`, cookies, headers or bodies; the user is
  `hashUserId(anonymous user id)` (32 hex) and only when Do Not Track / GPC is off. Tags:
  `phase`, `mode`, `room_id`, `battle_id` (random UUIDs), `route`, the release.
- **Analytics:** `analytics.ts`, a typed event module posting to PostHog's capture API (no
  SDK): `room_created`, `room_joined`, `battle_started`, `rematch`, `build_shipped`
  (manual/auto), `vote_cast`, `battle_completed`, `report_filed`, and `sync_health` once per
  battle and client from the sync engine's counters (`RoomSync.stats`: missed events,
  refetches, gaps, degraded time, rejoins, server-closed channels, channel errors). No
  autocapture, no replay, no cookies or storage, no person profiles; off with DNT/GPC.
- **Sandbox health (T-031):** `lib/telemetry/sandbox-health.ts`. Every preview watchdog
  crash is a `preview_crash` event (reason, phase, the app-awake and wall-clock silences, the
  app's own stall during it, `live`/`reveal`, whether the user restarted it), sent once that
  outcome is known (a restart, the preview going away, or `pagehide`). `sync_health` adds
  this tab's preview counts for the battle: crashes, restarts, app stalls of 1 s or more and
  their total, and `preview_spared` (silences the pre-T-031 watchdog would have called a
  crash). Only the battle UUID, enums and numbers: no build code, console output or names.
- **Imports (M6, M7):** every import of a built site is a `site_import` event: the battle
  (null on `/try`), `source` (`drop`, `folder`, `zip` or `link`; `via` until T-052), the
  `outcome` (`ok`, `error`, or `cancelled` for a link's copy the player stopped) and, for a
  refused import, the error code (`not_built`, `no_index`, `too_large`, `url_private`,
  `rate_limited`, …). Never a file or folder name, a link or its host, a size or anything from
  the site (`src/lib/site/use-site-import.ts`).
- `/admin` → Health has "Send a test error to Sentry": it throws an uncaught error from the
  page's own code, the path any app error takes (the window's handler, then Sentry with the
  page's tags); with no DSN in the build it says reporting is off.

## Moderation (T-024)

- **Report:** a "⚑ Report" button on the REVEAL spotlight chrome (next to "Skip this
  build"; the dialog's "hide it for me" is that skip), on other players' RESULTS cards and
  on `/battles/[id]` (`src/components/moderation/ReportButton.tsx`). A small dialog: the
  five reasons, optional details (500 characters), a thank-you state. A visitor without a
  session is signed in anonymously first (`report_build` needs a user).
- **Removed by moderators:** a taken-down build shows that label instead of its name and
  screenshot everywhere (`/battles/[id]`, RESULTS, the REVEAL spotlight and strip, where it
  never runs, `/u/[id]`, the `og:image`). The rank, time and votes stay. Removed after
  RESULTS (T-028), it also has no Winner banner, gold ring, medal or awards, and nobody
  inherits them: if it was rank 1, no build is the winner (`isWinner`, `awardsOf` and
  `rankMedal` in `src/lib/solo/format.ts`), and the battle's `og:image` is the static card,
  not the next build's screenshot (`src/lib/solo/og-image.ts`).
- **Admin** (client-side since T-037; `src/lib/admin/client.ts`, `src/components/admin/`):
  `/admin/sign-in` signs in with Supabase Auth (email + password, plus a Turnstile token when
  Turnstile is on) through **a supabase-js client of its own**; only an account that
  `is_admin()` accepts keeps the session (any other gets "These details cannot sign in here"
  and is signed out). The admin RPCs run with that session's own token: the app has no
  service key (the build checks), and Postgres decides (`is_admin()` in every admin RPC).
  Without an admin session `/admin` is the plain "not found" screen, and it asks nothing of
  the server.
  - **Kept apart from the player's session.** Players' anonymous sessions live in
    localStorage (`br-auth`, `lib/supabase/browser.ts`); signing a moderator in through that
    client would replace the player's session and send game RPCs with the moderator's
    token. The moderator's session is held in memory by its own client
    (`persistSession: false`) and mirrored into **this tab's sessionStorage**
    (`br-admin-auth`) on sign-in and every token refresh: a reload or a link inside `/admin`
    keeps it; another tab, or the tab after it is closed, does not have it. Not
    localStorage (it would outlive the tab and reach every tab of the origin), and not
    supabase-js's own persistence (it broadcasts every token refresh, session included, on
    a `BroadcastChannel` any page of the origin can read).
  - **Sign-out** revokes this session at Supabase Auth (its refresh token stops working; the
    account's sessions in other tabs or browsers stay) and removes it from memory and
    sessionStorage, then goes to `/`.
  - **The trade-off against T-024's httpOnly cookies:** script on the app origin (an XSS)
    could read a moderator's session in that tab, which it could not read from an httpOnly
    cookie. Against that: the app origin serves no user-generated HTML or script (builds run
    on the sandbox site; results are text and `<img>`), the CSP has no `'unsafe-inline'`
    script and limits `connect-src`, the page cannot be framed, the session lives for one
    tab, and sign-out revokes it. docs/08-free-tier.md §2.3 has the full argument.
  - Locally: `node supabase/scripts/seed-admin.mjs [email] [password]` (default
    `admin@buildroulette.local` / `local-admin-pw`), then open `/admin/sign-in`.
- **Name filter and rate limits:** `name_not_allowed` sends a room join back to the name
  prompt and shows "That name is not allowed here. Pick another one." on Create room, `/play`
  and the ship dialog; `rate_limited` shows the server's "Try again in …" sentence
  (`describeError`), and too many wrong room codes get their own join screen.
- **Turnstile:** with `NEXT_PUBLIC_TURNSTILE_SITE_KEY` set, `ensureSignedIn` gets a
  Turnstile token (an on-demand, interaction-only widget, `src/lib/supabase/turnstile.ts`)
  and passes it to `signInAnonymously({ options: { captchaToken } })`. Without it (local,
  tests) nothing loads.

## Play the solo game locally

You need Docker (for the local Supabase stack), Node 22 and pnpm. From the repository root:

```sh
pnpm install
pnpm --filter @br/web dev:solo     # then open http://localhost:3000/play
```

`dev:solo` (`scripts/solo-services.ts --next --start-stack`) runs, in one terminal:

| Piece | Where | Notes |
|---|---|---|
| Local Supabase stack | `http://127.0.0.1:54321` | Used if it is running, otherwise started with `supabase start -x …` (see [supabase/README.md](../../supabase/README.md)). In the cloud dev container, start `dockerd` first and set `SUPABASE_INTERNAL_IMAGE_REGISTRY=docker.io`. |
| Sandbox shell | `http://127.0.0.1:4321/v2/` | The preview (a different site from the app; protocol v2: the shell's site worker serves imported sites), plus the signed capture page `/v2/capture` with a random per-run HMAC secret. |
| Jobs (T-034) | (no port) | As in production: the `jobs` Edge Function (`supabase functions serve`), started by pg_cron every 2 s through pg_net (Vault holds its URL and secret), rendering through a local Browser Rendering stand-in on Playwright Chromium (port 4325). It screenshots shipped builds, deletes ephemeral files after DESTROY and taken-down screenshots. Needs the stack's Edge Runtime. `--worker` runs the self-hosted `@br/capture-worker` instead. |
| Next.js | `http://localhost:3000` | `next dev`, pointed at all of the above. |

Ctrl+C stops everything (the stack keeps running; stop it with
`npx -y supabase@2.119.0 stop --no-backup`). Without `--next`
(`pnpm --filter @br/web exec tsx scripts/solo-services.ts`) it runs only the services, e.g.
next to your own `next dev` or for the e2e.

The game, step by step:

1. **Name + Spin.** A random fun name is prefilled; `start_solo_battle` draws the challenge
   (10, 15 or 20 minutes when nobody chose; `BUILD_TIME_LIMITS_MINUTES` in `@br/game` are
   10/15/20/30/45). If you already have a running battle (`battle_in_progress`), you're
   offered to resume it.
2. **SPIN** (6 s). Three reels (BUILD, RULE, STYLE) and the time limit land on the server's
   cards. The BUILD screen is already mounted underneath, so its preview sandbox is connected
   by the time the build starts.
3. **BUILD** (import mode, docs/09 §9.5). You build the site on your own computer with your
   own AI tools, run its build (`npm run build`; plain HTML needs none) and import the
   result: a challenge header with the hints, a countdown from server time (`server_now()`
   samples, `estimateClockOffset`, `remainingMs`) that turns amber at 1 minute and pulses red
   for the last 10 s, and a large **drop zone** ("Drop your built site here": the `dist`
   folder, the whole project folder or a .zip; **Choose folder** / **Choose .zip**; a drop
   anywhere on the page works, with a full-screen overlay). `@br/site` finds the site root,
   refuses source code with what to do next, and packs it. Then the site runs in the live
   preview, under a bar with what was imported (root folder, files, size, skipped) and
   **Import again**; Problems and Console sit in a collapsible panel. Every import is kept in
   IndexedDB (`br-sites`, key `battle:{id}`) and uploaded at once as `autosave/site.bin`
   (retried after 5, 10, 20, then every 30 s; tried again when the tab is hidden, 3 s before
   the deadline and in the SHIPPING grace). A reload brings the last import back (IndexedDB,
   else the remote autosave on another device).
4. **SHIP** (enabled once a site is imported). "Ship it? You can't import again after." with
   a build name. Then a client thumbnail of the preview (best effort), the uploads
   (`site.bin`, `thumb.webp`) and `ship_build` with stats `{files, bundle_bytes, imports}`.
   Every error code of the RPC contract has a message (`src/lib/solo/errors.ts`).
5. **T-0.** Without a ship, imports close and the last import (`autosave/site.bin`) is
   auto-shipped by the server. The client nudges `advance_battle` at each deadline (0–500 ms jitter); a battle
   that does not move is nudged again after 5, 10, 20, then every 30 s, and RESULTS is not
   nudged while the screenshot is pending (T-029); pg_cron is the backstop.
6. **RESULTS.** The capture worker's screenshot, the completion time, the auto-awards
   (`speedrun`, `clutch_ship`), the challenge, the stats (files, size, imports), and the
   fallback/failed/DNF states. The shipped site runs in a **reveal-mode** preview for the
   60 s last look.
7. **DESTROY.** A short destroy animation, then the battle's site is deleted from IndexedDB
   and the preview iframe is wiped and removed. Links to the permanent page and "Play again".

## Play in a room locally (2–4 players on one machine)

Rooms need the local stack **with Realtime** (private channels, broadcasts from the
database, Presence). `dev:multi` is `dev:solo` that refuses to run without Realtime:

```sh
pnpm --filter @br/web dev:multi    # then open http://localhost:3000
```

Every browser *profile* is a separate anonymous player (the session is in localStorage), so
use a normal window plus a private/incognito window (and another browser for a third
player):

1. Window 1: **Create room**, pick a name. You land on `/r/K7QXM` as the host (👑).
2. **Copy invite link** and open it in window 2 (private). Pick a name, **Join the room**.
   Both lobbies show both players online (Presence) and "2/8 players".
3. Both click **Ready up**; the host clicks **Start battle**. Everyone sees the same reels,
   then BUILD with a sidebar of everyone's progress ("building…" until a player's first
   import, then "imported" with the number of imports, and "Ada shipped 'Snack Overflow' at
   3:12" badges). The activity is Presence (`{imported, imports}`), sent only during BUILD,
   only when it changes and at most every 15 s (T-029), so the sidebar can be up to ~15 s
   behind.
4. Ship, or wait for the deadline (10, 15 or 20 min, drawn by the server; force it with
   psql as in `e2e/multiplayer.spec.ts` if you are impatient).
5. **REVEAL.** Everyone (spectators too) watches the final builds one at a time, on the
   server's timeline: "Build 2 of 3", the name, the builder, the slot countdown, and the
   build running live in a labelled, reveal-mode frame. **Skip this build** stops it on
   your screen only (its thumbnail shows instead); a build that hangs is stopped by the
   watchdog the same way. The host has **Next build** and **Skip to the vote**.
6. **VOTE.** One pick per category (Best Build, Best Use of the Rule, Best Style, Most
   Chaotic), never your own build; change picks until the timer ends. "2/3 voted" for
   everyone; voting ends early once every present player has a full ballot.
7. **RESULTS** ranks every build by votes (Best Build, then all votes, then the earlier
   ship) with its votes per category, the category awards, the auto-awards and the winner
   highlighted; your own build for the last look; then DESTROY and everyone is back in the
   lobby. **Start the rematch** for the next battle.
8. A window that joins during a battle is a spectator (countdown and progress, no import;
   watches the reveal, cannot vote); the host can kick from the lobby; **Leave room**
   leaves (rejoin with the link).
9. **Host settings** (lobby, host only): max players, **Reveal and vote** on/off, the time
   per build in the reveal (Auto = 30–60 s by the number of builds, or 30–60 s) and the
   voting time (30 s–3 min). Everyone else sees a one-line summary.
10. **History:** every player name in RESULTS opens `/u/{id}` in a new tab; the lobby has
    "Your battle history", the solo results and `/battles/[id]` too (for a viewer with a
    session).

### Phones and tablets (M4: reveal and vote, not build)

A touch-primary device (`(hover: none) and (pointer: coarse)`, `src/lib/device.ts`) can
join, host, watch and vote; building needs a computer (players build with their own tools
and import the result, docs/09):

- **Lobby:** a note under "Ready up" says so before the battle.
- **BUILD:** a roster player on a phone gets the spectator view (countdown, everyone's
  progress) with a "Building needs a computer" notice and their battle state. Nothing is
  imported or autosaved there, so the build ends **DNF** at the deadline (the server has
  nothing to auto-ship). The notice explains that opening the room on a computer does not
  move the seat (each browser is its own anonymous player) and offers "Import on this device
  anyway" (a tablet that has the built site can). A phone that joins
  mid-battle is a spectator, as on desktop.
- **REVEAL:** each build shows its screenshot (or the ship-time thumbnail) first, with a
  big "Tap to run live" (docs/02 R2: mobile browsers do not always isolate cross-site
  frames, so running someone's build stays the viewer's choice); the host's Next / Skip
  to the vote sit in a bar fixed to the bottom of the screen.
- **VOTE:** one build per row (64 px+ tap targets), a sticky timer and progress.
- **RESULTS, lobby, `/u/[id]`, `/battles/[id]`:** single column, no sideways scrolling at
  390 px (checked by the mobile e2e).

### Votes are never silently lost

A pick the server cannot be reached for (offline, a dropped connection) stays on screen as
"Not saved yet · retrying", with a banner, and is sent again every 2 s and with every fresh
snapshot until it lands (`cast_vote` is an upsert, so a repeat is harmless). Picks that
never landed before VOTING ended, or arrived just after, are listed in RESULTS as "Not
counted". Rapid clicks in one category send one request at a time and end with the last
click.

If you started the stack yourself with `-x …,realtime,…` (as the capture CI job does), solo
still works but rooms do not: restart it without `realtime` in `-x`.

### Environment variables

All `NEXT_PUBLIC_*` values are inlined at build time (`pnpm build`), and the build's CSP
(`out/_headers`) allows exactly their hosts, so rebuild after changing them. There are no
runtime settings. The defaults are the local setup above.

| Variable | Default | What |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `http://127.0.0.1:54321` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | the local stack's demo anon key | Public anon key (JWT). `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (`sb_publishable_…`) works instead. |
| `NEXT_PUBLIC_SANDBOX_SHELL_URL` | `http://127.0.0.1:4321/v2/` | Sandbox shell (protocol v2) |
| `NEXT_PUBLIC_SITE_URL` | `http://localhost:3000` | The app's public origin (`metadataBase`: the absolute `og:image` URL of the static card) |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | unset (no Turnstile) | Cloudflare Turnstile site key for anonymous sign-ups. Set it only together with Turnstile in Supabase Auth (the matching secret), or every sign-up fails. |
| `NEXT_PUBLIC_SENTRY_DSN` | unset (no error reporting) | Sentry DSN for browser errors (the only errors: there is no server) |
| `NEXT_PUBLIC_SENTRY_ENVIRONMENT` | `production` | Sentry environment |
| `NEXT_PUBLIC_POSTHOG_KEY` | unset (no analytics) | PostHog project API key |
| `NEXT_PUBLIC_POSTHOG_HOST` | `https://eu.i.posthog.com` | PostHog ingest host (`https://us.i.posthog.com` for a US project) |
| `NEXT_PUBLIC_IMPORT_URL_TEST_ORIGINS` | unset | **Tests only.** Exact origins the link import's check accepts besides the public hosts (`http://host.docker.internal:4330`, the e2e fixture server). Set by `test:e2e:solo` and by `dev:solo` with `IMPORT_URL_TEST_HOSTS`; never in a deploy (the build refuses it unless Supabase is local). |
| `BR_RELEASE` | the git commit | The release reported with errors and events |

The web app never holds the service-role key: players sign in anonymously
(`signInAnonymously`), every write goes through RPCs and storage RLS, and the results page
reads `get_public_battle`, which the anon key may call. `/admin` calls the admin RPCs with
the moderator's own access token. `pnpm build` fails if any exported file holds a Supabase
key other than the anon key (`scripts/pages-config.ts`).

`scripts/solo-services.ts` reads: `BR_APP_ORIGINS` (app origins the shell accepts and the
`import-url` function's `APP_ORIGINS`, default `http://localhost:3000`),
`IMPORT_URL_TEST_HOSTS` (`host.docker.internal:4330`: a local fixture server the function may
copy from, honored on a local stack only; with `--next` the app gets the matching
`NEXT_PUBLIC_IMPORT_URL_TEST_ORIGINS`), `APP_PORT` (3000), `SHELL_PORT` (4321), `STAND_IN_PORT` (4325), `CAPTURE_HMAC_SECRET` (default: random per run), `BR_JOBS=worker`
(like `--worker`), `WORKER_IDLE_MAX_MS` (2000, `--worker` only), and the stack's `API_URL` /
`ANON_KEY` / `SERVICE_ROLE_KEY` / `DB_URL` (default: `supabase status -o env`).

## `/try` local setup

The preview runs on a different site from the app (docs/03 §3.5), so `/try` (and the BUILD
stage) needs the sandbox shell next to Next.js:

| Server | Default URL | Configured in the app by |
|---|---|---|
| Sandbox shell (`@br/sandbox-shell`) | `http://127.0.0.1:4321/v2/` | `NEXT_PUBLIC_SANDBOX_SHELL_URL` |

`127.0.0.1` and `localhost` are different sites, which gives the cross-site iframe the
production setup has.

```sh
# terminal 1: the shell, allowing the dev app origin
pnpm --filter @br/web dev:sandbox

# terminal 2: the app
pnpm --filter @br/web dev        # http://localhost:3000/try
```

The shell only talks to app origins it was built for: they are baked into `shell.js`
(postMessage target) and into its CSP `frame-ancestors`. `dev:sandbox` allows
`http://localhost:3000` by default. For another origin or port, set `BR_APP_ORIGINS`
(comma-separated), for example `BR_APP_ORIGINS=http://localhost:3100 pnpm --filter @br/web
dev:sandbox`. Port: `SHELL_PORT` (4321); if you change it, set `NEXT_PUBLIC_SANDBOX_SHELL_URL`
to match. It is inlined at build time, so rebuild after changing it.

If the shell is not running, or does not allow the app origin, the preview shows
"The preview could not start" after 10 s.

Imported sites need no package CDN: what a site loads from the internet (a CDN script, a
font), it loads itself, as on any static host.

### How an import runs

- `@br/site` reads what was picked or dropped (`importFiles`, `importDrop`; a .zip is read in
  the page with `fflate`), finds the site root (`dist/`, `build/`, `out/`, … or the shallowest
  `index.html`), refuses source code, a Next.js project without a static export and sites over
  `SITE_LIMITS` with a title and what to do next (`describeImportError`), and packs the site
  (`site.bin`).
- `src/lib/site/use-site-import.ts` runs one import (the drop is read inside its `drop`
  handler), `src/components/site/SiteWorkbench.tsx` is the drop zone, the pickers, the
  page-wide drop overlay, the "what was imported" bar and the preview, shared by the BUILD
  stage and `/try`. The words are in `src/components/site/copy.ts` (for T-050), and the drop
  zone has a `help` slot for the onboarding's "How do I import?" (T-049).
- `src/lib/preview/preview-controller.ts` (`PreviewController`) attaches the preview iframe at
  once and loads every pack into it (`PreviewHandle.load({site}, 'live')`); the shell serves it
  from its site worker (docs/09 §9.3). A site the shell cannot serve at all covers the
  preview with the reason; a file that fails to load or a runtime error goes to Problems.
- `/try`, `/play` and `/r/{code}` load their client code with `next/dynamic` (`ssr: false`),
  so other routes never download the import or the runtime.

### Import from a link (M7, T-052)

Players who build in a web builder (Lovable, Bolt, v0, Replit) publish the app there and paste
its public link instead of dropping a folder (docs/10). The server side is T-051's `import-url`
Edge Function (supabase/README.md "Import from a link").

- **Where:** under the drop zone's pickers on BUILD and `/try` ("…or paste the link of your
  published site", `<input type="url">`, **Import**, Enter submits; "Works with sites published
  on Lovable, Netlify, Vercel, GitHub Pages, Replit, Bolt…" and the full `IMPORT_URL_HOSTS` list
  on demand), and in the bar's **Import again** menu: "Copy again from <host>" (the last link,
  one click) and "Paste a link…" (a link row under the bar). `src/components/site/LinkForm.tsx`.
- **The check first:** `checkPublicUrl` from `@br/site` (the function's own rules): a bad link
  or another host fails at once, with no request at all.
- **The copy:** `src/lib/site/link-import.ts` posts the link to
  `{SUPABASE_URL}/functions/v1/import-url` with the player's access token, checks and counts
  the pack it answers (`unpackSite`), and hands it on as an `ImportedSite` whose `root` is the
  copied address. From there it is exactly a dropped folder: `useSiteImport` → `onImported` →
  the preview, and on BUILD the controller's `importSite` (IndexedDB, the autosave, the imports
  counter). The bar says "Copied from my-app.lovable.app".
- **While copying:** "Copying your site…" (a live status) with **Cancel** (an
  `AbortController`); the pickers and the field wait. A newer import (a drop, a pick) stops a
  running copy.
- **Errors:** every code has a title and what to do in both languages (`linkErrors` in the
  catalogs, typed by `LinkErrorCode`: the copy's codes, the function's `unauthenticated`,
  `origin-not-allowed`, `method-not-allowed`, `internal`, and `network` for no answer), shown
  under the field, which it describes (`aria-describedby`, `aria-invalid`).
- **The session:** BUILD already has one. `/try` loads `lib/supabase/browser` and signs in
  anonymously only when a link is imported (`supabaseLinkCopier`, a dynamic import): a folder
  or a .zip on `/try` still makes no Supabase request. A build with an empty
  `NEXT_PUBLIC_SUPABASE_URL` has no link field (`src/lib/site/link-config.ts`).
- **The last link** is kept in localStorage (`br:import-link:battle:{id}`, only the current
  battle's; `br:import-link:try` for `/try`; every access in try/catch,
  `src/lib/site/link-memory.ts`): the field starts with it and **Import again** offers it.
- **Test-only origins:** the public allowlist cannot reach a test server, so the solo e2e
  serves fixture sites on `0.0.0.0:4330` (`e2e/link-fixture.ts`), which the function in Docker
  reaches as `http://host.docker.internal:4330`. Both sides allow exactly that, for tests only:
  the function through `IMPORT_URL_TEST_HOSTS` (playwright.solo.config.ts → solo-services →
  `functions serve --env-file`; honored on a local stack only), the page through
  `NEXT_PUBLIC_IMPORT_URL_TEST_ORIGINS` in the `test:e2e:solo` build. `pnpm build` fails when
  that value is set for a Supabase that is not local, or when a build without it holds the
  test host (scripts/pages-config.ts). A plain `pnpm build` (every deploy) has neither.
- `--worker` (`BR_JOBS=worker`) runs no Edge Function, so links cannot be imported there.

## Onboarding (T-049)

New players are told how the game works where they arrive (docs/09 §9.6). Its words are in
the catalogs since T-050 ("Languages" below: `steps`, `stepArt`, `welcome`, `home`,
`lobbyHints`, `phone`, `importHelp`, `guide`), with the numbers from `@br/game` and
`@br/site`; `src/components/onboarding/copy.ts` keeps the paths, the steps' order and emojis
and the pictures' sample data.

- **Welcome screen** (`components/onboarding/Welcome.tsx`): a full-screen modal `<dialog>`
  with the four steps (spin, build it your way, build & drop, ship / reveal / vote), each with
  a small picture made of markup (`Steps.tsx`); Next / Back, step dots, Esc and "Skip", focus
  kept inside; the last step has "Practice first" (`/try`) and "Let's play", and every step
  "Read the full guide". It opens by itself on a first visit, and again from "How it works",
  only where it is mounted: the home page, `/play` before a battle (the name entry) and a
  room's lobby (its links open new tabs there). Never during a battle (the lobby unmounts, and
  a pending "How it works" with it), and never on `/battles/*`, `/u/*`, `/admin`, `/try` or the
  guide. Its status is `br:welcome` in localStorage (`new`, `skipped`, `done`;
  `src/lib/onboarding/welcome.ts`), kept in memory when storage is blocked.
- **"How it works"** on the home page, `/play` and the lobby reopens the welcome; on `/try` it
  is a link to the guide, and in the BUILD header a link in a new tab.
- **Lobby:** a "New here?" card until the welcome was seen to the end, a reminder to have the
  AI tool open before the spin, and the guide for phones (the lobby note and `DesktopNeeded`).
- **"How do I import?"** (`ImportHelp.tsx`): a closed `<details>` in the drop zone's `help` slot
  on BUILD and `/try` (since T-052 with a line for a published link; the welcome's step 3, the
  guide's "Web builders" tab and its troubleshooting say how to import a link too). An import error's "How do I fix this?" opens it, or the guide's
  troubleshooting in a new tab where the page has none (the bar over a running preview).
- **The e2e** starts every browser context with the welcome already seen (`e2e/welcome.ts`,
  `use.storageState` in each Playwright config); `e2e/onboarding.spec.ts` clears it.

## Languages (T-050)

The UI is **English by default**; a player can switch it to **Turkish** (docs/09 §9.7). It never
follows the browser's language: English stays until the player picks Turkish, and the choice
is remembered per browser.

- **Catalogs** (`src/lib/i18n/messages/`): `en.ts` is the source of truth, a typed object
  (`Messages = typeof en`); `tr.ts` is typed `Messages`, so TypeScript refuses a missing key,
  an extra key or a function with other arguments. Plurals and interpolation are functions
  (`files: (n) => …`). Backticks mark code; `Rich` (`src/components/i18n/Rich.tsx`) renders
  `**bold**` and `{slot}`s filled with React nodes (a name, a time), so each language puts
  them where its grammar wants. Codes from other packages are translated here, one entry per
  code and typed against their lists: `errors` (every `ErrorCode`, `describeError(e, t)`),
  `voteErrors`, `importErrors` (every `@br/site` `ImportErrorCode`; the English comes from
  `describeImportError`), `phases` (`PHASE_LABELS`), `voteCategories`, `reportReasons`.
- **Mechanism** (`src/lib/i18n/`): `locale.ts` (`Locale = 'en' | 'tr'`, the `br:locale`
  localStorage key, every access in try/catch), `store.ts` (the choice in memory, so blocked
  storage still switches for the page view; other tabs follow through `storage` events),
  `context.tsx` (`I18nProvider` in the root layout, `useT()` for the catalog, `useI18n()` for
  the locale and `setLocale`; without a provider, e.g. a unit test, everything is English),
  `format.ts` (`Intl`: sizes `1,2 MB`, dates in UTC, relative times `3 dk. önce`). Pure
  helpers take the catalog as an optional last argument and default to English
  (`describeError(e, t)`, `formatTimeLimit(s, t)`, `statsPhrases(stats, t, locale)`,
  `settingsSummary(settings, t)`); room toasts are data (`ToastMessage`) worded when shown
  (`toastText`), so a switch rewords them too.
- **The switch** (`src/components/i18n/LanguagePicker.tsx`): "EN / TR", a labelled group of
  two toggle buttons (`aria-pressed`, each language named in itself, `lang` set). Every
  player-facing page has one in its header or footer: home (top right), the welcome dialog,
  `/play` (name entry, BUILD header, results), rooms (lobby header, join / error / end
  screens, BUILD, spectator, REVEAL, VOTE and RESULTS headers), `/try`, `/how-it-works`,
  `/battles/*`, `/u/*`, the 404 page and the load-error screens. A switch re-renders in place:
  no navigation, no remount, so a running battle goes on (the preview iframe is only
  renamed, `PreviewController.setFrameTitle`; e2e `solo-language.spec.ts` checks the import,
  the site's own state and the countdown across a switch during BUILD).
- **Static export and the first paint:** pages are prerendered in English. An inline script
  in the root layout's `<head>` (`LOCALE_SCRIPT`) sets `<html lang="tr" data-locale="tr">`
  before the first paint when Turkish is stored, and `globals.css` keeps the page hidden until
  the provider has rendered Turkish (`data-locale-ready`; at most 1.5 s, then it shows anyway),
  so English never flashes. React hydrates in English (`useSyncExternalStore`'s server
  snapshot) and re-renders with the stored language: no hydration mismatch (the e2e fails on
  any console error). The script is a constant string, so the CSP lists its SHA-256 like Next's
  own inline scripts (`scripts/pages-config.ts`, no `'unsafe-inline'`).
- **Tab titles** follow the language everywhere: the shells (`/r`, `/battles`, `/u`) render
  their `<title>` (`DocumentTitle`), and `/play`, `/try`, `/how-it-works` and the 404 page now
  do too (`PageTitle`; their metadata sets `title: null`, so the exported HTML has the English
  one). The home page's "Build Roulette" is the same in both. Static `description`s and the
  link previews' `og:*` stay English.
- **What stays English, and why:** server content (the challenge cards and their hints,
  player and build names, a vote category the server adds beyond the four known ones, the
  server's rate-limit sentence, whose wait time Turkish reads and rewords); the spinning
  reels' decoys and the welcome's example cards (they show the deck, which is English); the
  sandbox's console and Problems (the site's own output, the shell's `module-load` messages);
  `/admin` (always English and without a switch, also when Turkish is stored, `<html lang="en">`
  there); link previews and the Worker (`battleMeta`, `og:*`); telemetry event names; the
  random fun names (they become player names); the `m:ss` countdown and `m:ss.s` completion
  times (the same in both).
- **Glossary** (game terms in Turkish, used everywhere):

  | English | Türkçe |
  |---|---|
  | battle | kapışma ("Solo kapışma", "Kapışma geçmişin") |
  | build (a player's entry) | proje ("En İyi Proje", "Projen") |
  | build (the step, `npm run build`); the built site | build, "build al"; "build’i alınmış site" |
  | SPIN / Spin | ÇARK (phase), "ÇARK DÖNÜYOR"; "Çevir" (the button) |
  | BUILD (phase) | İNŞA ("İnşa" on the countdown) |
  | ship / shipped / auto-shipped | teslim et / teslim edildi / otomatik teslim |
  | reveal / vote / results / destroy | gösterim / oylama, oy ver / sonuçlar / imha |
  | the cards BUILD · RULE · STYLE · TIME LIMIT | PROJE · KURAL · STİL · SÜRE |
  | room · host · spectator · lobby | oda · oda sahibi · izleyici · lobi |
  | Ready up · rematch · kick | Hazırım · rövanş · at |
  | import · drop · preview | içe aktar · bırak · önizleme |
  | autosave · last look · screenshot | otomatik kayıt · son bakış · ekran görüntüsü |
  | Speedrun · Clutch ship · Fastest ship | Speedrun · Son saniye teslimi · En hızlı teslim |
  | DNF / Did not finish | Bitiremedi |
  | Problems · Console · sandbox | Sorunlar · Konsol · sandbox |
  | report · moderators | bildir · moderatörler |
  | vibe coder · prompt · AI tool | vibe coder · prompt · yapay zekâ aracı |

- **Adding a string:** add it to `en.ts` (the section of its screen); `tr.ts` then fails to
  compile until it has the Turkish; in the component, `const t = useT()` and `t.section.key`
  (a function for numbers or names, `Rich` for markup or React parts). Never type words into
  JSX: `pnpm --filter @br/web test` fails on JSX text with letters and on literal
  `aria-label` / `title` / `placeholder` / `alt` (and the like) values in `src/components` and
  `src/app` outside `/admin` (`src/lib/i18n/hardcoded-strings.ts`; `ALLOWED` there for the few
  words that never change, such as the game's name). `catalogs.test.ts` fails on an empty
  Turkish text or one identical to the English (`SAME_IN_BOTH` lists the shared terms).

## Code map

| Piece | File |
|---|---|
| The import area shared by `/try` and BUILD (drop zone, pickers, page drop, import bar, preview, Problems) | `src/components/site/*`, `src/lib/site/use-site-import.ts` |
| Import from a link: the field, the call to `import-url`, the remembered link, the test-only origins | `src/components/site/LinkForm.tsx`, `src/lib/site/link-import.ts`, `link-memory.ts`, `link-config.ts` |
| Preview glue (iframe, loads, crash, console batching) | `src/lib/preview/preview-controller.ts` (`PreviewController`) |
| The battle's last import on this device (IndexedDB) and the stale cleanup | `src/lib/site/local-sites.ts`, `src/lib/site/site-cleanup.ts` |
| Solo game loop (plain TS, unit tested with fakes); also runs a room's battle in external mode | `src/lib/solo/controller.ts` (`SoloController`) |
| Room sync engine: private topics, versions/gaps, heartbeat, resync, clock, presence | `src/lib/room/sync.ts` (`RoomSync`), `src/lib/room/reducer.ts` |
| Room page logic: join, lobby intents, battles, toasts, leave/kick | `src/lib/room/controller.ts` (`RoomController`), `src/lib/room/api.ts` |
| REVEAL and VOTING: the revealed site packs (untrusted, checked), prefetch, thumbnails, skip/frozen/could not load, host controls, ballot | `src/lib/room/reveal-vote.ts` (`RevealVoteController`), `src/lib/room/reveal-files.ts` |
| Room screens (lobby, progress sidebar, spectator, reveal, vote, ranked results) | `src/components/room/*` |
| Backend calls (RPCs, storage) | `src/lib/solo/api.ts` (`SupabaseSoloApi`), `src/lib/supabase/*` |
| Error contract → messages | `src/lib/solo/errors.ts` |
| React binding | `src/lib/solo/use-solo-game.ts` |
| Screens | `src/components/solo/*` |
| Results page (shell, loader, page) + its title and social image | `src/app/battles/page.tsx`, `src/components/results/BattleView.tsx`, `BattleResults.tsx`, `src/lib/solo/public-battle.ts`, `battle-meta.ts`, `og-image.ts`, `public/og-card.png` (`scripts/og-card.ts`) |
| Static hosting: shells and rewrites, `_headers` and the CSP, the export checks, page loads | `src/lib/hosting/*`, `scripts/pages-config.ts`, `wrangler.jsonc` (the Worker with static assets) |
| Player history page | `src/app/u/page.tsx`, `src/components/results/PlayerHistoryView.tsx`, `PlayerHistory.tsx`, `src/lib/history/*`, `src/components/results/MyHistoryLink.tsx` |
| Onboarding: the welcome screen, the steps, the guide, "How do I import?" | `src/components/onboarding/*`, `src/lib/onboarding/welcome.ts`, `src/app/how-it-works/page.tsx` |
| Languages: the catalogs, the provider, the switch, the formatting, the checks | `src/lib/i18n/*`, `src/components/i18n/*` |
| Phones and tablets (touch-primary check) | `src/lib/device.ts`, `src/components/room/DesktopNeeded.tsx` |
| Moderation: report dialog, "Removed by moderators" | `src/components/moderation/*`, `src/lib/moderation/report.ts` |
| Admin page, sign-in, the moderator's session (its own client, sessionStorage) | `src/app/admin/*`, `src/components/admin/*`, `src/lib/admin/*` |
| Turnstile on anonymous sign-up | `src/lib/supabase/turnstile.ts`, `src/lib/supabase/browser.ts` |
| Error reporting and analytics (env-gated), the hashed user and tags | `src/instrumentation-client.ts`, `src/lib/telemetry/*`, `src/app/global-error.tsx`, `packages/telemetry` |
| Admin Health section, its findings | `src/components/admin/HealthView.tsx`, `src/lib/admin/health.ts` |

## Tests

```sh
pnpm --filter @br/web test             # unit (Vitest): solo + room controllers, sync engine, reducer, …
pnpm --filter @br/web test:e2e         # /try, the onboarding, the languages and the static site (Playwright), no Supabase needed
pnpm --filter @br/web test:e2e:solo    # /play against the REAL local Supabase stack
pnpm --filter @br/web test:e2e:moderation  # report → /admin takedown → removed on the next load (REAL stack)
pnpm --filter @br/web test:e2e:multi   # rooms: 3+ browser contexts (and phones), REAL stack WITH Realtime
pnpm --filter @br/web test:e2e:mobile  # only the phone spec of the above
pnpm --filter @br/web test:e2e:chaos   # rooms under chaos (~14 min), same stack
CHAOS_SHARD=2 pnpm --filter @br/web test:e2e:chaos   # one of its 3 shards (~5 min each)
pnpm --filter @br/web test:e2e:telemetry      # error reporting + analytics against a fake ingest, on and off (REAL stack)
```

- **Languages** (T-050): `e2e/language.spec.ts` (in `test:e2e`, on a Chromium set to
  `tr-TR`): English by default, "TR" on the home page turns the hero, the welcome and the
  guide Turkish (`<html lang="tr">`, the tab titles), a reload keeps it with no console
  error or CSP violation, "EN" switches back; the welcome a first visit opens has the switch;
  a `/try` import error in Turkish; the home page at 390 px; the 404 page.
  `e2e/solo-language.spec.ts` (`test:e2e:solo`): Turkish during BUILD keeps the imported site
  (the same iframe, the site's own state) and the countdown running, then ship and the results
  in Turkish. `e2e/multiplayer-language.spec.ts` (`test:e2e:multi`): a Turkish host and an
  English guest in one room. `LANGUAGE_SCREENSHOT_DIR=/dir` saves Turkish screenshots.
- `test:e2e:telemetry` (`playwright.telemetry.config.ts`) builds twice. First with the
  Sentry DSN and the PostHog host pointing at a local fake ingest (`@br/telemetry/testing`,
  port 4399, started by the spec, and allowed by that build's CSP): a browser error, the
  admin's test error (thrown in the page; no server event exists any more) and the
  `room_created` / `room_joined` events arrive scrubbed (no query, room code, name, email,
  raw user id or admin token; one hashed id); with GPC no analytics and no user; nothing from
  the sandbox iframe, and the `site_import` and `preview_crash` events carry no file names or
  site code (`e2e/telemetry-on.spec.ts`). Then the plain build: no Sentry chunk is loaded and
  no request goes to any host but the app, Supabase and the sandbox shell
  (`e2e/telemetry-off.spec.ts`). It leaves the plain build in `out/`.

- **Every suite serves the static export the way Cloudflare does:** `pnpm build`, then
  Playwright starts `wrangler dev` on port 3100 (`e2e/app-server.ts`: the `_redirects`
  rewrites, the `_headers` CSP, the 404 page, the Worker on `/battles/*`). The `/try`, solo,
  moderation, rooms and chaos suites fail on any CSP violation of the app's pages
  (`e2e/csp.ts`).
- **Fixture sites** (`e2e/sites.ts`): what a player's tools would produce, built in the test:
  a Vite-like `dist/` (`index.html`, `/assets/index-<hash>.js` and `.css`, root-relative), a
  one-file plain HTML site and an unbuilt project. They are imported as a player does:
  `importFolder` (the folder input with `webkitdirectory`, a real folder on disk), `importZip`
  (the .zip input) and `dropFiles` (a real `drop` event with a synthetic `DataTransfer`; it
  cannot carry folders, so it drops a one-file site or a .zip). `importApp(page, title,
  background)` is what the room suites use.
- `test:e2e` runs `pnpm build`, then Playwright starts `wrangler dev --port 3100` and
  `scripts/sandbox-servers.ts` (allowing `http://localhost:3100`) and runs `e2e/` except the
  suites that need Supabase. `e2e/static-site.spec.ts` (T-037) checks the host's behaviour:
  every page is a file, the shells keep their URL, unknown paths get the 404 page with a 404,
  the `_headers` values, the CSP blocking an injected script and never blocking anything of
  the app's own (`/try` runs an imported site), and `/admin` without a session.
  `e2e/try.spec.ts`: a `dist` folder and a whole project folder picked with "Choose folder",
  a .zip, Import again, a real drop (a one-file site, then a .zip over the running preview),
  dropped source code ("This is source code, not the built site") with the zone still usable,
  Problems and Console, an infinite loop (crashed, Restart, a new import recovers), the
  keyboard going to the site, the pickers by keyboard, dark mode, and `/playground` → `/try`.
  It uses full Chromium (`channel: 'chromium'`), because the infinite-loop test needs site
  isolation (see `packages/runtime/README.md`). `@playwright/test` is pinned to 1.56.1 to
  match the preinstalled browser. Not part of `pnpm test`. (The package CDN outage suite,
  `cdn-outage.spec.ts`, went with the package CDN in M6.)
- `test:e2e:solo` (`playwright.solo.config.ts`) needs the local Supabase stack running. It
  builds, then starts `scripts/solo-services.ts` (shell with the capture gate, the jobs
  function) and `wrangler dev --port 3100`, and plays three battles (`e2e/solo.spec.ts`):
  - **ship:** name → spin → the drop zone (Ship disabled) → a .zip, then a `dist` folder →
    autosaved → ship → RESULTS with the real 1280×800 screenshot, the `speedrun` award and
    the stats (4 files, the size, 2 imports) → the last-look deadline is forced with psql →
    the DESTROY moment → the battle's site in IndexedDB and every ephemeral object are gone
    → `/battles/[id]` shows the result with the screenshot and its link preview;
  - **auto-ship:** a whole project folder (dist/ found in it, the rest skipped), autosaved at
    once, force the build deadline and the grace → `auto_shipped`, captured with its
    stylesheet (the background colour is checked in the screenshot);
  - **reload:** an import comes back after a reload (IndexedDB), and in a browser without
    that copy (the same session) from the remote autosave.
  - **Import from a link** (`e2e/solo-link.spec.ts`, T-052; the fixture server
    `e2e/link-fixture.ts`): on `/try` a folder makes no Supabase request, then a pasted link
    signs in anonymously, the `import-url` function copies the fixture and the site runs
    ("Copied from host.docker.internal:4330"); a re-published site with "Copy again from
    <host>"; the link is remembered after a reload; a link on another host and a malformed one
    fail at once with no request; a missing site (404) and a private one (401) get their words;
    a slow site shows "Copying your site…" and Cancel brings the zone back; on BUILD a link is
    imported, autosaved, shipped and in RESULTS (`imports: 1`). `LINK_SCREENSHOT_DIR=/dir`
    saves the field, copying, an error, the copied site and the link row, in English and
    Turkish, light, dark and at 390 px.
  - **Storage down** (`e2e/solo-outage.spec.ts`): an import runs and is kept while Storage
    refuses connections, the autosave says "Save failed, retrying", a reload restores it from
    IndexedDB, the retry lands once Storage is back, then ship; and a ship that fails while
    Storage is down succeeds on "Try again". The rooms suite has
    `e2e/multiplayer-outage.spec.ts`: one player's Storage goes down, the room still sees the
    import (Presence), and the retried autosave is what the deadline auto-ships.

  The tests commit data (anonymous users, battles), like `supabase/scripts/e2e-solo.mjs`.
  `SOLO_SCREENSHOT_DIR=/dir` saves UI screenshots; `E2E_REUSE_SERVERS=1` reuses servers that
  are already running. The local Auth server allows 300 anonymous sign-ups per hour per IP
  (`[auth.rate_limit] anonymous_users` in `supabase/config.toml`); many runs in a row (each
  solo test signs up one user, the rooms e2e seven, the capture integration four) can hit
  it, and the UI then says "Too many requests". Restarting the stack resets it.
- `test:e2e:moderation` (`playwright.moderation.config.ts`, `e2e/moderation.spec.ts`; T-024)
  uses the solo servers (the capture worker's takedown loop matters here). It inserts a
  finished battle with psql (two builds, real PNG screenshots in the public bucket), then:
  a player reports one build on `/battles/[id]`; `/admin` is the not-found screen for that
  player, for a visitor without a session and after a wrong password. The moderator's browser
  is a player's too (it reports a second build, then dismisses that report). The email admin
  (seeded with `supabase/scripts/seed-admin.mjs`) signs in: the session is in that tab's
  sessionStorage, the player session in localStorage is untouched, another tab is not signed
  in. The admin sees the report with its reason and details, checks Health, takes the build
  down and opens the battle's event log; **the very next load** of the public page shows
  "Removed by moderators" without the screenshot (rank kept; the RPC answer of that load is
  checked, and the shell's `Cache-Control` revalidates every time), and the worker deletes the
  object. The reported build had won the (voted) battle: afterwards it has no Winner banner
  and no award chips on `/battles/[id]` and on the builder's `/u/[id]`, its vote counts stay,
  and the runner-up keeps its own award without becoming the winner (T-028). Sign-out
  removes the session and revokes its refresh token. No CSP violation on any page. A second
  test: a blocked display name on Create room and `/play` shows the friendly error.
  `MODERATION_SCREENSHOT_DIR=/dir` saves the UI screenshots.
- `test:e2e:multi` (`playwright.multi.config.ts`) needs the local stack running **with
  Realtime**; same servers as the solo e2e (`solo-services.ts --realtime`). Each player is
  its own browser context, i.e. its own anonymous user (`e2e/multiplayer.spec.ts`):
  - **a 3-player room:** create (landing page), join by link and by a lower-case code,
    everyone online, ready, start, the same challenge for all; a late joiner is a spectator
    (countdown and progress, no import); the host imports and ships fast, a player imports,
    refreshes mid-BUILD and gets her import back; another imports twice ("imported (2×)" in
    the others' sidebars) and ships late;
    the deadline is forced → auto-shipped; REVEAL: every page (spectator included) shows the
    same `reveal_index` and runs the same build in a reveal-mode frame, the host's Next and
    Skip to vote, one player skips a build she froze (locally; the others keep watching)
    and another waits for the watchdog's "this build froze"; VOTE: no self-vote in the UI,
    a revote (checked in the database), a refresh restores a half ballot, the last ballot
    ends voting early (`all_voted`); RESULTS ranked by votes for a scripted ballot
    (Best Build three-way tie → total votes → earlier ship), votes per category, category
    awards plus `speedrun` + `fastest_ship`, the winner, real screenshots; each player's
    last look; the last look is forced → DESTROY for everyone → lobby (the spectator was
    promoted) → rematch → `/battles/[id]` with the votes (its `og:image` the static card);
  - **kick:** the host kicks a member in the lobby (with confirmation); they see the kicked
    screen and cannot rejoin;
  - **join errors:** an unknown code and a malformed one.

  - **phones** (`e2e/multiplayer-mobile.spec.ts`, Playwright's iPhone 13 profile in
    Chromium: 390×664, touch): a phone creates and hosts the room, changes the reveal/vote
    settings and starts; it gets the "building needs a computer" notice in BUILD and ends DNF with no
    file uploaded; a second phone joins mid-BUILD as a spectator; REVEAL is still-first on
    the phones (no iframe until "Tap to run live") and live at once on the desktops; the
    host bar is fixed and in view; VOTE with taps, including rapid alternating taps on two
    builds while `cast_vote` is slowed to 800 ms (the last tap wins, in the UI and in the
    database, with fewer requests than taps); RESULTS; a result name opens `/u/[id]` in a
    new tab; the history on desktop and phone; an unknown player's not-found page. Every
    phone page is checked for sideways scrolling (`expectNoHorizontalScroll`, which
    measures against the device width: Chromium widens `innerWidth` with the content).
    Phones get viewport screenshots only: a full-page screenshot makes Playwright's
    Chromium drop the touch emulation for good.

  `MULTI_SCREENSHOT_DIR=/dir` saves
  `t020-{lobby,build-sidebar,spectator,reveal,vote,results,battle-page}.png` and
  `t021-{lobby-settings,mobile-reveal,mobile-vote,mobile-results,history}.png`.
  Clicks on the ship dialog go through `clickRouted` (`e2e/helpers.ts`): Chromium routes a
  mouse event from the compositor's hit-test data, which right after the dialog opens can
  still show the cross-site preview iframe there (measured: 16–21 of 40 first clicks under
  CPU load went to the iframe; `bringToFront` does not help, every headless window is
  visible and focused). The helper hovers until the button itself gets the pointer move,
  then clicks once. A person cannot click a button before it is drawn, so this is a test
  artefact, not a product bug.
- `test:e2e:chaos` (`playwright.chaos.config.ts`, `e2e/chaos.spec.ts`; docs/04 §4.8 and the
  M3 exit criteria) runs on the same servers, with REVEAL and VOTING on (the default). The
  battle's time limit is set while it spins, so BUILD runs on real server deadlines; the
  5 min abandonment window, the 60 s last look, and the REVEAL slots and the vote where a
  test does not drive them (`deadlineSkip`) are shortened with psql. Every battle ends with a database check of its terminal
  state (one event per version, one build per roster player, every hand-shipped build kept,
  no draft after DESTROY, captures settled, ranks 1…n, files destroyed):
  - **6 players under chaos:** clocks at ±5 min (`newPlayer(…, { clockSkewMs })`), a 15 s
    network drop mid-BUILD with an import made offline (autosaved once back), refreshes
    mid-BUILD and mid-RESULTS, the host's context closes (host migration, toasts and crown;
    her autosave ships); a player who never imported ends DNF; in
    REVEAL the new host drives Next, then drops offline and the controls move to the next
    host, who skips to the vote; two players vote, the timer ends the rest; that host
    starts the rematch;
  - **random chaos (seeded):** drops, refreshes, imports and ships picked by a PRNG on skewed
    clocks (everyone imports once first); `CHAOS_SEED=n` replays a run (the seed is logged and
    in the report);
  - **steady imports:** an import every ~3 s for a minute must not trip Realtime's presence
    limit (5 messages per 30 s per client, or the server closes the channel); the watcher
    sees the final import count (T-029: within ~15 s);
  - **all clients closed at T-0:** pg_cron alone ends BUILD and SHIPPING, auto-ships the
    autosaves (including an import made in the last 20 s), runs every REVEAL slot and VOTING
    (their deadlines moved to now), captures, RESULTS;
  - **abandoned:** a returning player sees the abandoned battle in the lobby;
  - **reveal and vote under chaos** (T-021): a refresh mid-REVEAL lands on the current
    `reveal_index` running the right build, with the countdown in sync; the host votes
    once and leaves mid-VOTE (the crown moves, nothing waits for her, her partial ballot
    counts); a vote cast offline is kept ("Not saved yet"), retried and lands once back
    online; a player offline until VOTING ends early (`all_voted`) is told in RESULTS
    that his pick was not counted;
  - **8 players** (the largest party): everyone imports and ships, a reveal of 8 builds (38 s slots),
    everyone votes in every category, ranked results with the tallies, destroy, lobby;
  - **a full room:** the 9th player spectates; with 20 spectators, `room_full`;
  - **Realtime loses the database feed** (T-023): mid-REVEAL, Realtime stops forwarding the
    database's broadcasts (`docker exec` into the Realtime container,
    `dropRealtimeDatabaseFeed` in `e2e/stack.ts`) with every channel still subscribed; every
    page still follows the next build, the vote, RESULTS and DESTROY, with zero battle
    events delivered (the heartbeat's battle-version check, `src/lib/room/sync.ts`).

  A full run signs up 41 anonymous users (mind the 300/hour local Auth limit above).
  **Shards:** `CHAOS_SHARD=1|2|3` runs a third of the suite: a test joins shard 1 or 2 with
  `@chaos-1` / `@chaos-2` at the end of its title, shard 3 runs every test without either
  tag (so a new test always runs somewhere). About 5 minutes each (measured: 4.8, 4.4 and
  4.8 min). Each shard has its own output directory (`test-results/chaos-shard-N/`) and
  report (`playwright-report/chaos-shard-N/`), so shards 1 and 2 can also run side by side
  on one stack (servers started once, `E2E_REUSE_SERVERS=1`); shard 3 needs the stack to
  itself (its lost-feed test cuts Realtime's database feed for every client of the stack).
  CI runs the three shards as parallel jobs, each with its own stack, on every push, nightly
  and on demand (job `chaos`).
- **Failure diagnostics** (rooms and chaos e2e, `e2e/diagnostics.ts`): the specs import
  `test` from there, and every failed test gets, next to Playwright's trace and
  screenshots: `players.md` (per player: URL, the visible stages with their data
  attributes, the Realtime channels by topic, the last log lines) and `players-full.log`
  (console, page errors, failed requests and Realtime frames of every page, timestamped),
  a labelled screenshot per page, `db.json` (the test's battles with their events, builds,
  votes and jobs, the rooms and their members, slow or failed pg_cron runs),
  `services.log` (the capture worker and shell output of the test's window; written by
  `scripts/solo-services.ts` to `BR_SERVICES_LOG`) and `docker-*.log` (the Realtime,
  Postgres, Auth, PostgREST and Storage containers). The HTML report
  (`playwright-report/multi/`, `playwright-report/chaos*/`) keeps them until the next run;
  CI uploads both directories when a job fails.
- **Realtime drops broadcasts on the local stack.** Every 10 minutes the local Realtime
  closes its database connection ("Rebalancing Tenant database connection for a closer
  region": its node's region is `local`, the tenant's `us-east-1`) and reconnects only when
  a client joins a channel. Until then every channel stays subscribed but no broadcast from
  the database arrives, and the ones sent meanwhile are lost. That made the chaos tests
  fail now and then (T-023: pages stuck on the previous REVEAL slot). The sync engine now
  compares the battle version in every heartbeat's answer with its snapshot (T-029; before,
  a separate read next to each beat) and refetches when the server is ahead, and ship
  toasts come from snapshots, so a lost broadcast costs at most one heartbeat (10 s); the
  chaos test above pins it.
- **The host's Next during the capture burst.** `reveal_next` / `skip_to_vote` carry the
  battle version (compare-and-set), and the capture worker finishes the builds'
  screenshots one after another right at the start of REVEAL, each one a new version. A
  click that lost that race was dropped (T-023: the other cause of the 8-player test's
  failures). The controller now resends it with the version the server returned while the
  phase and the spotlight are unchanged (`HOST_RETRIES`, `src/lib/room/reveal-vote.ts`).
## Cloudflare Workers (static assets)

Production is a static site served as the static assets of the Worker `build-roulette-web`
(`wrangler.jsonc`: `assets.directory: ./out`, `main: ./dist/worker.js`, T-043; Cloudflare
Pages before, blocked in Turkey). `pnpm build` + `pnpm preview` serve it locally with
`wrangler dev`, no account needed; `pnpm workers:deploy` uploads it. See
[DEPLOY.md](DEPLOY.md) for the account setup, deploys, the security headers, observability
and the custom domain.

**CPU per request (T-033, kept for T-038).** `pnpm --filter @br/web measure:cpu` (after
`pnpm build`) measures what `wrangler dev` runs per request on workerd, warm and in a fresh
isolate: a V8 CPU profile of the user isolate plus the workerd thread's CPU, with a method
check on a known Worker (`scripts/measure-cpu/`). Static files never enter the Worker's
isolate (production runs no Worker for them); T-038 measured the link-preview Function with
it (then on `wrangler pages dev`).
The T-033 results for Next.js on Workers and the static site's are in
[docs/08-free-tier.md](../../docs/08-free-tier.md) §1 and §2; raw data lands in
`cpu-results/` (gitignored).

## Known limitations

- **Every battle shares one link preview** (T-037): the shells' `og:*` tags are the generic
  title and `og-card.png`, because crawlers do not run the page's script. T-038 writes each
  battle's own tags at the edge. When it does, the rank-1 screenshot is WebP from the local
  capture worker: most link-preview crawlers accept WebP (assumed, not tested here); a
  PNG/JPEG screenshot (Browser Rendering can produce either, T-034) avoids the question.
- **The shells answer 200** for an unknown battle or player (and `/admin` for everyone): the
  page shows the 404 screen. Truly unknown paths get a real 404.
- **The solo game polls** `get_battle_snapshot` (every 2–10 s depending on the phase, and
  right after each deadline; T-029: no longer every 250 ms once a deadline has passed);
  rooms use Realtime.
- **Rooms:** presence is tracked on the room topic only. A viewer's "Skip this build", the
  frozen state and a phone's "Tap to run live" are per build and per tab (not remembered
  across a refresh).
- **History is per browser:** `/u/[id]` is keyed by the anonymous auth user. Clearing the
  browser's data loses the way back to it (the page itself stays at its URL); account
  linking (docs/06 M6) is what will keep it across devices. `/battles/[id]` names players
  without ids (`get_public_battle`), so it links only the viewer's own history.
- **Phones only tested in Chromium's mobile emulation** (no real iOS Safari / Android device
  in CI).
- **Caching:** a takedown made outside `/admin` (SQL) revalidates nothing, so cached copies
  show the build for up to an hour (`/u/[id]`: a minute). A copy older than its lifetime is
  served once more while it regenerates (stale-while-revalidate), so a battle page first
  rendered in RESULTS can show its pre-screenshot state to one more visitor later on.
