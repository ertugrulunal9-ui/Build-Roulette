import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  BOOTSTRAP_SCRIPT,
  BOOTSTRAP_TAG,
  bootstrapOffset,
  injectBootstrap,
  injectBootstrapHtml,
} from '../src/bootstrap';

const T = '<script>B</script>';
const inject = (html: string) => injectBootstrapHtml(html, T);

describe('injectBootstrapHtml', () => {
  it('goes first into <head>, after the doctype and <html>', () => {
    expect(
      inject(
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>x</title></head><body></body></html>',
      ),
    ).toBe(
      `<!doctype html><html lang="en"><head>${T}<meta charset="utf-8"><title>x</title></head><body></body></html>`,
    );
  });

  it('handles uppercase tags, attributes, whitespace and comments around them', () => {
    expect(
      inject(
        '<!DOCTYPE HTML>\n<!-- built -->\n<HTML LANG=en>\n  <HEAD data-x="a>b">\n<META charset=utf-8>',
      ),
    ).toBe(
      `<!DOCTYPE HTML>\n<!-- built -->\n<HTML LANG=en>\n  <HEAD data-x="a>b">${T}\n<META charset=utf-8>`,
    );
  });

  it('does not take <header> for <head>', () => {
    expect(inject('<!doctype html><html><header>x</header></html>')).toBe(
      `<!doctype html><html>${T}<header>x</header></html>`,
    );
  });

  it('without a <head>, goes where the parser creates one (before the first element)', () => {
    expect(inject('<!doctype html><title>x</title><p>hi')).toBe(
      `<!doctype html>${T}<title>x</title><p>hi`,
    );
    expect(inject('<!doctype html>\n<html>\n<body><p>hi</p></body></html>')).toBe(
      `<!doctype html>\n<html>\n${T}<body><p>hi</p></body></html>`,
    );
    expect(inject('<p>no doctype</p>')).toBe(`${T}<p>no doctype</p>`);
    expect(inject('')).toBe(T);
    expect(inject('just text')).toBe(`${T}just text`);
  });

  it('keeps the doctype first (no quirks mode), and a leading BOM in front', () => {
    expect(inject('\ufeff<!doctype html><head></head>')).toBe(
      `\ufeff<!doctype html><head>${T}</head>`,
    );
    const out = inject('<!doctype html><body>x</body>');
    expect(out.startsWith('<!doctype html>')).toBe(true);
  });

  it('skips a <head> hidden in a comment', () => {
    expect(inject('<!-- <head> --><html><head><title>t</title>')).toBe(
      `<!-- <head> --><html><head>${T}<title>t</title>`,
    );
  });
});

describe('injectBootstrap (bytes)', () => {
  it('keeps the bytes around it as they are, whatever the encoding', () => {
    // "café" in windows-1252, and a UTF-8 BOM.
    const before = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode('<html><head>'),
      0x63,
      0x61,
      0x66,
      0xe9,
    ]);
    const out = injectBootstrap(before, T);
    const tag = new TextEncoder().encode(T);
    const at = 3 + '<html><head>'.length;
    expect(Array.from(out.subarray(0, at))).toEqual(Array.from(before.subarray(0, at)));
    expect(Array.from(out.subarray(at, at + tag.length))).toEqual(Array.from(tag));
    expect(Array.from(out.subarray(at + tag.length))).toEqual([0x63, 0x61, 0x66, 0xe9]);
  });

  it('agrees with the string form on UTF-8 pages', () => {
    const html = '<!doctype html><html><head><title>über ✓</title></head></html>';
    const out = new TextDecoder().decode(injectBootstrap(new TextEncoder().encode(html)));
    expect(out).toBe(injectBootstrapHtml(html));
    expect(bootstrapOffset(html)).toBe(html.indexOf('<title>'));
  });
});

describe('BOOTSTRAP_SCRIPT', () => {
  function run(search: string, opts: { parent?: 'self' | 'shell' | 'throws' } = {}) {
    const calls: string[] = [];
    const location = { search, pathname: '/', hash: '#h' };
    const history = {
      state: { s: 1 },
      replaceState: (state: unknown, _t: string, url: string) =>
        calls.push(`replace ${JSON.stringify(state)} ${url}`),
    };
    const ctx = createContext({ location, history });
    runInContext('this.window = this;', ctx);
    const global = runInContext('this', ctx) as Record<string, unknown>;
    if (opts.parent === 'shell') {
      ctx['parent'] = {
        __brAttach: (w: unknown) => calls.push(`attach ${String(w === global)}`),
      };
    } else if (opts.parent === 'throws') {
      ctx['parent'] = {
        get __brAttach(): never {
          throw new Error('cross-origin');
        },
      };
    } else {
      runInContext('this.parent = this;', ctx);
      ctx['__brAttach'] = () => calls.push('attached to itself');
    }
    runInContext(BOOTSTRAP_SCRIPT, ctx);
    return calls;
  }

  it('removes the site id from the address and keeps the rest', () => {
    expect(run(`?__br_site=${'a'.repeat(32)}`)).toEqual(['replace {"s":1} /#h']);
    expect(run(`?x=1&__br_site=abc&y=2`)).toEqual(['replace {"s":1} /?x=1&y=2#h']);
    expect(run('?x=1')).toEqual([]);
  });

  it('attaches to the shell when its parent has the hook, and never throws otherwise', () => {
    expect(run('', { parent: 'shell' })).toEqual(['attach true']);
    expect(run('', { parent: 'self' })).toEqual([]);
    expect(() => run('', { parent: 'throws' })).not.toThrow();
  });

  it('is ASCII, so the byte injection is encoding-neutral', () => {
    expect(/^[\x20-\x7e]*$/.test(BOOTSTRAP_TAG)).toBe(true);
  });
});
