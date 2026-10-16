/**
 * No string left behind (T-050): every word of the player-facing components comes from the
 * catalogs (README "Languages" says how to add one). `/admin` stays English and is not checked.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findHardcodedStrings } from './hardcoded-strings';

const SRC = join(import.meta.dirname, '..', '..');

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'admin' ? [] : tsxFiles(path);
    return e.name.endsWith('.tsx') ? [path] : [];
  });
}

describe('the check itself', () => {
  const check = (src: string) => findHardcodedStrings('x.tsx', src).map((v) => v.text);

  it('finds JSX text, text props and literal children', () => {
    expect(check('const a = <p>Hello there</p>;')).toEqual(['Hello there']);
    expect(check('const a = <button aria-label="Close" title={"Shut it"} />;')).toEqual([
      'Close',
      'Shut it',
    ]);
    expect(check("const a = <p>{busy ? 'Saving…' : 'Save'}</p>;")).toEqual(['Saving…', 'Save']);
    expect(check("const a = <img alt={name ?? 'the build'} />;")).toEqual(['the build']);
    expect(check('const a = <p title={`Remove ${name}`} />;')).toEqual(['Remove']);
  });

  it('leaves alone the catalog, markup, code-ish props and the allowed words', () => {
    expect(
      check(
        [
          'const a = (',
          '  <div className="flex gap-2" data-testid="x" role="group">',
          '    <a href="/try" aria-label={t.close}>{t.home.title} · {String(n)} → ✓ 404</a>',
          '    <h1>Build Roulette</h1>',
          '    <input placeholder="K7QXM" type="text" />',
          '    <p>{`${a} · ${b}`}</p>',
          '  </div>',
          ');',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('says where', () => {
    expect(findHardcodedStrings('f.tsx', '\n\nconst a = <b>Oops</b>;')).toEqual([
      { file: 'f.tsx', line: 3, text: 'Oops' },
    ]);
  });
});

describe('the player-facing components', () => {
  it('have no words outside the catalogs (src/components and src/app, not /admin)', () => {
    const files = [...tsxFiles(join(SRC, 'components')), ...tsxFiles(join(SRC, 'app'))];
    expect(files.length).toBeGreaterThan(40);
    const found = files.flatMap((f) =>
      findHardcodedStrings(relative(SRC, f), readFileSync(f, 'utf8')).map(
        (v) => `${v.file}:${String(v.line)} ${JSON.stringify(v.text)}`,
      ),
    );
    expect(found).toEqual([]);
  });
});
