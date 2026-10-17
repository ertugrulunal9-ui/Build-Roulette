/**
 * The bootstrap the site worker puts into every HTML response of a site (docs/09 §9.3), as
 * the first child of `<head>`, so it runs before any of the site's own scripts:
 *
 * 1. it removes `__br_site` from the address with `history.replaceState` (other query
 *    parameters and the hash stay), so a client-side router sees `/`;
 * 2. it calls the shell's attach hook on `parent` (`parent.__brAttach(window)`): console and
 *    error forwarding, and `window.buildRoulette.ready()`. A frame whose parent is not the
 *    shell (a nested frame of the site, a popup) finds no hook, and nothing breaks.
 *
 * The injection works on bytes: the markup it looks for is ASCII, so the page keeps whatever
 * encoding it declares. Pure, unit tested in Node (test/bootstrap.test.ts).
 */
import { ATTACH_HOOK, SITE_PARAM } from './site-protocol';

/** The inline script (ASCII only). Runs in the site's realm; never throws. */
export const BOOTSTRAP_SCRIPT =
  `(function(){` +
  `try{var s=location.search;if(s.indexOf(${JSON.stringify(`${SITE_PARAM}=`)})!==-1){` +
  `var q=s.slice(1).split("&").filter(function(p){return p.split("=")[0]!==${JSON.stringify(SITE_PARAM)}}).join("&");` +
  `history.replaceState(history.state,"",location.pathname+(q?"?"+q:"")+location.hash)}}catch(e){}` +
  `try{if(parent!==window&&typeof parent.${ATTACH_HOOK}==="function")parent.${ATTACH_HOOK}(window)}catch(e){}` +
  `})();`;

export const BOOTSTRAP_TAG = `<script>${BOOTSTRAP_SCRIPT}</script>`;

/** Index just past the tag that starts at `i` (a `>` outside quoted attribute values). */
function tagEnd(html: string, i: number): number {
  let quote: string | null = null;
  for (let j = i + 1; j < html.length; j++) {
    const c = html[j];
    if (quote !== null) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      return j + 1;
    }
  }
  return html.length;
}

/** Skips whitespace, comments, the doctype and processing instructions from `i`. */
function skipProlog(html: string, i: number): number {
  for (;;) {
    while (i < html.length && /[\t\n\f\r ]/.test(html[i] ?? '')) i++;
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      i = end === -1 ? html.length : end + 3;
    } else if (html.startsWith('<!', i) || html.startsWith('<?', i)) {
      i = tagEnd(html, i);
    } else {
      return i;
    }
  }
}

function startsWithTag(html: string, i: number, name: string): boolean {
  return new RegExp(`^<${name}(?=[\\s/>]|$)`, 'i').test(html.slice(i, i + name.length + 2));
}

/**
 * Where the bootstrap goes: right after the `<head …>` start tag when the document starts
 * with one (after the doctype, comments and `<html …>`), otherwise at the first other thing
 * after them. There the HTML parser creates the `<head>` itself and puts the script into it
 * as its first child (a later explicit `<head>` tag is then ignored by the parser, while its
 * children still go into the head). `html` is the document decoded byte for byte (latin1),
 * so the index is also a byte offset.
 */
export function bootstrapOffset(html: string): number {
  // A UTF-8 byte order mark, decoded as latin1 (or as UTF-16 code unit in string tests).
  const bom = html.startsWith('\u00ef\u00bb\u00bf') ? 3 : html.startsWith('\ufeff') ? 1 : 0;
  let i = skipProlog(html, bom);
  if (startsWithTag(html, i, 'html')) i = skipProlog(html, tagEnd(html, i));
  if (startsWithTag(html, i, 'head')) return tagEnd(html, i);
  return i;
}

/** `html` with the bootstrap inserted (string form, for tests). */
export function injectBootstrapHtml(html: string, tag = BOOTSTRAP_TAG): string {
  const at = bootstrapOffset(html);
  return html.slice(0, at) + tag + html.slice(at);
}

/** The document's bytes with the bootstrap inserted. Keeps the document's own encoding. */
export function injectBootstrap(bytes: Uint8Array, tag = BOOTSTRAP_TAG): Uint8Array<ArrayBuffer> {
  // windows-1252 as the Encoding Standard defines it maps every byte to one code unit.
  const at = bootstrapOffset(new TextDecoder('latin1').decode(bytes));
  const insert = new TextEncoder().encode(tag);
  const out = new Uint8Array(bytes.byteLength + insert.byteLength);
  out.set(bytes.subarray(0, at), 0);
  out.set(insert, at);
  out.set(bytes.subarray(at), at + insert.byteLength);
  return out;
}
