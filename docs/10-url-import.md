# 10. Import from a published link (M7)

**Why.** Many vibe coders build in web builders (Lovable, Bolt, v0, Replit). Those give source
code, not a built site, so in M6 these players had to install Node.js and run `npm install`
and `npm run build` (docs/09 §9.6). Every one of these tools has a one-click **Publish** to a
static host (`*.lovable.app`, `*.netlify.app`, `*.vercel.app`, `*.replit.app`, …). In M7 a
player can paste that link instead of dropping a folder. The game copies the published site
into the same site pack as a dropped `dist/` folder (docs/09 §9.2), and everything after the
import (preview, autosave, ship, REVEAL, capture, DESTROY) is unchanged.

Decided by the hub (the user left the choice of the next step to us, 2026-10-21). GitHub
repositories are out of scope: a repository holds source, and building it needs a build
server the free plan does not have.

## 10.1 What a player does

BUILD stage and `/try`: next to *Choose folder* / *Choose .zip*, a field **"…or paste the link
of your published site"** with **Import**. The game shows "Copying your site…", then the
preview, exactly like a dropped folder. **Import again** offers the link again (re-publishing
and importing the same link picks up the changes).

## 10.2 The copier (`@br/site`, pure)

`copySite(url, {fetch, limits})` crawls one published site through an injected `fetch` and
returns the same `{ok, site: {pack, …}}` / `{ok: false, error}` result as `importSite`, so
the app treats both alike.

1. **Start** at the link (an `https:` URL, no credentials, default port). Follow at most
   3 redirects, each re-checked against the host rules (§10.3). The final URL's origin is the
   site's origin; its path becomes the site root (`https://x.lovable.app/` → `/`).
2. **Discover** files breadth-first, same origin only:
   - HTML: `src`, `href` (stylesheets, icons, manifests, `modulepreload`/`preload`), `srcset`,
     `<meta property="og:image">`, inline `<style>`;
   - CSS: `url(…)` and `@import`;
   - JavaScript: static and dynamic `import`, Vite's `__vite__mapDeps([...])` lists, and
     string literals that look like root-relative or relative asset paths with a known
     extension (`"/assets/logo-abc.png"`, `"./chunk-x.js"`);
   - the web manifest's `icons`.
   Cross-origin URLs (CDNs, fonts, APIs) are left as they are: the sandbox loads them itself.
3. **Fetch** with limits: at most 300 files and 5 MB in total (the pack limits), 4 requests
   at a time, 10 s per request, 45 s for the whole copy. A 404 for a discovered *guess* (a
   string literal) is skipped silently; a 404 for the entry page fails the import.
4. **Recognize what cannot be copied** and say so:
   - the entry answers with something other than HTML → "That link isn't a web page";
   - a login wall or password page (a 401/403, or a host's known login page) → "That site is
     private. Publish it publicly first";
   - the result is a page that only works with its server (a server-rendered Next.js app's
     `?_rsc=` navigation, API routes) → not detected up front; the preview shows it, and the
     guide says which builders export static sites.
5. **Pack** with `packSite`: the entry page becomes `index.html`; other paths keep their path
   under the root. Query strings are dropped from stored paths (`app.js?v=3` → `app.js`).

The copier also runs on `/try` locally in tests (a fake `fetch` over fixture sites, and a
local static server in e2e).

## 10.3 Where it runs: the `import-url` Edge Function

Browsers cannot read another site's files (CORS), so the copy runs server-side, in a second
Supabase Edge Function, `import-url` (free plan: 2 s CPU, 150 s wall time per call; fetching
is wall time, the parsing is a few hundred ms at most for 5 MB).

- **Who may call it:** a signed-in user (the anonymous session the app already uses; `/try`
  signs in anonymously the first time a link is imported). Rate limit `import_url`: 20 per
  10 minutes per user (`private.rate_limits`, the existing helper).
- **Which hosts:** an allowlist, so the function is no open proxy and no SSRF tool:
  `*.lovable.app`, `*.netlify.app`, `*.vercel.app`, `*.github.io`, `*.pages.dev`,
  `*.workers.dev`, `*.replit.app`, `*.bolt.host`, `*.surge.sh`, `*.web.app`,
  `*.firebaseapp.com`, `*.onrender.com`, `*.glitch.me`, `*.codesandbox.io`,
  `*.stackblitz.io`. Only `https:`, only the default port, no IP literals, no credentials;
  every redirect hop and every fetched URL is checked again. The list lives in `@br/site`
  (one source for the function, the app's hint text and the tests).
- **What it returns:** the site pack itself (`application/octet-stream`, ≤ 5 MB), or a JSON
  error `{code, detail?}` with the same codes the app already words, plus `url-invalid`,
  `url-host-not-allowed`, `url-unreachable`, `url-not-html`, `url-private`, `url-timeout`,
  `rate-limited`. The function stores nothing: the app then treats the pack like any import
  (preview, `autosave/site.bin` upload, ship).
- **Logs:** one JSON line per copy (host, files, bytes, ms, outcome), no full URLs with query
  strings, no user ids.
- **Deploy:** `scripts/deploy` deploys it next to `jobs`; deploy-check calls it once without
  a session (expects 401).

## 10.4 Security notes

- The function only reads public pages of allowlisted static hosts and returns their bytes;
  it never runs them. The pack runs in the sandbox like any import (docs/03 §3.9).
- A player can link someone else's published site. That is the same as dropping a copy of it
  (R13, accepted: the cards are random and the votes judge the result); the report flow
  handles abuse.
- Abuse of the function as a downloader is bounded by the allowlist, the size and time limits
  and the per-user rate limit.

## 10.5 Tasks

T-051 (copier + `import-url` function + rate limit + deploy) and T-052 (the link field in
BUILD and `/try`, English and Turkish copy, the guide's web-builder tab, e2e). See the board.

## 10.6 As built (T-051)

Where the implementation differs from or adds to the plan above:

- **Types.** `copySite` returns `CopyResult` with a `CopyError` (`UrlImportErrorCode` plus
  `too-large` / `too-many-files`): the same `{ok, site}` / `{ok: false, error}` shape and the
  same `ImportedSite` as `importSite`, but the new codes are not added to `ImportErrorCode`,
  because the app's Turkish catalog is typed by it and T-052 words them.
  `describeImportError` takes both. `rate-limited` is one of the copy codes (its `detail` is
  the wait in seconds). For a copy, `ImportedSite.root` is the copied address
  (`https://my-app.lovable.app/`).
- **More discovery.** Besides §10.2: `<a href>` to same-origin pages (`….html`, `…/`, so a
  hand-written multi-page site comes along), `<iframe src>`, `<base href>`, `srcset` /
  `imagesrcset`, `poster`, `style` attributes, inline module scripts, `twitter:image`,
  `new URL("…", import.meta.url)`, and manifest `screenshots`.
- **Fetched from the host's URL, stored at the sandbox's.** The sandbox's CSP has
  `base-uri 'none'`, so the browser ignores `<base href>` and resolves a page's relative
  references against the page itself. A file is therefore fetched from where the host resolves
  its reference and stored where the sandbox will request it: with `<base href="/static/">`,
  `<link href="a.css">` is fetched from `/static/a.css` and stored as `a.css`, and what
  `a.css` references is stored relative to `a.css`. The page is stored as served, `<base>`
  included (Angular's router and Flutter read it). The same holds after a redirect: the
  sandbox serves a file at its own path, so what a stylesheet redirected from `/style.css` to
  `/v2/style.css` references is stored relative to `style.css`. A `<base>` on another origin
  points at files that are not the site's: they are skipped.
- **Frames.** A frame's page at a path without `.html` (`<iframe src="/embed">`) is stored as
  `embed.html`, which the site worker serves for `/embed`; the single-page-app rule below does
  not apply to it. The site CSP has no `frame-src` (`default-src 'none'`, docs/09 §9.3), so
  the sandbox does not show frames today; the copy keeps them as a dropped folder would.
- **Missing files.** A 404 (any 4xx) for a file the page references is skipped and counted in
  `skipped` instead of failing the copy (a missing favicon should not block an import); a 5xx
  fails it (`url-unreachable`). A guess that hangs or fails is skipped. A non-HTML path that a
  host answers with HTML (the single-page-app fallback) is not a file and is skipped.
- **Private sites.** A redirect to a known login host (`LOGIN_HOSTS`: vercel.com, lovable.dev,
  netlify.com, Cloudflare Access, …) is `url-private`, not `url-host-not-allowed`. A redirect to
  `http:` is `url-invalid`.
- **The function's own codes.** `unauthenticated` (401), `origin-not-allowed` (403, a browser
  `Origin` not in `APP_ORIGINS`), `method-not-allowed` (405), `internal` (500). It logs one line
  per request, preflights included.
- **Auth and the rate limit in one call.** `public.claim_import_url()` is called as the user
  through PostgREST, which verifies the JWT; `verify_jwt` is off so the CORS preflight reaches
  the function. A link refused by the host rules costs no slot.
- **Known limit.** A site published in a folder (a GitHub Pages project site,
  `https://me.github.io/repo/`) is stored relative to that folder and runs at `/` in the
  sandbox: root-relative links to `/repo/…` (Vite's `base: '/repo/'`) miss there. Sites at the
  host's root (every web builder's default) are not affected.
- **Known limit (dropped folders).** `importSite` stores files at their paths in the drop and
  reads no references, so a page whose `<base href>` points elsewhere than its own folder
  (`<base href="/static/">` on `index.html`) misses its relative files in the sandbox, which
  ignores the `<base>`. `<base href="/">` on the root page (Angular's and Flutter's default)
  changes nothing. A copy from a link handles both (above).

## 10.7 As built (T-052)

- The link form sits under *Choose folder* / *Choose .zip* in BUILD and `/try`, and in
  **Import again** ("Copy again from <host>", "Paste a link…"). A copied site takes the same
  path as a dropped folder (preview, IndexedDB, `autosave/site.bin`, ship).
- `/try` signs in anonymously only when a link is imported; folder imports there still make
  no Supabase request (e2e). The link field is hidden when the build has no Supabase URL.
- The last link is remembered per battle and on `/try` (localStorage).
- `site_import` telemetry now has `source` (`drop` / `folder` / `zip` / `link`; it was
  `via`) and the outcome `cancelled`; never the link or its host.
- Cancel stops the browser's request only: the function finishes its copy, so a cancelled
  copy still counts against the 20-per-10-minutes limit.
- A copy holds only the files the pages reference, so it can have fewer files than the same
  site dropped as a folder (an unused `vite.svg` is not copied).
- Test-only origins: `NEXT_PUBLIC_IMPORT_URL_TEST_ORIGINS` is set only by the e2e and
  `dev:solo` builds; `scripts/pages-config.ts` fails a build that sets it with a non-local
  Supabase, or that ships `host.docker.internal` without it.
