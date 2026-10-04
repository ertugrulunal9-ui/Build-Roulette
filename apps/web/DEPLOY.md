# Deploying `@br/web` to Cloudflare

The web app runs on **Cloudflare Workers** through the OpenNext adapter
(`@opennextjs/cloudflare`). One deploy uploads two things:

- **A Worker** (`.open-next/worker.js` plus the server code). It renders the dynamic pages
  (`/r/[code]`, `/battles/[id]`, later route handlers and OG images).
- **Static assets** (`.open-next/assets`): JS/CSS chunks, the playground's bundler worker
  chunk and `esbuild.wasm`. Cloudflare serves these directly, without running the Worker,
  and asset requests are free.

Everything below runs from the repository root. Nothing here is needed for local work.

## Try it locally first (no account needed)

```sh
pnpm --filter @br/web cf:build      # next build + OpenNext → apps/web/.open-next/
pnpm --filter @br/web cf:preview    # serves it with workerd (the real Workers runtime) on http://localhost:8787
pnpm --filter @br/web test:e2e:cf   # cf:build, then the Playwright suite against the preview
```

`/playground` also needs the sandbox servers (`pnpm --filter @br/web dev:sandbox`) with the
preview origin allowed: `BR_APP_ORIGINS=http://localhost:8787 pnpm --filter @br/web dev:sandbox`.

Wrangler prints `Unable to fetch the Request.cf object` when it can't reach
`workers.cloudflare.com` (for example behind a proxy). It is harmless: it falls back to
placeholder geo data.

## One-time setup

1. **Create a Cloudflare account** at <https://dash.cloudflare.com/sign-up>.
2. **Choose the Workers Paid plan** (Workers & Pages → Plans, about US$5/month). The free
   plan allows only 10 ms of CPU per request, which server rendering React pages can exceed,
   and caps the Worker at 3 MB compressed. Today's Worker is about 0.8 MB compressed, but a
   `proxy.ts` (middleware) adds about 1.2 MB and `next/og` about 0.3 MB (measured in the
   T-012 spike). Paid allows 10 MB.
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

## Deploying

```sh
NEXT_PUBLIC_SANDBOX_SHELL_URL=https://<sandbox>.pages.dev/v1/ \
NEXT_PUBLIC_PKG_CDN_URL=https://<package-cdn-host> \
  pnpm --filter @br/web cf:build
pnpm --filter @br/web cf:deploy
```

- `cf:deploy` runs `opennextjs-cloudflare deploy`. It first copies the prerendered pages
  (`/`, `/playground`) into the static assets, where the Worker's cache reads them, and then
  runs `wrangler deploy`. Use it rather than plain `wrangler deploy`, which skips that copy.
- `NEXT_PUBLIC_*` values are baked into the browser code **at build time**, so set them when
  you run `cf:build`, not in the Cloudflare dashboard. Without them the build points at the
  local dev servers (`127.0.0.1:4321`, `localhost:4322`). The sandbox shell must also be
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
3. Set `metadataBase` in `src/app/layout.tsx` to the real origin. Otherwise OG image URLs
   point at `http://localhost:3000`.

## Caching (when `/battles/[id]` gets ISR)

Right now `open-next.config.ts` uses the read-only **static-assets cache**: prerendered pages
are served from Workers static assets, and everything else is rendered per request. That
cache can't store regenerated pages. When results pages become ISR
(`export const revalidate = …`), switch to R2. You'll need:

1. An R2 bucket: `pnpm --filter @br/web exec wrangler r2 bucket create build-roulette-web-cache`.
2. In `wrangler.jsonc`:
   ```jsonc
   "r2_buckets": [{ "binding": "NEXT_INC_CACHE_R2_BUCKET", "bucket_name": "build-roulette-web-cache" }]
   ```
3. In `open-next.config.ts`: `incrementalCache: r2IncrementalCache` (from
   `@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache`), and a
   revalidation queue: the Durable Object queue (`overrides/queue/do-queue`, binding
   `NEXT_CACHE_DO_QUEUE`, class `DOQueueHandler`) in production.
4. Only if we call `revalidatePath`/`revalidateTag` (for example when a battle finishes): a
   tag cache, either D1 (`NEXT_TAG_CACHE_D1`) or the sharded Durable Object one.

The spike checked R2 + time-based revalidation in the local preview: the first request is
cached, later requests come back `HIT`, and after `revalidate` seconds you get one `STALE`
response and then the regenerated page. See https://opennext.js.org/cloudflare/caching.

## Limits to keep in mind

| Limit | Value | Us today |
|---|---|---|
| Worker size (compressed) | 3 MB free / 10 MB paid | ~0.8 MB |
| One static asset | 25 MiB | `esbuild.wasm` is 13.3 MiB |
| Static asset count | 20,000 per version | ~25 |
| CPU per request | 10 ms free / 30 s default on paid | SSR pages are small |
