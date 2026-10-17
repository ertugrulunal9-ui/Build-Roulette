# 9. Import mode: bring your own build (M6)

**User decision (2026-10-16).** Vibe coders build with their own AI tools (Cursor, Claude
Code, Windsurf, Lovable, Bolt, …) on their own machine. The way each player drives their tool
is the game: everyone gets the same cards, the products differ. Build Roulette therefore stops
being an in-browser IDE. A player builds locally, runs their project's build, and **drops the
built site** (the `dist/` folder, or a `.zip` of it) into the BUILD stage. The in-browser
editor, the bundler and the package CDN are removed (user: "tarayıcı editörünü istemiyorum").

This document supersedes the editing and bundling parts of [03-sandbox](03-sandbox.md)
(§3.3 workspace model, §3.4 build pipeline, the package CDN sections) and the file layout of
[05-database](05-database.md) §5.5. Isolation, the bridge, the watchdog, capture, and
destroy keep their design; what they load changes.

```
SPIN → BUILD (locally, any tool) → IMPORT dist/ → SHIP → REVEAL → VOTE → RESULTS → DESTROY
```

## 9.1 What a player does

1. **SPIN.** BUILD / RULE / STYLE / TIME LIMIT cards, as before.
2. **BUILD, locally.** Any tool, any framework, any prompt. The only requirement: the result is
   a **static site** (HTML, JS, CSS, assets) that runs in a browser without a server of its own.
3. **Build it.** `npm run build` (or "build it" to the AI agent). Plain HTML projects need no
   build.
4. **Import.** Drag the `dist/` folder (or the whole project folder, or a `.zip`) onto the
   BUILD stage, or pick it with a button. The site runs in the preview at once. Importing again
   replaces it; the last import before the deadline counts.
5. **SHIP** (or the deadline auto-ships the last import), REVEAL, VOTE, RESULTS, DESTROY: unchanged.

## 9.2 The site pack (`@br/site`)

One import becomes one immutable **site pack**, stored as one object (`site.bin`), so storage
keeps a fixed allowlist of file names (no free file hosting, docs/05 §5.5).

**Import (browser, app origin).** Input is a list of `{path, bytes}` from a dropped folder
(`DataTransferItem.webkitGetAsEntry` traversal), a folder picker (`webkitdirectory`), loose
files, or a `.zip` (unzipped in the browser with `fflate`).

1. **Normalize paths:** `\` → `/`, strip one shared top-level folder, reject absolute paths,
   `..`, NUL and control characters.
2. **Ignore:** `node_modules/`, `.git/`, any dotfile or dot-folder, `*.map`, `.DS_Store`,
   `Thumbs.db`, `__MACOSX/`.
3. **Find the site root:** the shallowest folder holding an `index.html`, preferring known
   output folders (`dist/`, `build/`, `out/`, `.output/public/`, `_site/`) over the project
   root. Only files under the root are packed.
4. **Recognize source code instead of a build**, with a message that says what to do:
   - an `index.html` whose scripts point at `.ts`, `.tsx`, `.jsx`, `.vue`, `.svelte` (Vite's
     unbuilt `index.html`) → "This is your project's source. Run `npm run build` (or ask your
     AI tool to build it) and drop the `dist` folder.";
   - a `package.json` and no `index.html` in an output folder → the same message;
   - `.next/` without `out/` → "Next.js needs a static export: set `output: 'export'`…".
5. **Limits** (`SITE_LIMITS` in `@br/site`): pack ≤ **5 MB**
   (the bucket's file limit), ≤ **300** files, path ≤ 200 characters.
6. **Pack:** `BRSITE1\n` magic, a little-endian u32 header length, a UTF-8 JSON header
   `{v: 1, files: [{p, t, s}]}` (path, content type, size; sorted by path), then the bytes of
   every file in header order. The content type comes from the extension (an allowlist; others
   are `application/octet-stream`). `unpack` validates everything (magic, bounds, sizes, paths,
   duplicates) and is shared by the app, the shell and the capture page, so it has no
   dependencies.

Stats shown in RESULTS: `files`, `bundle_bytes` (pack size), `imports` (how many imports the
player made).

## 9.3 Running a site in the sandbox (shell v2)

A built site is a **multi-file** site with **root-relative URLs** (Vite's default
`/assets/index-abc.js`), lazily loaded chunks (`import('./chunk.js')`), `fetch('/data.json')`,
workers, and often a client-side router that expects `location.pathname === '/'`
(Lovable-style `react-router` apps render their 404 route anywhere else). A blob URL or a
`document.write` document cannot serve that. **A Service Worker on the sandbox origin serves
the site** as if it were a static host.

- **Protocol v2.** The shell moves to `/v2/` (`PROTOCOL_VERSION = 2`). `load` becomes
  `{type: 'load', loadId, mode, site: ArrayBuffer}` (the pack, transferred). `js`, `css`,
  `importMap` and `packages` are gone, and so are the T-032 package warm-up and package
  failure messages.
- **The worker:** `/v2/sw.js`, registered by the shell with `scope: '/'`
  (`Service-Worker-Allowed: /`) and `updateViaCache: 'none'`. Per load the shell picks a fresh
  random site id, posts the unpacked files to the worker over a `MessageChannel`, waits for
  the ack, then navigates a **fresh child frame** to `/?__br_site=<id>`.
- **Which site a request belongs to:** a navigation carrying `__br_site` maps its
  `resultingClientId` to that site. Every later request from that client (`event.clientId`)
  is served from the same site. A navigation without a site (an in-site link to
  `/about.html`, `location.reload()`) is served from the latest site of the requesting frame's
  shell, falling back to the latest site. Requests from clients that are not sites (the shell
  page itself, `/v2/reset`, the capture page) and cross-origin requests are not intercepted.
- **Static-host rules:** `/` and `…/` → `index.html`; an exact file; `path.html`;
  `path/index.html`; an unknown **navigation** gets `index.html` (SPA fallback, status 200);
  other misses are 404. Content types from the pack.
- **Bootstrap:** every HTML response gets one inline script injected as the first child of
  `<head>`. It removes `__br_site` from the address with `history.replaceState` (the router sees
  `/`) and calls the shell's `__brAttach(window)` (console and error forwarding, and
  `window.buildRoulette.ready()`, as `instrument` and `installBuildApi` did for the old build
  document). HTML responses carry the build CSP (below) and the shell's other security headers.
- **Surviving worker restarts:** the browser may stop an idle worker, so the worker keeps the
  sites and the client → site map in Cache Storage (a few most recent sites only), not only in
  memory.
- **`ready`:** the frame's `load` event. A site that cannot be served (no worker support, a
  pack that fails `unpack`) reports a `module-load` runtime error that says so.
- **CSP of a site** (the shell's policy, adjusted): `script-src 'self' 'unsafe-inline'
  'unsafe-eval' blob: https:` (built sites load scripts from CDNs, such as the Tailwind play
  CDN or unpkg; a build is arbitrary JavaScript already and `connect-src https:` already allows
  `fetch` + `eval`, so this widens nothing), `worker-src 'self' blob:`, and `frame-ancestors
  'self' <app origins>` (`'self'` only on the capture page). The rest is unchanged.
- **Capture page:** `/v2/capture?src=<signed site.bin URL>&exp=&sig=` (no `css`, no `map`).
  It wipes origin storage, fetches the pack, registers the worker and loads the site the same
  way. The HMAC and the gate are unchanged except for the parameters.

### Threat model changes (§3.9)

- **A build cannot replace the worker.** Service Worker scripts come from the network, never
  from a worker's responses, and the sandbox host serves only `/v2/sw.js`. Build code may
  unregister the worker, which only breaks its own preview: the shell registers it again on
  every load.
- **Cache Storage is writable by build code** (same origin). A build can damage its own site
  or a site running at the same time in the same browser partition. Site ids are random
  (128 bits) and new for every load, and REVEAL wipes the origin (`reset-storage`, which
  unregisters the worker and clears Cache Storage) before each other player's build, as it
  already does. Stage 1 already lets concurrent builds on the one sandbox origin reach each
  other; per-build origins (stage 2, finding F1) remove that.
- **Browser support.** Service Workers in a cross-site iframe work with storage
  partitioning in current Chromium, Firefox and Safari. Private windows in Firefox disable
  Service Workers: the preview then shows a clear error (and REVEAL the screenshot).

## 9.4 Storage and database

| Object | When |
|---|---|
| `{battle}/{uid}/autosave/site.bin` | Every successful import during BUILD (so the deadline can auto-ship it) |
| `{battle}/{uid}/site.bin` | SHIP |
| `{battle}/{uid}/thumb.webp` | SHIP (client thumbnail, the capture fallback) |

- The write allowlist becomes exactly these three names. The bucket allows
  `application/octet-stream` and `image/webp`; the file size limit stays 5 MB.
- `ship_build` requires `site.bin`; the auto-ship requires `autosave/site.bin`.
- REVEAL read access returns the one `site` path (shipped: `site.bin`, auto-shipped:
  `autosave/site.bin`). There is no `source.json` any more, so nothing private stays behind:
  what a player imports is exactly what everyone sees in REVEAL.
- `clean_build_stats` accepts `imports`.
- Capture (the jobs Edge Function and the self-hosted capture worker) signs one URL for the
  site pack and opens the v2 capture page. No manifest, no import map.
- DESTROY is unchanged (it deletes the whole `{battle}/` prefix).

## 9.5 The app

- **BUILD stage:** the cards, the countdown, a large drop zone ("Drop your built site: the
  `dist` folder or a .zip"), *Choose folder* / *Choose .zip*, then the live preview with what
  was imported (root folder, file count, size) and *Import again*. **Ship it** is enabled once
  a site is imported. Errors say what to do next (§9.2). A reload restores the last import
  (IndexedDB on the app origin, then the remote autosave).
- **`/try`** replaces `/playground`: drop a site and see it run, no battle and no account. It is
  the practice step of the onboarding.
- **Removed:** CodeMirror, the file tree, paste-import, templates, the bundler worker and
  esbuild-wasm, `TemplateWarmup`, `@br/workspace`, the package CDN (`apps/pkg-cdn`, esm.sh
  settings, the compat suite).
- **Rooms:** the progress sidebar shows "imported" / "shipped" instead of edit activity.
  Phones still watch and vote (building needs a computer).

## 9.6 Onboarding (after the import path works)

- A **welcome screen** on the first visit, reachable later as **How it works**: what the game
  is, the four steps (spin, build with your own AI tool, build and drop `dist/`, ship / reveal /
  vote), with a short "what counts as a static site" note.
- **Per-tool tips:** agent tools in an editor (Cursor, Claude Code, Windsurf, Copilot): "ask it
  to run `npm run build`"; web builders (Lovable, Bolt, v0): how to get the code and build it.
- **In the BUILD stage:** a collapsible "How do I import?" next to the drop zone, and error
  messages that link to it.
- **Practice:** the welcome screen points at `/try` before the first battle.

## 9.7 More user decisions (2026-10-16)

- **Build time limits** become **10, 15, 20, 30 and 45 minutes** (were 3–30). Building with a
  local tool, running the build and importing needs more than 3–5 minutes. The random solo
  default draws from 10, 15 and 20.
- **Language:** the UI stays English by default, and players can switch it to **Turkish**
  (a language picker, remembered per browser). Dynamic text from the server (cards, names)
  is not translated.
- **Later, not in M6:** importing from a GitHub repository or a published URL (useful for
  web builders such as Lovable, Bolt and v0, which give source code, not a build).

## 9.8 Tasks

See the M6 section of the [board](BOARD.md): T-044 (`@br/site`), T-045 (shell v2 and
runtime), T-046 (storage, database and capture), T-047 (the app), T-048 (removals and docs),
T-049 (onboarding), T-050 (English / Turkish).
