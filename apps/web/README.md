# @br/web

The Next.js app (App Router). Routes:

| Route | What |
|---|---|
| `/` | Landing page: "Play solo" (`/play`), "Create room" (a name → `create_room` → `/r/{code}`) and "Join with code" (any case, trimmed, or a pasted invite link). |
| `/play` | The solo game: name → SPIN → BUILD → SHIP → RESULTS → DESTROY. `?battle={id}` resumes a battle after a refresh. |
| `/battles/[id]` | The permanent, shareable results page (server-rendered), plus `/battles/[id]/opengraph-image`. |
| `/playground` | Single-player editor and live preview, no game. |
| `/r/[code]` | A room (M3): join → lobby → SPIN → BUILD → SHIP → RESULTS → DESTROY → lobby (rematch). |

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
| Mock package CDN | `http://localhost:4322` | React and a few packages from `@br/runtime`'s test support. |
| Sandbox shell | `http://127.0.0.1:4321/v1/` | The preview (a different site from the app), plus the signed capture page `/v1/capture` with a random per-run HMAC secret. |
| Capture/destroy worker | (no port) | `@br/capture-worker` with Playwright Chromium: screenshots shipped builds and deletes ephemeral files after DESTROY. |
| Next.js | `http://localhost:3000` | `next dev`, pointed at all of the above. |

Ctrl+C stops everything (the stack keeps running; stop it with
`npx -y supabase@2.119.0 stop --no-backup`). Without `--next`
(`pnpm --filter @br/web exec tsx scripts/solo-services.ts`) it runs only the services, e.g.
next to your own `next dev` or for the e2e.

The game, step by step:

1. **Name + Spin.** A random fun name is prefilled; `start_solo_battle` draws the challenge.
   If you already have a running battle (`battle_in_progress`), you're offered to resume it.
2. **SPIN** (6 s). Three reels (BUILD, RULE, STYLE) and the time limit land on the server's
   cards. The BUILD screen is already mounted underneath, so the editor, the bundler worker
   and `esbuild.wasm` load during the spin.
3. **BUILD.** The playground editor and preview, a challenge header with the hints, and a
   countdown from server time (`server_now()` samples, `estimateClockOffset`, `remainingMs`)
   that turns amber at 1 minute and pulses red for the last 10 s. Each battle gets a fresh
   template in IndexedDB under `battle:{id}` (restored from the remote autosave on another
   device). Autosave every 30 s, when the tab is hidden, 3 s before the deadline and once
   in the SHIPPING grace: `autosave/{source.json,bundle.js,bundle.css}`.
4. **SHIP.** "Ship it? You can't edit after." with a build name. Then a client thumbnail
   (best effort), a production build, the uploads (`source.json`, `bundle.js`,
   `bundle.css`, `thumb.webp`) and `ship_build` with stats. Every error code of the RPC
   contract has a message (`src/lib/solo/errors.ts`).
5. **T-0.** Without a ship, the editor locks and the last autosave is auto-shipped by the
   server. The client nudges `advance_battle` at each deadline (0–500 ms jitter); pg_cron
   is the backstop.
6. **RESULTS.** The capture worker's screenshot, the completion time, the auto-awards
   (`speedrun`, `clutch_ship`), the challenge, and the fallback/failed/DNF states. The
   shipped bundle runs in a **reveal-mode** preview for the 60 s last look.
7. **DESTROY.** A short destroy animation, then the battle's IndexedDB workspace is deleted
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
   then BUILD with a sidebar of everyone's progress (lines, build status, typing, and
   "Ada shipped 'Snack Overflow' at 3:12" badges).
4. Ship, or wait for the deadline (5, 10 or 15 min, drawn by the server; force it with
   psql as in `e2e/multiplayer.spec.ts` if you are impatient). RESULTS ranks every build
   with its screenshot and awards, shows your own build for the last look, then DESTROY
   and everyone is back in the lobby. **Start the rematch** for the next battle.
5. A window that joins during a battle is a spectator (countdown and progress, no editor);
   the host can kick from the lobby; **Leave room** leaves (rejoin with the link).

If you started the stack yourself with `-x …,realtime,…` (as the capture CI job does), solo
still works but rooms do not: restart it without `realtime` in `-x`.

### Environment variables

All `NEXT_PUBLIC_*` values are inlined at build time (`next build`, `cf:build`), so rebuild
after changing them. The defaults are the local setup above.

| Variable | Default | What |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `http://127.0.0.1:54321` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | the local stack's demo anon key | Public anon key (JWT). `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (`sb_publishable_…`) works instead. |
| `NEXT_PUBLIC_SANDBOX_SHELL_URL` | `http://127.0.0.1:4321/v1/` | Sandbox shell |
| `NEXT_PUBLIC_PKG_CDN_URL` | `http://localhost:4322` | esm.sh-compatible package CDN |
| `NEXT_PUBLIC_SITE_URL` | `http://localhost:3000` | The app's public origin (`metadataBase`, absolute OG image URLs) |

The web app never holds the service-role key: players sign in anonymously
(`signInAnonymously`), every write goes through RPCs and storage RLS, and the results page
reads `get_public_battle`, which the anon key may call.

`scripts/solo-services.ts` reads: `BR_APP_ORIGINS` (app origins the shell accepts, default
`http://localhost:3000`), `APP_PORT` (3000), `SHELL_PORT` (4321), `CDN_PORT` (4322),
`CAPTURE_HMAC_SECRET` (default: random per run), `WORKER_IDLE_MAX_MS` (2000), and the
stack's `API_URL` / `ANON_KEY` / `SERVICE_ROLE_KEY` (default: `supabase status -o env`).

## `/playground` local setup

The preview runs on a different site from the app (docs/03 §3.5), so `/playground` needs two
local servers next to Next.js:

| Server | Default URL | Configured in the app by |
|---|---|---|
| Sandbox shell (`@br/sandbox-shell`) | `http://127.0.0.1:4321/v1/` | `NEXT_PUBLIC_SANDBOX_SHELL_URL` |
| Package CDN (mock, from `@br/runtime/test-support`) | `http://localhost:4322` | `NEXT_PUBLIC_PKG_CDN_URL` |

`127.0.0.1` and `localhost` are different sites, which gives the cross-site iframe the
production setup has.

```sh
# terminal 1: shell + mock CDN, allowing the dev app origin
pnpm --filter @br/web dev:sandbox

# terminal 2: the app
pnpm --filter @br/web dev        # http://localhost:3000/playground
```

The shell only talks to app origins it was built for: they are baked into `shell.js`
(postMessage target) and into its CSP `frame-ancestors`. `dev:sandbox` allows
`http://localhost:3000` by default. For another origin or port, set `BR_APP_ORIGINS`
(comma-separated), for example `BR_APP_ORIGINS=http://localhost:3100 pnpm --filter @br/web
dev:sandbox`. Ports: `SHELL_PORT` (4321) and `CDN_PORT` (4322); if you change them, set the two
`NEXT_PUBLIC_*` variables to match. They are inlined at build time, so rebuild after changing
them.

If the shell is not running, or does not allow the app origin, the preview shows
"The preview could not start" after 10 s.

The mock CDN serves only the packages installed in `packages/runtime` (`react`,
`react-dom`, `zustand`, `animate.css`) at their installed versions. The self-hosted package
CDN (T-006) replaces it.

### How the bundler is served

- The bundler worker is `src/lib/playground/bundler.worker.ts` (it imports
  `@br/runtime/worker`). `new Worker(new URL('./bundler.worker.ts', import.meta.url))` in
  `src/lib/playground/runtime-factory.ts` makes Turbopack bundle it as a separate worker chunk.
- `esbuild.wasm` is imported from this app's `esbuild-wasm` dependency. A Turbopack rule in
  `next.config.ts` (`'*.wasm': { type: 'asset' }`) emits it as a content-hashed file under
  `/_next/static/media/` and the import returns its URL. `next.config.ts` fails the build if
  this app's `esbuild-wasm` version differs from the one `@br/runtime` pins, because esbuild
  refuses to start with mismatched JS and wasm versions.
- `/playground` and `/play` load their client code with `next/dynamic` (`ssr: false`), so
  other routes never download CodeMirror, the runtime or the worker.

## Code map

| Piece | File |
|---|---|
| Editing session shared by `/playground` and BUILD (workspace + sandbox + editor state) | `src/lib/playground/use-workspace-session.ts`, `src/components/playground/WorkspacePanes.tsx` |
| Bundler worker + preview glue | `src/lib/playground/sandbox.ts` (`SandboxController`) |
| Solo game loop (plain TS, unit tested with fakes); also runs a room's battle in external mode | `src/lib/solo/controller.ts` (`SoloController`) |
| Room sync engine: private topics, versions/gaps, heartbeat, resync, clock, presence | `src/lib/room/sync.ts` (`RoomSync`), `src/lib/room/reducer.ts` |
| Room page logic: join, lobby intents, battles, toasts, leave/kick | `src/lib/room/controller.ts` (`RoomController`), `src/lib/room/api.ts` |
| Room screens (lobby, progress sidebar, spectator, ranked results) | `src/components/room/*` |
| Backend calls (RPCs, storage) | `src/lib/solo/api.ts` (`SupabaseSoloApi`), `src/lib/supabase/*` |
| Error contract → messages | `src/lib/solo/errors.ts` |
| React binding | `src/lib/solo/use-solo-game.ts` |
| Screens | `src/components/solo/*` |
| Results page + OG image | `src/app/battles/[id]/*`, `src/lib/solo/public-battle.ts` |

## Tests

```sh
pnpm --filter @br/web test             # unit (Vitest): solo + room controllers, sync engine, reducer, …
pnpm --filter @br/web test:e2e         # /playground (Playwright), no Supabase needed
pnpm --filter @br/web test:e2e:solo    # /play against the REAL local Supabase stack
pnpm --filter @br/web test:e2e:multi   # rooms: 3+ browser contexts, REAL stack WITH Realtime
pnpm --filter @br/web test:e2e:chaos   # rooms under chaos (~10 min), same stack
```

- `test:e2e` runs `next build`, then Playwright starts `next start -p 3100` and
  `scripts/sandbox-servers.ts` (allowing `http://localhost:3100`) and runs `e2e/` except the
  solo specs. It uses full Chromium (`channel: 'chromium'`), because the infinite-loop test
  needs site isolation (see `packages/runtime/README.md`). `@playwright/test` is pinned to
  1.56.1 to match the preinstalled browser. Not part of `pnpm test`.
- `test:e2e:solo` (`playwright.solo.config.ts`) needs the local Supabase stack running. It
  builds, then starts `scripts/solo-services.ts` (shell with the capture gate, mock CDN,
  capture worker) and `next start -p 3100`, and plays two battles (`e2e/solo.spec.ts`):
  - **ship:** name → spin → edit `App.tsx` → ship → RESULTS with the real 1280×800
    screenshot and the `speedrun` award → the last-look deadline is forced with psql →
    the DESTROY moment → the IndexedDB workspace and every ephemeral object of the battle
    are gone → `/battles/[id]` shows the result, and its OG image renders;
  - **auto-ship:** edit `styles.css` + `App.tsx`, autosave (tab hidden), force the build
    deadline and the grace → `auto_shipped`, captured with its CSS (the background colour is
    checked in the screenshot).

  The tests commit data (anonymous users, battles), like `supabase/scripts/e2e-solo.mjs`.
  `SOLO_SCREENSHOT_DIR=/dir` saves UI screenshots; `E2E_REUSE_SERVERS=1` reuses servers that
  are already running. The local Auth server allows 300 anonymous sign-ups per hour per IP
  (`[auth.rate_limit] anonymous_users` in `supabase/config.toml`); many runs in a row (each
  solo test signs up one user, the rooms e2e seven, the capture integration four) can hit
  it, and the UI then says "Too many requests". Restarting the stack resets it.
- `test:e2e:multi` (`playwright.multi.config.ts`) needs the local stack running **with
  Realtime**; same servers as the solo e2e (`solo-services.ts --realtime`). Each player is
  its own browser context, i.e. its own anonymous user (`e2e/multiplayer.spec.ts`):
  - **a 3-player room:** create (landing page), join by link and by a lower-case code,
    everyone online, ready, start, the same challenge for all; a late joiner is a spectator
    (countdown and progress, no editor); the host ships fast, a player refreshes mid-BUILD
    and gets the same battle with the work restored, then autosaves; another ships late;
    the deadline is forced → auto-shipped; RESULTS ranks 3 builds with real screenshots and
    the awards (`speedrun` + `fastest_ship` for the host only); each player's last look; the
    last look is forced → DESTROY for everyone → lobby (the spectator was promoted) →
    rematch;
  - **kick:** the host kicks a member in the lobby (with confirmation); they see the kicked
    screen and cannot rejoin;
  - **join errors:** an unknown code and a malformed one.

  `MULTI_SCREENSHOT_DIR=/dir` saves `t017-{lobby,build-sidebar,spectator,results}.png`.
  Clicks on the ship dialog go through `clickRouted` (`e2e/helpers.ts`): Chromium routes a
  mouse event from the compositor's hit-test data, which right after the dialog opens can
  still show the cross-site preview iframe there (measured: 16–21 of 40 first clicks under
  CPU load went to the iframe; `bringToFront` does not help, every headless window is
  visible and focused). The helper hovers until the button itself gets the pointer move,
  then clicks once. A person cannot click a button before it is drawn, so this is a test
  artefact, not a product bug.
- `test:e2e:chaos` (`playwright.chaos.config.ts`, `e2e/chaos.spec.ts`; docs/04 §4.8 and the
  M3 exit criteria) runs on the same servers. The battle's time limit is set while it spins,
  so BUILD runs on real server deadlines; the 5 min abandonment window and the 60 s last
  look are shortened with psql. Every battle ends with a database check of its terminal
  state (one event per version, one build per roster player, every hand-shipped build kept,
  no draft after DESTROY, captures settled, ranks 1…n, files destroyed):
  - **6 players under chaos:** clocks at ±5 min (`newPlayer(…, { clockSkewMs })`), a 15 s
    network drop mid-BUILD with an edit made offline, refreshes mid-BUILD and mid-RESULTS,
    the host's context closes (host migration, toasts and crown; her autosave ships), the
    new host starts the rematch;
  - **random chaos (seeded):** drops, refreshes, edits and ships picked by a PRNG on skewed
    clocks; `CHAOS_SEED=n` replays a run (the seed is logged and in the report);
  - **steady typing:** a new line every ~1.5 s for a minute must not trip Realtime's
    presence limit (5 messages per 30 s per client, or the server closes the channel);
  - **all clients closed at T-0:** pg_cron alone ends BUILD and SHIPPING, auto-ships the
    autosaves (including the final one at T-3 s), captures, RESULTS;
  - **abandoned:** a returning player sees the abandoned battle in the lobby;
  - **a full room:** the 9th player spectates; with 20 spectators, `room_full`.

  A full run signs up 27 anonymous users (mind the 300/hour local Auth limit above). CI runs
  it nightly and on demand (job `chaos`).
- `test:e2e:cf` runs the playground suite against the Cloudflare Workers build
  (`cf:build`, then `opennextjs-cloudflare preview`, which is `wrangler dev` on workerd)
  instead of `next start` (`E2E_APP_SERVER=workers` in `playwright.config.ts`).

## Cloudflare Workers

Production runs on Cloudflare Workers through OpenNext (`open-next.config.ts`,
`wrangler.jsonc`). `cf:build` / `cf:preview` build and serve it locally with no Cloudflare
account; the normal `build` is unaffected. See [DEPLOY.md](DEPLOY.md) for the account setup,
deploys, secrets, custom domain and caching.

## Known limitations

- **The OG image embeds the screenshot only when it is PNG or JPEG.** `next/og` cannot decode
  WebP, which is what the local capture worker stores, so the card then shows the build name
  in a frame instead. Fix options: the capture worker also writes a PNG card image, or
  Cloudflare image transformations in production.
- **The solo game polls** `get_battle_snapshot` (every 2–10 s depending on the phase, and
  right after each deadline); rooms use Realtime.
- **Rooms (M3):** no REVEAL or VOTE yet (M4); presence is tracked on the room topic only;
  chaos testing (network drops, clock skew, host leaving mid-battle) is T-018.
- `/battles/[id]` is rendered per request; ISR on the R2 incremental cache is a follow-up
  (DEPLOY.md, "Caching").
