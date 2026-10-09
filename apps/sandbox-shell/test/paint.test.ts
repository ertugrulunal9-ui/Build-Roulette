/**
 * The capture page's paint check (T-034) with fake DOM objects: what counts as "the build
 * shows something". The real page runs in Chromium in the capture-worker's function
 * integration tests (Browser Rendering stand-in: a throwing build is `empty`, a React build
 * is `content`).
 */
import { describe, expect, it } from 'vitest';
import { colorAlpha, paintState } from '../src/paint';

const VIEWPORT = { width: 1280, height: 800 };

interface FakeEl {
  tagName: string;
  rect?: { left: number; top: number; width: number; height: number };
  style?: Partial<Record<string, string>>;
  text?: string;
  before?: string;
}

const BASE_STYLE: Record<string, string> = {
  display: 'block',
  visibility: 'visible',
  opacity: '1',
  backgroundColor: 'rgba(0, 0, 0, 0)',
  backgroundImage: 'none',
  boxShadow: 'none',
  outlineStyle: 'none',
  outlineWidth: '0px',
  content: 'normal',
};

function style(over: Partial<Record<string, string>> = {}) {
  const all: Record<string, string | undefined> = { ...BASE_STYLE, ...over };
  return {
    ...all,
    getPropertyValue: (name: string) => all[name] ?? (name.endsWith('width') ? '0px' : 'none'),
  } as unknown as CSSStyleDeclaration;
}

function element(e: FakeEl) {
  const r = e.rect ?? { left: 0, top: 0, width: 0, height: 0 };
  return {
    tagName: e.tagName,
    childNodes: e.text === undefined ? [] : [{ nodeType: 3, nodeValue: e.text }],
    getBoundingClientRect: () => ({ ...r, right: r.left + r.width, bottom: r.top + r.height }),
    fake: e,
  };
}

function doc(
  elements: FakeEl[],
  opts: { bodyText?: string; htmlBg?: string; bodyBg?: string } = {},
): Document {
  const els = elements.map(element);
  const body = {
    tagName: 'BODY',
    childNodes: opts.bodyText === undefined ? [] : [{ nodeType: 3, nodeValue: opts.bodyText }],
    getElementsByTagName: () => els,
  };
  const html = { tagName: 'HTML' };
  const win = {
    getComputedStyle: (el: unknown, pseudo?: string) => {
      if (el === html) return style({ backgroundImage: opts.htmlBg ?? 'none' });
      if (el === body) return style({ backgroundImage: opts.bodyBg ?? 'none' });
      const f = (el as { fake: FakeEl }).fake;
      if (pseudo) return style({ content: pseudo === '::before' ? (f.before ?? 'none') : 'none' });
      return style(f.style);
    },
  };
  return { defaultView: win, body, documentElement: html } as unknown as Document;
}

const FULL = { left: 0, top: 0, width: 1280, height: 800 };

describe('paintState', () => {
  it('is empty when the build rendered nothing (React root never mounted)', () => {
    expect(paintState(doc([{ tagName: 'DIV' }]), VIEWPORT)).toBe('empty');
    expect(paintState(doc([]), VIEWPORT)).toBe('empty');
  });

  it('is empty for a full-viewport box that paints nothing, or only scripts and styles', () => {
    expect(paintState(doc([{ tagName: 'MAIN', rect: FULL }]), VIEWPORT)).toBe('empty');
    expect(paintState(doc([{ tagName: 'SCRIPT', rect: FULL, text: 'x' }]), VIEWPORT)).toBe('empty');
  });

  it('sees text, replaced elements, backgrounds, borders, shadows and pseudo-elements', () => {
    const cases: FakeEl[] = [
      { tagName: 'H1', rect: { left: 10, top: 10, width: 200, height: 40 }, text: 'Hello' },
      { tagName: 'CANVAS', rect: FULL },
      { tagName: 'svg', rect: { left: 0, top: 0, width: 24, height: 24 } },
      { tagName: 'BUTTON', rect: { left: 0, top: 0, width: 80, height: 30 } },
      { tagName: 'DIV', rect: FULL, style: { backgroundColor: 'rgb(255, 87, 34)' } },
      { tagName: 'DIV', rect: FULL, style: { backgroundImage: 'linear-gradient(red, blue)' } },
      { tagName: 'DIV', rect: FULL, style: { boxShadow: 'rgb(0, 0, 0) 0px 0px 4px 0px' } },
      { tagName: 'DIV', rect: FULL, before: '"★"' },
    ];
    for (const c of cases) expect(paintState(doc([c]), VIEWPORT), c.tagName).toBe('content');
  });

  it('ignores what is hidden, transparent, zero-sized or outside the viewport', () => {
    const cases: FakeEl[] = [
      { tagName: 'P', rect: FULL, text: 'hi', style: { visibility: 'hidden' } },
      { tagName: 'P', rect: FULL, text: 'hi', style: { opacity: '0' } },
      { tagName: 'P', rect: FULL, text: 'hi', style: { display: 'none' } },
      { tagName: 'P', rect: { left: 0, top: 0, width: 0, height: 20 }, text: 'hi' },
      { tagName: 'P', rect: { left: 0, top: 900, width: 100, height: 20 }, text: 'below' },
      { tagName: 'P', rect: { left: -300, top: 0, width: 200, height: 20 }, text: 'left' },
      { tagName: 'DIV', rect: FULL, style: { backgroundColor: 'rgba(255, 0, 0, 0)' } },
      { tagName: 'DIV', rect: FULL, text: '   \n ' },
    ];
    for (const c of cases) expect(paintState(doc([c]), VIEWPORT), JSON.stringify(c)).toBe('empty');
  });

  it('a background image on html or body is content; text right in body too', () => {
    expect(paintState(doc([], { htmlBg: 'linear-gradient(#123, #456)' }), VIEWPORT)).toBe(
      'content',
    );
    expect(paintState(doc([], { bodyBg: 'url("x.png")' }), VIEWPORT)).toBe('content');
    expect(paintState(doc([], { bodyText: 'Hello' }), VIEWPORT)).toBe('content');
  });

  it('an unreadable document (frame navigated to another origin) is content', () => {
    expect(paintState(null, VIEWPORT)).toBe('content');
  });

  it('stops after maxElements and then assumes content', () => {
    const many = Array.from({ length: 10 }, () => ({ tagName: 'DIV' }));
    expect(paintState(doc(many), VIEWPORT, 5)).toBe('content');
    expect(paintState(doc(many), VIEWPORT, 50)).toBe('empty');
  });
});

describe('colorAlpha', () => {
  it('reads computed colours', () => {
    expect(colorAlpha('rgba(0, 0, 0, 0)')).toBe(0);
    expect(colorAlpha('transparent')).toBe(0);
    expect(colorAlpha('rgb(255, 87, 34)')).toBe(1);
    expect(colorAlpha('rgba(10, 20, 30, 0.5)')).toBe(0.5);
    expect(colorAlpha('rgb(10 20 30 / 25%)')).toBe(0.25);
    expect(colorAlpha('color(srgb 1 0 0)')).toBe(1);
  });
});
