/**
 * Finding the files a published site uses (docs/10 §10.2, step 2), from the text of its HTML,
 * CSS, JavaScript and web manifest. Regular expressions, no DOM: the copier runs in Deno (the
 * `import-url` Edge Function) and in Node (tests), and has no dependencies.
 *
 * Each function returns references as written (`/assets/a.js`, `./b.css`,
 * `https://cdn.example/x.js`), resolved against the right base by `resolveRefs`; filtering
 * (same origin, inside the site root) is the copier's job.
 *
 * A reference is `sure` (the page loads it: a `src`, a stylesheet, an `import`) or a `guess`
 * (a string literal that looks like an asset path). A guess that is not found is skipped
 * silently; it was probably not a file at all.
 */

export type RefKind = 'sure' | 'guess';

export interface FoundRef {
  /** As written in the file. */
  ref: string;
  kind: RefKind;
  /** What the reference is resolved against: the file itself (default) or the site root. */
  base?: 'file' | 'root';
  /** The file is a page (an `<a href>` to an `.html` file) or a web manifest. */
  as?: 'page' | 'manifest';
}

/** Extensions a string literal in JavaScript must end with to be taken as an asset path. */
const ASSET_EXT =
  'png|jpe?g|gif|webp|avif|svg|ico|bmp|woff2?|ttf|otf|eot|mp3|wav|ogg|oga|m4a|aac|flac|mp4|webm|ogv|wasm|glb|gltf|bin|json|js|mjs|css|txt|csv|xml|pdf|webmanifest|html?';

/** References that are never files of the site. */
function ignored(ref: string): boolean {
  const r = ref.trim();
  return (
    r === '' ||
    r.startsWith('#') ||
    r.includes('${') ||
    /^(?:data|blob|javascript|mailto|tel|about|sms|geo|intent|chrome|file):/i.test(r)
  );
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&#x2F;|&#0*47;/gi, '/')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/** The attributes of one start tag (lowercase names, entity-decoded values). */
function attributes(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const m of text.matchAll(re)) {
    const name = (m[1] ?? '').toLowerCase();
    if (out.has(name)) continue;
    out.set(name, decodeEntities(m[2] ?? m[3] ?? m[4] ?? ''));
  }
  return out;
}

/**
 * The URLs of a `srcset` (`a.png 1x, b.png 2x`), as the HTML spec splits it: a URL is a run of
 * non-space characters (commas inside it are kept, `a.png,` ends a candidate), descriptors run
 * to the next comma.
 */
export function srcsetUrls(value: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < value.length) {
    while (i < value.length && /[\s,]/.test(value.charAt(i))) i++;
    let j = i;
    while (j < value.length && !/\s/.test(value.charAt(j))) j++;
    let url = value.slice(i, j);
    const bare = url.endsWith(',');
    url = url.replace(/,+$/, '');
    if (url !== '') out.push(url);
    i = j;
    if (!bare) {
      while (i < value.length && value.charAt(i) !== ',') i++;
    }
  }
  return out;
}

/** `<link rel>` values whose `href` the page loads. */
const LOADED_RELS = new Set([
  'stylesheet',
  'icon',
  'shortcut',
  'apple-touch-icon',
  'apple-touch-icon-precomposed',
  'mask-icon',
  'manifest',
  'modulepreload',
  'preload',
  'prefetch',
  'fluid-icon',
]);

/** Tags whose `src` loads a file. */
const SRC_TAGS = new Set([
  'script',
  'img',
  'source',
  'video',
  'audio',
  'track',
  'iframe',
  'embed',
  'input',
  'image',
]);

/** Meta tags whose `content` is an image of the page. */
const IMAGE_META = new Set(['og:image', 'og:image:url', 'og:image:secure_url', 'twitter:image']);

/** What an `<a href>` must look like to be followed: another page of the site. */
const PAGE_RE = /^[^?#]*(?:\.html?|\/)(?:[?#].*)?$/i;

export interface HtmlRefs {
  refs: FoundRef[];
  /** The document's `<base href>`, when it has one. */
  base: string | null;
}

/** References in an HTML document (docs/10 §10.2). */
export function discoverHtml(html: string): HtmlRefs {
  const refs: FoundRef[] = [];
  const add = (ref: string, kind: RefKind, as?: 'page' | 'manifest') => {
    if (!ignored(ref)) refs.push(as ? { ref: ref.trim(), kind, as } : { ref: ref.trim(), kind });
  };
  const text = html.replace(/<!--[\s\S]*?-->/g, '');
  let base: string | null = null;

  // Inline scripts and styles first; then they are cut out, so their text is no tag soup.
  const rest = text.replace(
    /<(script|style)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi,
    (whole, tag: string, attrs: string, body: string) => {
      const a = attributes(attrs);
      if (tag.toLowerCase() === 'style') {
        for (const r of discoverCss(body)) refs.push(r);
      } else {
        const type = (a.get('type') ?? '').toLowerCase();
        if (type === '' || type === 'module' || type.includes('javascript')) {
          for (const r of discoverJs(body)) refs.push(r);
        }
      }
      // Keep the start tag (its src) for the tag pass below.
      return `<${tag}${attrs}>`;
    },
  );

  for (const m of rest.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g)) {
    const tag = (m[1] ?? '').toLowerCase();
    const a = attributes(m[2] ?? '');
    const style = a.get('style');
    if (style) for (const r of discoverCss(style)) refs.push(r);
    if (tag === 'base') {
      const href = a.get('href');
      if (href && base === null) base = href.trim();
      continue;
    }
    if (tag === 'link') {
      const rels = (a.get('rel') ?? '').toLowerCase().split(/\s+/);
      const href = a.get('href');
      if (href && rels.some((r) => LOADED_RELS.has(r))) {
        add(href, 'sure', rels.includes('manifest') ? 'manifest' : undefined);
      }
      const set = a.get('imagesrcset');
      if (set) for (const u of srcsetUrls(set)) add(u, 'sure');
      continue;
    }
    if (tag === 'meta') {
      const key = (a.get('property') ?? a.get('name') ?? '').toLowerCase();
      const content = a.get('content');
      if (content && IMAGE_META.has(key)) add(content, 'sure');
      continue;
    }
    if (tag === 'a' || tag === 'area') {
      const href = a.get('href');
      if (href && PAGE_RE.test(href.trim())) add(href, 'sure', 'page');
      continue;
    }
    if (SRC_TAGS.has(tag)) {
      const src = a.get('src');
      if (src) add(src, 'sure', tag === 'iframe' ? 'page' : undefined);
    }
    const set = a.get('srcset');
    if (set) for (const u of srcsetUrls(set)) add(u, 'sure');
    const poster = a.get('poster');
    if (poster) add(poster, 'sure');
  }
  return { refs, base };
}

/** References in a stylesheet: `url(…)` and `@import`. */
export function discoverCss(css: string): FoundRef[] {
  const refs: FoundRef[] = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const add = (ref: string) => {
    if (!ignored(ref)) refs.push({ ref: ref.trim(), kind: 'sure' });
  };
  for (const m of text.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]*))\s*\)/gi)) {
    add(m[1] ?? m[2] ?? m[3] ?? '');
  }
  for (const m of text.matchAll(/@import\s+(?:"([^"]*)"|'([^']*)')/gi)) add(m[1] ?? m[2] ?? '');
  return refs;
}

/** Whether a module specifier is a URL (not a bare package name). */
function isUrlSpecifier(s: string): boolean {
  return /^(?:\.{1,2}\/|\/|https?:)/i.test(s);
}

/**
 * The string literals of Vite's `__vite__mapDeps` list (the files a dynamic import preloads),
 * which Vite writes relative to the site root (`"assets/chunk-a.js"`).
 */
function viteMapDeps(js: string): string[] {
  const at = js.indexOf('__vite__mapDeps=');
  if (at < 0) return [];
  const open = js.indexOf('[', at);
  const close = open < 0 ? -1 : js.indexOf(']', open);
  if (open < 0 || close < 0 || open - at > 200) return [];
  return [...js.slice(open + 1, close).matchAll(/"([^"]*)"|'([^']*)'|`([^`$]*)`/g)].map(
    (m) => m[1] ?? m[2] ?? m[3] ?? '',
  );
}

/**
 * References in JavaScript: static and dynamic imports and re-exports, Vite's
 * `__vite__mapDeps` lists, `new URL("…", import.meta.url)`, and string literals that look like
 * asset paths (`"/assets/logo-abc.png"`, `"./chunk-x.js"`, `"images/a.webp"`).
 */
export function discoverJs(js: string): FoundRef[] {
  const refs: FoundRef[] = [];
  const seen = new Set<string>();
  const add = (ref: string, kind: RefKind, base: 'file' | 'root' = 'file') => {
    const key = `${base}|${ref}`;
    if (ignored(ref) || seen.has(key)) return;
    seen.add(key);
    refs.push(base === 'root' ? { ref, kind, base } : { ref, kind });
  };
  // import x from "./a.js", import "./a.js", import{a}from"./a.js", export*from"./a.js"
  for (const m of js.matchAll(
    /(?:^|[^\w$.])(?:import|export)\s*(?:[\w$*{}\s,]*?\s*from\s*)?["']([^"'\n]+)["']/g,
  )) {
    const s = m[1] ?? '';
    if (isUrlSpecifier(s)) add(s, 'sure');
  }
  // import("./a.js")
  for (const m of js.matchAll(/(?:^|[^\w$.])import\s*\(\s*["'`]([^"'`\n]+)["'`]\s*[,)]/g)) {
    const s = m[1] ?? '';
    if (isUrlSpecifier(s)) add(s, 'sure');
  }
  // new URL("a.png", import.meta.url)
  for (const m of js.matchAll(
    /new\s+URL\(\s*["'`]([^"'`\n]+)["'`]\s*,\s*import\.meta\.url\s*\)/g,
  )) {
    add(m[1] ?? '', 'sure');
  }
  // Vite: the list is relative to the root (base "/"); with a relative base it can be relative
  // to the importing file, so that is tried too (a guess).
  for (const dep of viteMapDeps(js)) {
    if (dep.startsWith('/') || /^[a-z]+:/i.test(dep)) {
      add(dep, 'sure');
    } else {
      add(dep, 'sure', 'root');
      add(dep, 'guess');
    }
  }
  // String literals that look like asset paths.
  const literal = new RegExp(
    String.raw`["'\x60]((?:\.{1,2}\/|\/(?!\/))?[\w@~.%+-]+(?:\/[\w@~.%+-]+)*\.(?:${ASSET_EXT}))(?:\?[^"'\x60\s]*)?["'\x60]`,
    'gi',
  );
  for (const m of js.matchAll(literal)) {
    const s = m[1] ?? '';
    if (/^[\w@~.%+-]+\.\w+$/.test(s)) continue; // a bare file name: too often not a path
    if (s.startsWith('/')) {
      add(s, 'guess');
    } else if (s.startsWith('.')) {
      add(s, 'guess');
      add(s, 'guess', 'root');
    } else {
      add(s, 'guess', 'root');
    }
  }
  return refs;
}

/** The icons (and screenshots) of a web manifest. */
export function discoverManifest(json: string): FoundRef[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return [];
  }
  if (typeof data !== 'object' || data === null) return [];
  const refs: FoundRef[] = [];
  for (const key of ['icons', 'screenshots']) {
    const list = (data as Record<string, unknown>)[key];
    if (!Array.isArray(list)) continue;
    for (const item of list as unknown[]) {
      const src =
        typeof item === 'object' && item !== null
          ? (item as Record<string, unknown>)['src']
          : undefined;
      if (typeof src === 'string' && !ignored(src)) refs.push({ ref: src.trim(), kind: 'sure' });
    }
  }
  return refs;
}
