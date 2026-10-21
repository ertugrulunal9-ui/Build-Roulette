import { describe, expect, it } from 'vitest';
import { discoverCss, discoverHtml, discoverJs, discoverManifest, srcsetUrls } from './discover';

const refs = (list: { ref: string }[]) => list.map((r) => r.ref);

describe('discoverHtml', () => {
  it('finds scripts, stylesheets, icons, manifests, preloads, images and og:image', () => {
    const { refs: found, base } = discoverHtml(`<!doctype html>
      <html><head>
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <link rel="apple-touch-icon" href=apple.png>
        <link rel="manifest" href="/site.webmanifest">
        <link rel="modulepreload" crossorigin href="/assets/vendor.js">
        <link rel="preload" as="image" href="/hero.webp" imagesrcset="/hero-1x.webp 1x, /hero-2x.webp 2x">
        <link rel="stylesheet" href="/assets/index.css">
        <link rel="canonical" href="https://my-app.lovable.app/">
        <link rel="preconnect" href="https://fonts.gstatic.com">
        <meta property="og:image" content="https://my-app.lovable.app/og.png">
        <meta name="description" content="/not-a-file.png">
        <script type="module" crossorigin src="/assets/index.js"></script>
        <!-- <script src="/commented-out.js"></script> -->
        <style>.x { background: url(/bg.png) }</style>
      </head><body>
        <img src="logo.png" srcset="logo.png 1x, logo@2x.png 2x" alt="a > b">
        <picture><source srcset="a.avif"></picture>
        <video poster="poster.jpg"><source src="clip.mp4"></video>
        <div style="background-image: url('tile.png')"></div>
        <img src="data:image/png;base64,AAAA">
        <a href="about.html">About</a> <a href="blog/">Blog</a> <a href="/contact">no ext</a>
        <a href="#top">top</a> <a href="mailto:a@b.c">mail</a>
      </body></html>`);
    expect(base).toBeNull();
    expect(refs(found).sort()).toEqual(
      [
        '/assets/index.js',
        '/bg.png',
        '/favicon.svg',
        'apple.png',
        '/site.webmanifest',
        '/assets/vendor.js',
        '/hero.webp',
        '/hero-1x.webp',
        '/hero-2x.webp',
        '/assets/index.css',
        'https://my-app.lovable.app/og.png',
        'logo.png',
        'logo.png',
        'logo@2x.png',
        'a.avif',
        'poster.jpg',
        'clip.mp4',
        'tile.png',
        'about.html',
        'blog/',
      ].sort(),
    );
    expect(found.find((r) => r.ref === '/site.webmanifest')?.as).toBe('manifest');
    expect(found.find((r) => r.ref === 'about.html')?.as).toBe('page');
    expect(found.every((r) => r.kind === 'sure')).toBe(true);
  });

  it('reads inline scripts as JavaScript (not JSON) and the <base href>', () => {
    const { refs: found, base } = discoverHtml(`<base href="/app/">
      <script type="module">import "/assets/inline-dep.js"; import("./lazy.js")</script>
      <script type="application/ld+json">{"logo": "/ld-logo.png"}</script>
      <script>const s = "\${x}/a.png"</script>`);
    expect(base).toBe('/app/');
    expect(refs(found.filter((r) => r.kind === 'sure'))).toEqual([
      '/assets/inline-dep.js',
      './lazy.js',
    ]);
    expect(refs(found)).not.toContain('/ld-logo.png');
  });

  it('decodes entities in attributes', () => {
    expect(refs(discoverHtml('<img src="a.png?x=1&amp;y=2">').refs)).toEqual(['a.png?x=1&y=2']);
  });
});

describe('srcsetUrls', () => {
  it('splits candidates the way browsers do', () => {
    expect(srcsetUrls('a.png 1x, b.png 2x')).toEqual(['a.png', 'b.png']);
    expect(srcsetUrls('a.png,b.png')).toEqual(['a.png,b.png']);
    expect(srcsetUrls('a.png, b.png')).toEqual(['a.png', 'b.png']);
    expect(srcsetUrls('/img/w_100,h_100/a.jpg 100w, /img/b.jpg 200w')).toEqual([
      '/img/w_100,h_100/a.jpg',
      '/img/b.jpg',
    ]);
    expect(srcsetUrls('  ')).toEqual([]);
  });
});

describe('discoverCss', () => {
  it('finds url() and @import, without data: URLs and comments', () => {
    expect(
      refs(
        discoverCss(`@import "reset.css"; @import url(theme.css);
          /* url(commented.png) */
          @font-face { src: url("/f.woff2") format("woff2"), url(data:font/woff2;base64,AA) }
          .a { background: url( '../img/p.svg?v=2#frag' ) } .b { mask: url(#svg-mask) }`),
      ),
    ).toEqual(['theme.css', '/f.woff2', '../img/p.svg?v=2#frag', 'reset.css']);
  });
});

describe('discoverJs', () => {
  it('finds static and dynamic imports and re-exports, not bare packages', () => {
    const found = discoverJs(
      `import{r as e,j as t}from"./vendor-abc.js";import"./side.js";import x from '/abs.js';` +
        `export*from"./re.js";export{a as b}from"./re2.js";import React from "react";` +
        `const L=()=>import("./Lazy-1.js");const M=import('../up.js');` +
        `const w=new URL("./worker-9.js",import.meta.url);x.import("./not-import.js")`,
    );
    const sure = found.filter((r) => r.kind === 'sure').map((r) => r.ref);
    expect(sure.sort()).toEqual(
      [
        './vendor-abc.js',
        './side.js',
        '/abs.js',
        './re.js',
        './re2.js',
        './Lazy-1.js',
        '../up.js',
        './worker-9.js',
      ].sort(),
    );
  });

  it("reads Vite's __vite__mapDeps list relative to the root (and the file, as a guess)", () => {
    const found = discoverJs(
      'const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/About-1.js","assets/About-2.css"])))=>i.map(i=>d[i]);',
    );
    expect(found).toEqual(
      expect.arrayContaining([
        { ref: 'assets/About-1.js', kind: 'sure', base: 'root' },
        { ref: 'assets/About-2.css', kind: 'sure', base: 'root' },
        { ref: 'assets/About-1.js', kind: 'guess' },
      ]),
    );
  });

  it('guesses string literals that look like asset paths', () => {
    const found = discoverJs(
      `const a="/assets/logo-abc.png",b='./chunk-x.js',c=\`images/hero.webp\`,d="https://cdn.example/x.png",` +
        `e="logo.png",f="/api/users",g="//cdn.example/y.png",h="/data.json?v=2",i="text with /x.png in it"`,
    );
    const guesses = found.filter((r) => r.kind === 'guess');
    expect(guesses).toEqual(
      expect.arrayContaining([
        { ref: '/assets/logo-abc.png', kind: 'guess' },
        { ref: './chunk-x.js', kind: 'guess' },
        { ref: './chunk-x.js', kind: 'guess', base: 'root' },
        { ref: 'images/hero.webp', kind: 'guess', base: 'root' },
        { ref: '/data.json', kind: 'guess' },
      ]),
    );
    const all = refs(found);
    expect(all).not.toContain('logo.png');
    expect(all).not.toContain('/api/users');
    expect(all.some((r) => r.includes('cdn.example'))).toBe(false);
    expect(all).not.toContain('/x.png');
  });
});

describe('discoverManifest', () => {
  it('finds the icons and screenshots', () => {
    expect(
      refs(
        discoverManifest(
          JSON.stringify({
            name: 'x',
            icons: [{ src: 'icon-192.png' }, { src: '/icon-512.png' }, { nope: 1 }],
            screenshots: [{ src: 'shot.png' }],
          }),
        ),
      ),
    ).toEqual(['icon-192.png', '/icon-512.png', 'shot.png']);
    expect(discoverManifest('not json')).toEqual([]);
    expect(discoverManifest('null')).toEqual([]);
  });
});
