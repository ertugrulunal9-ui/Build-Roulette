/**
 * The pure parts of the client thumbnail with fake DOM objects. The real rendering (DOM via
 * SVG foreignObject, canvas copy) is covered in a browser by packages/runtime/e2e/thumbnail.spec.ts.
 */
import { LIMITS } from '@br/protocol';
import { describe, expect, it } from 'vitest';
import { captureThumbnail, encodeWebp, findMainCanvas } from '../src/thumbnail';

function fakeCanvas(rect: { left: number; top: number; width: number; height: number }) {
  return {
    getBoundingClientRect: () => ({
      ...rect,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
    }),
  };
}

function fakeDoc(canvases: ReturnType<typeof fakeCanvas>[]): Document {
  return { querySelectorAll: () => canvases } as unknown as Document;
}

describe('findMainCanvas', () => {
  it('picks the largest canvas when it covers at least half of the viewport', () => {
    const small = fakeCanvas({ left: 0, top: 0, width: 100, height: 100 });
    const big = fakeCanvas({ left: 0, top: 0, width: 800, height: 500 });
    expect(findMainCanvas(fakeDoc([small, big]), 1000, 600)).toBe(big);
  });

  it('ignores canvases that cover less than half, counting only the visible part', () => {
    const offscreen = fakeCanvas({ left: 900, top: 0, width: 1000, height: 600 });
    expect(findMainCanvas(fakeDoc([offscreen]), 1000, 600)).toBeNull();
    expect(findMainCanvas(fakeDoc([]), 1000, 600)).toBeNull();
  });
});

describe('encodeWebp', () => {
  const canvas = (urls: (string | Error)[]) => {
    const calls: number[] = [];
    return {
      calls,
      el: {
        toDataURL: (_type: string, q: number) => {
          calls.push(q);
          const next = urls.shift();
          if (next instanceof Error) throw next;
          return next ?? '';
        },
      } as unknown as HTMLCanvasElement,
    };
  };

  it('returns the WebP data URL', () => {
    const c = canvas(['data:image/webp;base64,AAAA']);
    expect(encodeWebp(c.el)).toBe('data:image/webp;base64,AAAA');
    expect(c.calls).toEqual([0.8]);
  });

  it('lowers the quality until the URL fits the protocol cap', () => {
    const huge = 'data:image/webp;base64,' + 'A'.repeat(LIMITS.thumbnailMaxChars);
    const c = canvas([huge, huge, 'data:image/webp;base64,BB']);
    expect(encodeWebp(c.el)).toBe('data:image/webp;base64,BB');
    expect(c.calls).toEqual([0.8, 0.6, 0.4]);
    expect(encodeWebp(canvas([huge, huge, huge]).el)).toBeNull();
  });

  it('is null without a WebP encoder (PNG fallback) or for a tainted canvas', () => {
    expect(encodeWebp(canvas(['data:image/png;base64,AAAA']).el)).toBeNull();
    expect(encodeWebp(canvas([new Error('SecurityError')]).el)).toBeNull();
  });
});

describe('captureThumbnail', () => {
  it('is null without a build frame, and never throws', async () => {
    await expect(captureThumbnail(null, 64, 40)).resolves.toBeNull();
    const broken = {
      get contentDocument(): Document {
        throw new Error('boom');
      },
    } as unknown as HTMLIFrameElement;
    await expect(captureThumbnail(broken, 64, 40)).resolves.toBeNull();
  });
});
