# Deploying `@br/web` to Cloudflare

The web app runs on **Cloudflare Workers** through the OpenNext adapter
(`@opennextjs/cloudflare`). One deploy uploads two things:

- **A Worker** (`.open-next/worker.js` plus the server code). It renders the dynamic pages
  (`/r/[code]`, `/u/[id]`, `/admin`), renders `/battles/[id]` and its OG image when they are
  not cached, and answers cached pages from the incremental cache (R2, see "Caching").
- **Static assets** (`.open-next/assets`): JS/CSS chunks, the playground's bundler worker
  chunk and `esbuild.wasm`. Cloudflare serves these directly, without running the Worker,
  and asset requests are free.

Everything below runs from the repository root. Nothing here is needed for local work.

## Try it locally first (no account needed)

```sh
pnpm --filter @br/web cf:build      # next build + OpenNext → apps/web/.open-next/
pnpm --filter @br/web cf:preview    # serves it with workerd (the real Workers runtime) on http://localhost:8787
pnpm --filter @br/web test:e2e:cf   # cf:build, then the Playwright suite against the preview
pnpm --filter @br/web test:e2e:cf:moderation   # cf:build, then moderation + the ISR cache (needs the local stack)
```

The preview emulates the cache bindings (R2, D1, the Durable Object queue) in
`apps/web/.wrangler/state`, and fills them first (the prerendered pages, the D1 table).
While it does, it prints two warnings about `DOQueueHandler` ("will not work in local
development", "no such Durable Object class is exported"): they come from that fill step,
which runs without the Worker. The Worker itself exports the class and the queue works.

`/playground` also needs the sandbox servers (`pnpm --filter @br/web dev:sandbox`) with the
preview origin allowed: `BR_APP_ORIGINS=http://localhost:8787 pnpm --filter @br/web dev:sandbox`.

Wrangler prints `Unable to fetch the Request.cf object` when it can't reach
`workers.cloudflare.com` (for example behind a proxy). It is harmless: it falls back to
placeholder geo data.

## One-time setup

1. **Create a Cloudflare account** at <https://dash.cloudflare.com/sign-up>.
2. **Choose the Workers Paid plan** (Workers & Pages → Plans, about US$5/month). The free
   plan allows only 10 ms of CPU per request, which server rendering React pages can exceed,
   and caps the Worker at 3 MB compressed. Today's Worker is about 2.1 MB compressed
   (`wrangler deploy --dry-run`, T-026; 1.9 MB before the cache), and a `proxy.ts`
   (middleware) would add about 1.2 MB (measured in the T-012 spike). Paid allows 10 MB.
3. **Log in from your machine** (opens a browser once):
   ```sh
   pnpm --filter @br/web exec wrangler login
   ```
   For CI, create an API token instead (My Profile → API Tokens → "Edit Cloudflare Workers"
   template) and set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as CI secrets.
   The account id is on the Workers & Pages overview page. It does not go in
   `wrangler.jsonc`.
4. **Optional:** rename the Worker. `name` in `apps/web/wrangler.jsonc` (currently
   `build-roulette-web`) becomes the free URL `https://<name>.<your-subdomain>.workers.dev`.
   If you change it, change the `WORKER_SELF_REFERENCE` service name to match.
5. **Create the cache's storage** (once per account; details in "Caching"):
   ```sh
   # The incremental cache (cf:deploy would also create it if missing).
   pnpm --filter @br/web exec wrangler r2 bucket create build-roulette-web-cache
   # Every deploy writes under a new build id: drop what old builds left behind.
   pnpm --filter @br/web exec wrangler r2 bucket lifecycle add build-roulette-web-cache expire-old-builds incremental-cache/ --expire-days 30
   # The tag cache. Pick the location next to the Supabase project's region (enam, weur, apac…).
   pnpm --filter @br/web exec wrangler d1 create build-roulette-web-tags --location <hint>
   ```
   Put the `database_id` that `d1 create` prints into `apps/web/wrangler.jsonc`, in the
   `NEXT_TAG_CACHE_D1` entry of `d1_databases` (the one value the repository can't know).
   The revalidation queue is a Durable Object: nothing to create, the first deploy applies
   the `migrations` entry (`v1`, class `DOQueueHandler`). Never edit or remove that entry;
   renaming the class needs a new migration.

## Deploying

```sh
NEXT_PUBLIC_SANDBOX_SHELL_URL=https://<sandbox>.pages.dev/v1/ \
NEXT_PUBLIC_PKG_CDN_URL=https://<package-cdn-host> \
NEXT_PUBLIC_SUPABASE_URL=https://<project>.supabase.co \
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon or publishable key> \
NEXT_PUBLIC_SITE_URL=https://<app-origin> \
  pnpm --filter @br/web cf:build
pnpm --filter @br/web cf:deploy
```

- `cf:deploy` runs `opennextjs-cloudflare deploy`. It first uploads the prerendered pages
  (`/`, `/play`, `/playground`) to the R2 cache and creates the D1 `revalidations` table if
  it is missing, and then runs `wrangler deploy`. Use it rather than plain
  `wrangler deploy`, which skips both.
- `NEXT_PUBLIC_*` values are baked into the browser code **at build time**, so set them when
  you run `cf:build`, not in the Cloudflare dashboard. Without them the build points at the
  local dev servers (`127.0.0.1:4321`, `localhost:4322`) and the local Supabase stack
  (`127.0.0.1:54321` with its demo anon key). The anon/publishable key is public by design;
  the service-role key never goes into the web app. The sandbox shell must also be
  built to allow the app's production origin (see `apps/sandbox-shell`).
- Every deploy creates a new version. To roll back, use Workers & Pages → `build-roulette-web`
  → Deployments, or run `wrangler rollback`.

## Secrets and settings

- **Secrets** (Supabase service-role key, Turnstile secret, and so on) are read on the
  server at request time through `process.env.NAME`. Set each one once per environment:
  ```sh
  pnpm --filter @br/web exec wrangler secret put TURNSTILE_SECRET_KEY
  ```
  (It prompts for the value. They are also editable under Worker → Settings → Variables and
  Secrets.)
- **Non-secret runtime settings** go in `wrangler.jsonc` under `"vars": { ... }`.
- **Locally**, put runtime secrets in `apps/web/.dev.vars` (`NAME=value` lines). It is
  gitignored. `cf:preview` reads it.

## Custom domain

1. Add the domain to Cloudflare (Websites → Add a site) and switch the registrar's
   nameservers to the two Cloudflare gives you. This can take a few hours.
2. Attach it to the Worker: Workers & Pages → `build-roulette-web` → Settings →
   Domains & Routes → Add → Custom domain. You can also add it to `wrangler.jsonc` so
   deploys keep it:
   ```jsonc
   "routes": [{ "pattern": "buildroulette.example", "custom_domain": true }]
   ```
   Cloudflare creates the DNS record and TLS certificate.
3. Build with `NEXT_PUBLIC_SITE_URL` set to the real origin (it becomes `metadataBase` in
   `src/app/layout.tsx`). Otherwise OG image URLs point at `http://localhost:3000`.

## Caching

**As implemented (T-026).** The permanent pages are cached, and a takedown shows at once.

| Page | How | Lifetime | Tags |
|---|---|---|---|
| `/battles/[id]` and `/battles/[id]/opengraph-image` | ISR: rendered on the first visit, then served from the cache (`force-static`) | **1 hour** once the battle is DESTROYED with `destroyed_at` set (it can't change by itself any more). **5 s** while it can: RESULTS (the screenshots land), or DESTROYED before the destroy job stamps `destroyed_at`. **5 s** for "no public battle" (an unknown id, or a battle not in RESULTS yet), so its 404 never sticks. 1 hour for a malformed id. | `battle:{id}` |
| `/u/[id]` | Rendered per request (its pagination is in the query string); its data is cached | **At most 60 s**: fresh for 30 s, then served once more while it refreshes, never older than 60 s | `player:{id}`, plus `battle:{id}` of every battle on the page |
| `/`, `/play`, `/playground` | Prerendered at build time | Until the next deploy | — |

The rules live in `src/lib/cache/policy.ts` (unit-tested). How it works:

- `get_public_battle` and `get_player_history` are read through `'use cache'` functions
  (`loadPublicBattle`, `loadPlayerHistory`). They call `cacheLife()` with the lifetime the
  answer deserves and `cacheTag()` with the tags above. An ISR page takes on the lifetime
  and the tags of the data it reads, so one rule covers both. A failed read throws and is
  not cached; an ISR page then keeps serving its last good copy.
- This needs `experimental.useCache` in `next.config.ts`. Next 16 marks the flag deprecated
  in favour of `cacheComponents`, which would also turn every other route into a partial
  prerender (and needs cache interception off). Revisit when a Next upgrade drops the flag.
- The pages read no cookies or headers (`force-static` would hand them empty ones anyway;
  the viewer's "Your battle history" link is a client component). The fetches use the anon
  key and the responses set no cookie, so a cached copy holds nothing about the viewer.
- **A takedown** (`/admin`, `takeDownAction`) expires `battle:{id}` with `updateTag`. The
  battle id comes from `admin_take_down_build`'s answer, not from the form. That covers
  the battle's page, its OG image and every history page that lists it, the builder's
  included. The next request renders a fresh copy; it is not served the old one once more.
- Ten seconds later the action expires the page and the OG image again, by path (`after()`,
  which is `waitUntil` on Workers). A render that read the battle just before the takedown
  could have stored its copy just after it. (By path because OpenNext writes a tag only
  once per request; a path also reaches the cached data those pages read.)
- No other admin action changes a public page (dismissed reports are never shown).
- A takedown made **outside** `/admin` (SQL in the dashboard) revalidates nothing: the
  cached copies keep showing the build for up to an hour (a minute on `/u/[id]`). Take
  builds down from `/admin`.

**On Cloudflare** (`open-next.config.ts`, `wrangler.jsonc`) the cache uses three bindings:

| Binding | What | Resource |
|---|---|---|
| `NEXT_INC_CACHE_R2_BUCKET` | Incremental cache: the ISR copies, the `'use cache'` data, the prerendered pages. Keys are per build id, so every deploy starts cold. | R2 bucket `build-roulette-web-cache` |
| `NEXT_TAG_CACHE_D1` | Tag cache ("next mode": one row per revalidated tag). Every cached answer checks it, so a takedown is seen in every region at once. | D1 database `build-roulette-web-tags`, table `revalidations` (created by `cf:deploy`) |
| `NEXT_CACHE_DO_QUEUE` | Revalidation queue. A copy past its lifetime is served once more (`x-opennext-cache: STALE`) and regenerated in the background through `WORKER_SELF_REFERENCE`. | Durable Object class `DOQueueHandler` (migration `v1`) |

Cache interception stays on: a cached page is answered from R2 before the Next server loads
(`x-opennext-cache: HIT`); a miss reaches Next (`x-nextjs-cache: MISS`).

Things to know:

- **Each cached answer costs one R2 read and one D1 query.** D1 lives in one location (the
  `--location` hint in "One-time setup"), so a viewer far from it waits for that round
  trip. When traffic grows, put `withRegionalCache(r2IncrementalCache, { mode: "long-lived" })`
  in front of R2 (the Cache API of each data center), and move the tag cache to the
  sharded Durable Object one (`doShardedTagCache`, which has its own regional cache; it
  needs a `DOShardedTagCache` binding and migration). See
  <https://opennext.js.org/cloudflare/caching>.
- The pages send `Cache-Control: s-maxage=…` for Next's own cache. Don't add a Cloudflare
  "Cache Everything" rule (or another CDN) in front of the Worker: a copy cached there would
  not see takedowns.
- OpenNext's interceptor uses only the `revalidate` part of a lifetime, not `expire`, so an
  old copy is always served once more while it regenerates. (`next start` also honours
  `expire`: a day for a settled battle, a minute otherwise.)
- If the tag write of a takedown fails (D1 down), OpenNext logs it and the admin is not
  told. The copies then live out their lifetime; the hour is that safety net.
- The OG image fetches the screenshot with `no-store`: only the finished PNG is cached,
  never a copy of a screenshot that a takedown deletes from Storage.

Check it after a deploy (with any settled battle):

```sh
curl -sI https://<app-origin>/battles/<id> | grep -i x-opennext-cache   # the 2nd time: HIT
```

Locally, `pnpm --filter @br/web test:e2e:cf:moderation` (with the local stack up) runs
`e2e/isr.spec.ts` and `e2e/moderation.spec.ts` against the Workers preview. It checks a HIT
on the second request, database changes staying hidden until the takedown, the takedown
showing at once on the page, the OG image and `/u/[id]`, the second expiry, and a 404 that
lives for seconds.

## Limits to keep in mind

| Limit | Value | Us today |
|---|---|---|
| Worker size (compressed) | 3 MB free / 10 MB paid | ~2.1 MB (T-026) |
| One static asset | 25 MiB | `esbuild.wasm` is 13.3 MiB |
| Static asset count | 20,000 per version | ~25 |
| CPU per request | 10 ms free / 30 s default on paid | SSR pages are small |
| `waitUntil` after the response | 30 s | the takedown's second expiry waits 10 s |
| R2 / D1 per cached answer | one R2 read, one D1 query (rows read: one per tag) | a takedown writes one D1 row per tag |
