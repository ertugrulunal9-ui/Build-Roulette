/**
 * Fixture sites for the copier's tests (copy.test.ts, a fake `fetch`) and the `import-url`
 * function's integration test (integration/, a local static server). Test code only: nothing
 * in the package imports it.
 */
import { contentTypeOf } from './content-types';
import type { CopyFetch } from './copy';

/** One response of a fixture host. A string is a 200 with the type of its extension. */
export type FixtureResponse =
  | string
  | {
      status?: number;
      headers?: Record<string, string>;
      body?: string | Uint8Array<ArrayBuffer>;
      /** Answer after this many ms (aborting rejects with an AbortError). */
      delayMs?: number;
      /** Never answer (until aborted). */
      hang?: boolean;
      /** Reject like a failed connection. */
      fail?: boolean;
    };

/** A site: path (with a leading `/`, optionally with `?query`) → response. */
export type FixtureSite = Record<string, FixtureResponse>;

/**
 * A Vite build (React, as Lovable publishes it): an entry module with static and dynamic
 * imports, `__vite__mapDeps`, CSS with `url()` and `@import`, an image referenced from a
 * JavaScript string, a manifest with icons, and references to other origins.
 */
export const VITE_SITE: FixtureSite = {
  '/': `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <meta property="og:image" content="https://my-app.lovable.app/og.png" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter" />
    <script src="https://cdn.gpteng.co/gptengineer.js" type="module"></script>
    <script type="module" crossorigin src="/assets/index-abc.js"></script>
    <link rel="modulepreload" crossorigin href="/assets/vendor-def.js" />
    <link rel="stylesheet" crossorigin href="/assets/index-xyz.css" />
  </head>
  <body><div id="root"></div></body>
</html>`,
  '/assets/index-abc.js':
    'const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/About-111.js","assets/About-222.css"])))=>i.map(i=>d[i]);\n' +
    'import{r as e}from"./vendor-def.js";\n' +
    'const logo="/assets/logo-abc.png",missing="/assets/hero-missing.webp",api="https://api.example.com/data.json";\n' +
    'const About=()=>__vitePreload(()=>import("./About-111.js"),__vite__mapDeps([0,1]));\n' +
    'e(logo,missing,api,About);\n',
  '/assets/vendor-def.js': 'export const r=(...a)=>a;\n',
  '/assets/About-111.js': 'import"./shared-333.js";export default function About(){}\n',
  '/assets/shared-333.js': 'export const shared=1;\n',
  '/assets/About-222.css': '.about{background:url(./bg-444.jpg)}',
  '/assets/index-xyz.css':
    '@import "./reset.css";@font-face{font-family:x;src:url("/assets/font-555.woff2") format("woff2"),url(data:font/woff2;base64,AAAA)}' +
    ".hero{background:url('../img/pattern.svg?v=2#x')}.ext{background:url(https://images.example.com/x.png)}",
  '/assets/reset.css': '*{margin:0}',
  '/assets/font-555.woff2': 'wOF2',
  '/assets/bg-444.jpg': 'jpeg',
  '/assets/logo-abc.png': 'png',
  '/img/pattern.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
  '/favicon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
  '/og.png': 'png',
  '/manifest.webmanifest': JSON.stringify({
    name: 'My app',
    icons: [{ src: 'icon-192.png' }, { src: '/icon-512.png' }],
  }),
  '/icon-192.png': 'png',
  '/icon-512.png': 'png',
};

/** What copying `VITE_SITE` stores. */
export const VITE_SITE_FILES = [
  'assets/About-111.js',
  'assets/About-222.css',
  'assets/bg-444.jpg',
  'assets/font-555.woff2',
  'assets/index-abc.js',
  'assets/index-xyz.css',
  'assets/logo-abc.png',
  'assets/reset.css',
  'assets/shared-333.js',
  'assets/vendor-def.js',
  'favicon.svg',
  'icon-192.png',
  'icon-512.png',
  'img/pattern.svg',
  'index.html',
  'manifest.webmanifest',
  'og.png',
];

/**
 * A hand-written site in a GitHub Pages project folder (`/portfolio/`), with relative links
 * between its pages, a `srcset`, and a script with two query strings.
 */
export const PLAIN_SITE: FixtureSite = {
  '/portfolio': { status: 301, headers: { location: '/portfolio/' } },
  '/portfolio/': `<!DOCTYPE html><html><head>
    <link rel="stylesheet" href="style.css">
    <script src="app.js?v=3"></script>
  </head><body>
    <img src="img/me.jpg" srcset="img/me.jpg 1x, img/me@2x.jpg 2x" alt="me">
    <a href="about.html">About</a> <a href="projects/">Projects</a>
    <a href="https://twitter.com/someone">Twitter</a>
    <a href="/other-repo/index.html">Another project</a>
    <a href="#top">Top</a>
  </body></html>`,
  '/portfolio/style.css': 'body{background:url(img/bg.png)}',
  '/portfolio/app.js': 'console.log("hi")',
  '/portfolio/img/me.jpg': 'jpeg',
  '/portfolio/img/me@2x.jpg': 'jpeg2',
  '/portfolio/img/bg.png': 'png',
  '/portfolio/about.html': `<html><head><link href="style.css" rel="stylesheet"></head>
    <body><a href="index.html">Home</a><img src="./img/about.png"><a href="gone.html">old</a></body></html>`,
  '/portfolio/img/about.png': 'png',
  '/portfolio/projects/': `<html><body><img src="../img/p.png"><script src="../app.js?v=4"></script></body></html>`,
  '/portfolio/img/p.png': 'png',
};

export const PLAIN_SITE_FILES = [
  'about.html',
  'app.js',
  'img/about.png',
  'img/bg.png',
  'img/me.jpg',
  'img/me@2x.jpg',
  'img/p.png',
  'index.html',
  'projects/index.html',
  'style.css',
];

export interface FakeHost {
  fetch: CopyFetch;
  /** Every URL requested, in order. */
  calls: string[];
  /** The most requests that were in flight at once. */
  readonly maxActive: number;
}

const enc = new TextEncoder();

function abortError(): Error {
  return new DOMException('The operation was aborted.', 'AbortError');
}

/**
 * A fake `fetch` over fixture sites by origin (`{'https://x.lovable.app': VITE_SITE}`). Unknown
 * paths are 404s, or the site's `/` (status 200, as a single-page app host answers) with `spa`.
 */
export function fakeHost(
  sites: Record<string, FixtureSite>,
  opts: { spa?: boolean; delayMs?: number } = {},
): FakeHost {
  const calls: string[] = [];
  let active = 0;
  let maxActive = 0;
  const fetch: CopyFetch = async (href, init) => {
    calls.push(href);
    active++;
    maxActive = Math.max(maxActive, active);
    try {
      const url = new URL(href);
      const site = sites[url.origin];
      if (!site) throw new TypeError(`fetch failed: no host ${url.host}`);
      let r = site[url.pathname + url.search] ?? site[url.pathname];
      let path = url.pathname;
      if (r === undefined && opts.spa && !url.pathname.endsWith('.html')) {
        r = site['/'];
        path = '/';
      }
      const spec = typeof r === 'string' ? { body: r } : (r ?? { status: 404, body: 'Not found' });
      const delay = spec.delayMs ?? opts.delayMs ?? 0;
      if (spec.hang || delay > 0) {
        await new Promise<void>((resolve, reject) => {
          if (init.signal.aborted) {
            reject(abortError());
            return;
          }
          const t = spec.hang ? undefined : setTimeout(resolve, delay);
          init.signal.addEventListener('abort', () => {
            clearTimeout(t);
            reject(abortError());
          });
        });
      }
      if (init.signal.aborted) throw abortError();
      if (spec.fail) throw new TypeError('fetch failed');
      const status = spec.status ?? 200;
      const headers = new Headers(spec.headers);
      if (!headers.has('content-type') && status === 200) {
        headers.set(
          'content-type',
          path.endsWith('/') ? 'text/html; charset=utf-8' : contentTypeOf(path),
        );
      }
      const body = spec.body ?? '';
      return new Response(
        status === 204 || status === 304
          ? null
          : typeof body === 'string'
            ? enc.encode(body)
            : body,
        {
          status,
          headers,
        },
      );
    } finally {
      active--;
    }
  };
  return {
    fetch,
    calls,
    get maxActive() {
      return maxActive;
    },
  };
}
