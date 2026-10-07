# @br/capture-worker

Server-side screenshots and source destruction for finished battles
([docs/01 §1.5](../../docs/01-architecture.md) "Ship → capture → destroy",
[docs/03 §3.6–3.7](../../docs/03-sandbox.md)). It polls the job queue from T-011
(`claim_job`), and:

- **capture:** renders the frozen bundle of a shipped (or auto-shipped) build in the sandbox
  shell's signed capture page, takes a 1280×800 PNG, converts it to WebP and stores it at
  `screenshots/{battle}/{build}.webp`, then `complete_capture('captured')`;
- **destroy:** deletes `ephemeral-builds/{battle}/**` through the Storage API, checks that
  nothing is left, then `complete_destroy(battle)`;
- **takedown** (T-024): a moderator took a build down. Deletes
  `screenshots/{battle}/{build}.*` through the Storage API (only names that start with the
  build id, only for a build whose `taken_down_at` is set), checks that nothing is left, then
  `complete_takedown(build)` (`src/takedown-job.ts`). The build is already hidden
  everywhere by then (the admin RPC cleared its name and screenshot path); this removes the
  file, which its public URL served until now. SQL holds the job back while a capture of
  the same build is still running (and never hands out a capture of a taken-down build),
  so a capture cannot upload after the delete.

Locally the renderer is Playwright + Chromium (`PlaywrightRenderer`); production is meant
to use Cloudflare Browser Rendering (`BrowserRenderingRenderer` is a documented sketch, see
below).

## Capture flow

```
claim_job('capture') ─► builds row (status, battle, builder)
  ─► signed Storage URLs, TTL 120 s: bundle.js (+ bundle.css when the build has one)
       shipped:      {battle}/{uid}/bundle.js, bundle.css, source.json
       auto_shipped: {battle}/{uid}/autosave/bundle.js, autosave/bundle.css, autosave/source.json
  ─► import map from source.json's manifest (buildImportMap from @br/runtime, PKG_CDN_URL)
  ─► capture URL signed with the HMAC secret, expiring with the Storage URLs
  ─► renderer: fresh context, 1280×800 @1x, readiness rule, hard timeout ─► PNG
  ─► blank check ─► WebP (sharp) ─► upload (upsert) ─► complete_capture('captured')
```

**Fallback.** When the render fails (timeout, page error, navigation) or is blank, the
client thumbnail `{battle}/{uid}/thumb.webp` is decoded, scaled to fit 1280×800 and
re-encoded (a client file is never stored as uploaded), then `complete_capture('fallback')`.

**Failure.** No usable render and no usable thumbnail: `fail_job`. SQL re-queues with
10/20/40/80 s backoff; on the 5th attempt `fail_job` gives up and sets
`capture_status = 'failed'` itself (T-011's `give_up_job`), so the worker never needs
`complete_capture('failed')` for that. The one exception: neither `bundle.js` nor a thumbnail
exists. Uploads are closed after ship, so retrying cannot help, and the worker calls
`complete_capture('failed', null)` at once. A good render whose upload or RPC fails is
retried, not downgraded to the thumbnail.

**Blank detection** (`image.ts`): the largest standard deviation of the R, G, B channels
over the whole image. Below 1.5 the image is blank: an empty page, a page that crashed before
rendering, or a single flat colour. A white page with one short word of 16 px text is well
above (roughly 4–7); WebP noise on a flat image stays far below.

**WebP**: `sharp` 0.35 with the prebuilt libvips from npm (`@img/sharp-linux-x64`, no build
step, no install script). Quality 82, stepping down if a screenshot would exceed the bucket's
2 MB limit. Typical sizes: 10–15 KB for the test builds.

## Readiness (decided here, never by the page)

The page is untrusted (a build can run code in the capture page's realm), so the renderer
decides when to shoot, from browser-side events (`readiness.ts`):

- the build's ready signal (`window.buildRoulette.ready()`, forwarded by the capture page
  as a `[br-capture] ready` console line), **or**
- network idle (no request in flight for 500 ms, from Playwright's `request` /
  `requestfinished` / `requestfailed` events) **plus 2 s**,
- **capped at 6 s** after the capture page loaded.

Then fonts and two animation frames, bounded by 1 s, then the screenshot. A forged signal can
only make a capture earlier; a request that never ends hits the cap; an infinite loop hits
the hard per-capture timeout (`CAPTURE_TIMEOUT_MS`, default 20 s), which closes the context.

### For templates: `window.buildRoulette.ready()`

Every build frame (preview, reveal and capture) has a read-only `window.buildRoulette` with
one method:

```ts
// After the first meaningful frame is on screen, e.g. in the root component:
useEffect(() => {
  requestAnimationFrame(() => window.buildRoulette?.ready());
}, []);
```

It tells the capture renderer it may take the screenshot now instead of waiting for network
idle + 2 s. It is a hint: it never delays a capture past the 6 s cap, and it does nothing in
the live and reveal previews. Use optional chaining so the code also runs outside the
sandbox. Builds that never call it are still captured (idle or cap).

## The capture page and the HMAC secret (sandbox-shell)

`GET /v1/capture?css=…&exp=…&map=…&src=…&sig=…` on the sandbox origin (in production
`https://{build}.<usercontent>/v1/capture`, so the build runs on its own origin, as in reveal).

- **What is signed** (`apps/sandbox-shell/src/capture-sig.ts`): HMAC-SHA256 over
  `br-capture-v1\n<host>\n<path>\n<query>`, where `<query>` is every parameter except `sig`,
  sorted by name, `encodeURIComponent`-encoded, joined with `&`. Unknown or repeated
  parameters are refused; `src`, `exp` and `sig` are required; `exp` must be in the future and
  at most 10 minutes away. The host is part of the signature, so a URL cannot be replayed on
  another build's origin.
- **Where it is verified: server-side, in a capture gate in front of the static shell**
  (`capture-gate.ts`). In production that is the Cloudflare Pages advanced-mode
  `dist/_worker.js`, limited by `dist/_routes.json` to `/v1/capture` (every other path stays
  a plain static asset with the `_headers` rules). The secret is a Pages secret
  (`wrangler pages secret put CAPTURE_HMAC_SECRET`), shared only with this worker
  (`CAPTURE_HMAC_SECRET`). Locally `startShellServer({ captureSecret })` runs the same gate.
  Invalid, expired or missing signatures get an empty 403 (`no-store`), so nothing renders.
- **Why this design.** The secret cannot be in the page's JS (anyone could read it and sign
  URLs). Verifying only on the renderer side would not stop anyone from opening
  `/v1/capture?src=https://evil/x.js` in their own browser: the page would run attacker JS
  top-level on a build's origin (phishing outside the app chrome, planting storage on that
  origin). With the gate, the page simply does not exist without a valid signature, and the
  page itself (`capture.js`, public and immutable) holds no secret and embeds nothing from the
  request. The gate is a few lines of Fetch API + WebCrypto, so the same code runs in Node and
  in workerd. **Not yet deployed or run in workerd** (no Cloudflare account); it is unit
  tested with Fetch API Requests.
- **Headers** (`captureHeaders`): the shell's CSP family (same sources, so a build behaves
  as in the preview) with `frame-ancestors 'none'` (top-level only) and a CSP
  `sandbox allow-scripts allow-same-origin allow-forms allow-pointer-lock` directive (the same
  flags as the runtime's `capture` iframe; a unit test checks they match), plus
  `Cache-Control: no-store` and `X-Robots-Tag: noindex, nofollow`. The sandbox directive
  means no popups, no modals (`alert()` cannot stall the renderer) and no downloads.
- **The page** (`capture.js`) wipes the origin's storage (including `Clear-Site-Data` from
  `/v1/reset`), fetches the bundle and CSS with `cache: 'no-store'`, validates the import map
  with the protocol schema, and runs the build in a fresh 1280×800 child frame exactly like
  the preview shell (`build-frame.ts`). It does not stub `Math.random` or timers.

## Renderer security

- One fresh browser context per capture; service workers blocked, downloads refused,
  dialogs dismissed.
- **Navigation guard:** the only navigation allowed is the main frame to the exact capture
  URL. Every other navigation request (the main frame again, other frames, popups) is
  answered with HTTP 204, which cancels it and leaves the capture page in place (aborting
  would commit an error page). Popups that still open are closed. If the page is no longer at
  the capture URL, the capture fails rather than photographing something else.
- **Hard timeout** per capture; the job itself has `WORKER_JOB_TIMEOUT_MS` (90 s), well
  inside the 2-minute claim lease.
- Signed URLs are never logged: Playwright error messages are passed through `redactUrls`
  (origin and path only) before they reach logs or `jobs.last_error`.
- Every id is checked to be a canonical UUID before it becomes part of a storage path, and the
  destroy job deletes nothing unless the battle is DESTROYED or ABANDONED.

## Running it

```bash
# Supabase stack (see supabase/README.md), then:
CAPTURE_HMAC_SECRET=$(openssl rand -hex 32) pnpm --filter @br/capture-worker dev:shell  # shell + mock CDN
cp apps/capture-worker/.env.example apps/capture-worker/.env   # fill in, same secret
pnpm --filter @br/capture-worker dev            # loops until SIGINT/SIGTERM
pnpm --filter @br/capture-worker dev -- --once  # drain both queues once and exit

pnpm --filter @br/capture-worker build && node apps/capture-worker/dist/main.js  # bundled
```

`dev`/`start` do not read `.env` by themselves; export the variables (or use
`node --env-file=.env dist/main.js`). Configuration: [.env.example](.env.example). Exit codes:
0 ok, 1 error, 2 bad configuration.

Shutdown: SIGINT/SIGTERM stops claiming, gives the job in flight `WORKER_SHUTDOWN_GRACE_MS`
(30 s) to finish, then aborts it, which records `fail_job('aborted: worker shutting down')`
so it is retried after its backoff instead of waiting for the lease. A second signal exits at
once.

Logs: one JSON object per line on stdout (`t`, `level`, `msg`, plus `job`, `kind`, `build`
or `battle`, `attempt`, `result`, `ms`, `ready`, …).

## Tests

```bash
pnpm --filter @br/capture-worker test              # unit tests, fakes only (part of pnpm test)
pnpm --filter @br/capture-worker test:integration  # real Chromium + the local Supabase stack
```

- Unit (`test/`): readiness rule, blank detection and WebP encoding, the capture job
  (signed URL contents, captured / fallback / retry / final failure / missing bundle /
  aborts), the destroy job (recursive delete, guards), the takedown job (only the build's
  screenshots, the taken-down guard, leftovers retried, aborts), the runner (drain, backoff,
  concurrency, job timeout, graceful and forced shutdown), config, the Supabase client against
  a fake `fetch`, URL redaction.
- Integration, renderer (`integration/renderer.test.ts`, no Supabase): a React build bundled
  with @br/runtime takes the ready signal; a build without it is captured at idle + 2 s; a
  never-ending request hits the 6 s cap; popups, `top.location`, a navigation from the capture
  page's realm and `alert()` are all neutralised; an infinite loop hits the hard timeout and
  the browser keeps working; forged and expired signatures are refused by the gate.
- Integration, stack (`integration/stack.test.ts`): anonymous players play solo battles
  through Auth/PostgREST/Storage. A shipped React build is captured (WebP, 1280×800, not
  blank, dominant colour and white title pixels checked); a bundle that throws on load falls
  back to the client thumbnail; an auto-shipped build is captured from its autosave; a
  throwing bundle without a thumbnail is retried with backoff and fails on the 5th attempt;
  all four battles go to DESTROYED and the destroy worker leaves zero objects, with
  `destroyed_at` / `source_destroyed_at` set and the screenshots kept. Then (T-024) an email
  admin (Auth admin API + `private.admins`) takes alice's build down through
  `admin_take_down_build`: the anon-key results hide it at once, the takedown worker deletes
  its screenshot object (and only that one) and `complete_takedown` closes the job.
  `CAPTURE_TEST_SHOT_OUT=/path/shot.webp` keeps the React screenshot,
  `CAPTURE_TEST_LOG=/path/log.jsonl` the worker log. The test commits data, like
  `supabase/scripts/e2e-solo.mjs`. It runs on a stack other scripts have used: the
  harness's `OwnJobsBackend` claims only the test's own jobs (the product's `claim_job`,
  run as the superuser in one transaction that parks the other jobs and restores them), so
  jobs left by the e2e suites are neither processed nor changed.

## Production: Cloudflare Browser Rendering

`BrowserRenderingRenderer` throws `not-implemented`; the module comment explains the two
options. The recommended one is running this job loop in a Worker with a Browser Rendering
binding and `@cloudflare/playwright`, which keeps `PlaywrightRenderer`'s logic (route guard,
network events, console hints, timeouts). The REST screenshot API is callable from Node but
cannot express the readiness rule or the navigation guard exactly. `sharp` does not run in
workerd: WebP would come from Cloudflare Images, or the PNG is stored (the bucket allows it).

## Known limitations

- The first capture after a browser start spends about 2 s in the page's `Clear-Site-Data`
  fetch (Chromium initialises its storage backends); later captures take a few ms.
- A build can always ruin its own capture (navigate its page, paint nothing, loop forever);
  the result is the thumbnail fallback or `failed`, never someone else's content.
- A uniform single-colour build counts as blank and gets the thumbnail if there is one.
- Autosaves made before the `autosave/bundle.css` slot (T-014) have no CSS file; such a
  build is captured without its CSS.
