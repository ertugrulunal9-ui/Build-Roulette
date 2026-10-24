/**
 * The catalogs (T-050): TypeScript already refuses a Turkish catalog with a missing or extra
 * key (`tr: Messages`). At runtime: the same keys and shapes (also for the parts built in code,
 * e.g. one entry per import error), every Turkish text non-empty and different from the English
 * one except the few terms that are the same in both (`SAME_IN_BOTH`), and the functions
 * (plurals, interpolation) give Turkish for the same arguments.
 */
import { BATTLE_PHASES, REPORT_REASONS, VOTE_CATEGORY_SLUGS } from '@br/game';
import { describe, expect, it } from 'vitest';
import { RPC_ERROR_CODES, CLIENT_ERROR_CODES } from '../solo/errors';
import { en } from './messages/en';
import { tr } from './messages/tr';

/**
 * Leaves that are rightly the same in English and Turkish: names of tools and frameworks, code,
 * the game's name, gaming terms Turkish players use as they are, and short forms.
 */
const SAME_IN_BOTH = new Set([
  'Build Roulette',
  'Speedrun',
  'Spam',
  'Solo',
  'Cursor, Windsurf, VS Code + Copilot, Zed',
  'Claude Code, Codex CLI, Gemini CLI, Aider',
  'Lovable, Bolt, v0, Replit',
  'Vite (React, Vue, Svelte, Preact, Solid)',
  'Create React App',
  'Next.js',
  'Astro',
  'Nuxt',
  'SvelteKit',
  'Angular',
  'Vite (React, Vue, Svelte…) → `dist`',
  'Create React App → `build`',
  // The link field's example address (docs/10).
  'https://my-app.lovable.app',
]);

/**
 * A leaf made only of code (backticks), numbers, signs and the sample arguments, e.g.
 * "`npm run build`", "(3×)", "Ada (“Bob”)".
 */
function noWords(text: string): boolean {
  return !/\p{L}/u.test(text.replace(/`[^`]*`/g, '').replace(/\b(Ada|Bob|Cy)\b/g, ''));
}

interface Leaf {
  path: string;
  en: unknown;
  tr: unknown;
}

/** Sample arguments for a catalog function: names, then numbers, then a list. */
const SAMPLES: unknown[][] = [['Ada', 'Bob', 'Cy'], [3, 7, 2], [['10', '15', '20']]];

function callBoth(
  path: string,
  fe: (...a: unknown[]) => unknown,
  ft: (...a: unknown[]) => unknown,
) {
  for (const args of SAMPLES) {
    try {
      const a = fe(...args);
      const b = ft(...args);
      return { a, b };
    } catch {
      // try the next kind of argument
    }
  }
  throw new Error(`${path}: no sample arguments work`);
}

function leaves(e: unknown, t: unknown, path = ''): Leaf[] {
  if (typeof e === 'function' && typeof t === 'function') {
    const { a, b } = callBoth(
      path,
      e as (...a: unknown[]) => unknown,
      t as (...a: unknown[]) => unknown,
    );
    return leaves(a, b, `${path}()`);
  }
  if (Array.isArray(e) && Array.isArray(t)) {
    expect(t.length, `${path} has as many items`).toBe(e.length);
    return e.flatMap((x, i) => leaves(x, t[i], `${path}[${String(i)}]`));
  }
  if (typeof e === 'object' && e !== null && typeof t === 'object' && t !== null) {
    expect(Object.keys(t).sort(), `${path} has the same keys`).toEqual(Object.keys(e).sort());
    return Object.keys(e).flatMap((k) =>
      leaves(
        (e as Record<string, unknown>)[k],
        (t as Record<string, unknown>)[k],
        path ? `${path}.${k}` : k,
      ),
    );
  }
  return [{ path, en: e, tr: t }];
}

describe('the Turkish catalog', () => {
  const all = leaves(en, tr);

  it('has the English shape: the same keys, list lengths and kinds of values', () => {
    expect(all.length).toBeGreaterThan(500);
    for (const leaf of all) expect(typeof leaf.tr, leaf.path).toBe(typeof leaf.en);
  });

  it('every text is there, and Turkish (not the English one), but for the shared terms', () => {
    const empty = all.filter((l) => typeof l.tr === 'string' && l.tr.trim() === '');
    expect(empty.map((l) => l.path)).toEqual([]);
    const same = all.filter(
      (l) => typeof l.tr === 'string' && l.tr === l.en && !SAME_IN_BOTH.has(l.tr) && !noWords(l.tr),
    );
    expect(same.map((l) => `${l.path}: ${String(l.tr)}`)).toEqual([]);
    // The allowlist holds nothing stale.
    const shared = new Set(all.filter((l) => l.tr === l.en).map((l) => l.tr));
    expect([...SAME_IN_BOTH].filter((s) => !shared.has(s))).toEqual([]);
  });

  it('has a text for every code: errors, vote errors, import errors, phases, reasons, categories', () => {
    for (const code of [...RPC_ERROR_CODES, ...CLIENT_ERROR_CODES]) {
      expect(tr.errors[code], code).toMatch(/\p{L}/u);
      expect(tr.errors[code], code).not.toBe(en.errors[code]);
    }
    for (const phase of BATTLE_PHASES) expect(tr.phases[phase], phase).toMatch(/\p{L}/u);
    for (const r of REPORT_REASONS) expect(tr.reportReasons[r].label, r).toMatch(/\p{L}/u);
    for (const c of VOTE_CATEGORY_SLUGS) expect(tr.voteCategories[c].label, c).toMatch(/\p{L}/u);
    for (const code of Object.keys(en.importErrors) as (keyof typeof en.importErrors)[]) {
      const t = tr.importErrors[code]('7340032');
      expect(t.title, code).not.toBe(en.importErrors[code]('7340032').title);
      expect(t.hint, code).toMatch(/\p{L}/u);
    }
    expect(Object.keys(en.importErrors)).toHaveLength(10);
  });

  it('plurals and interpolation', () => {
    expect(en.units.files(1)).toBe('1 file');
    expect(en.units.files(3)).toBe('3 files');
    expect(tr.units.files(1)).toBe('1 dosya');
    expect(tr.units.files(3)).toBe('3 dosya');
    expect(en.awards.votes(1)).toBe('1 vote');
    expect(tr.awards.votes(2)).toBe('2 oy');
    expect(en.units.orList(['10', '15', '20'])).toBe('10, 15 or 20');
    expect(tr.units.orList(['10', '15', '20'])).toBe('10, 15 veya 20');
    expect(en.units.andList(['A', 'B', 'C'])).toBe('A, B and C');
    expect(tr.units.andList(['A', 'B'])).toBe('A ve B');
    expect(tr.importErrors['too-large']('7340032').hint).toContain('7,0 MB');
    expect(tr.toasts.shipped(null, 'Roket', '3:12')).toBe(
      '🚀 Sen “Roket” projesini teslim ettin (3:12)',
    );
    expect(tr.toasts.shipped('Bob', null, null)).toBe('🚀 Bob “İsimsiz” projesini teslim etti');
    expect(
      tr.rateLimitedDetails('You sent too many reports recently. Try again in 9 minutes.'),
    ).toBe('Kısa sürede çok fazla istek gönderdin. 9 dakika sonra tekrar dene.');
  });
});
