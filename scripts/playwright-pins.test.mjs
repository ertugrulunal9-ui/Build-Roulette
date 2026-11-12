// Drift tests for the browser setup CI depends on:
//   - every package pins the same exact Playwright version, and the lockfile resolves one
//     playwright-core. CI installs one Chromium (through @br/runtime or @br/capture-worker)
//     and every suite launches it, so a version bumped in one package.json only would fail
//     with "Executable doesn't exist" in another job;
//   - every CI job runs on the same named Ubuntu image, never ubuntu-latest (it moved to
//     Ubuntu 26.04 under a Playwright that could not install Chromium there: nightly runs
//     144-148).
// Upgrading: packages/runtime/README.md, "Upgrading Playwright".
//   node --test scripts/playwright-pins.test.mjs
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const PLAYWRIGHT_PACKAGES = ['@playwright/test', 'playwright', 'playwright-core'];

function workspacePackages() {
  const found = [];
  for (const dir of ['apps', 'packages', 'tools']) {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = join(ROOT, dir, entry.name, 'package.json');
      let pkg;
      try {
        pkg = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        continue;
      }
      found.push({ path: `${dir}/${entry.name}/package.json`, pkg });
    }
  }
  return found;
}

function playwrightPins() {
  const pins = [];
  for (const { path, pkg } of workspacePackages()) {
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const name of PLAYWRIGHT_PACKAGES) {
        const spec = pkg[field]?.[name];
        if (spec !== undefined) pins.push({ path, name, spec });
      }
    }
  }
  return pins;
}

describe('Playwright pins', () => {
  const pins = playwrightPins();

  it('finds the packages that run a browser', () => {
    const paths = pins.map((p) => p.path).sort();
    for (const expected of [
      'apps/capture-worker/package.json',
      'apps/web/package.json',
      'packages/runtime/package.json',
    ]) {
      assert.ok(paths.includes(expected), `${expected} pins Playwright`);
    }
  });

  it('pins an exact version everywhere (no ranges)', () => {
    for (const { path, name, spec } of pins) {
      assert.match(spec, /^\d+\.\d+\.\d+$/, `${path}: ${name} "${spec}" is not an exact version`);
    }
  });

  it('pins the same version in every package', () => {
    const versions = new Set(pins.map((p) => p.spec));
    assert.equal(
      versions.size,
      1,
      `one Playwright version for every package, found: ${pins
        .map((p) => `${p.path} ${p.name}@${p.spec}`)
        .join(', ')}`,
    );
  });

  it('resolves exactly that playwright-core in the lockfile', () => {
    const lock = readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8');
    const resolved = new Set(
      [...lock.matchAll(/^ {2}playwright-core@(\d+\.\d+\.\d+):$/gm)].map((m) => m[1]),
    );
    assert.deepEqual([...resolved], [pins[0].spec]);
  });
});

describe('CI runner image', () => {
  const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  const images = [...ci.matchAll(/^\s+runs-on:\s*(\S+)\s*$/gm)].map((m) => m[1]);

  it('names an Ubuntu version in every job, never ubuntu-latest', () => {
    assert.ok(images.length > 0, 'ci.yml has jobs');
    for (const image of images) {
      assert.match(image, /^ubuntu-\d+\.\d+$/, `runs-on: ${image}`);
    }
  });

  it('runs every job on the same image', () => {
    assert.equal(new Set(images).size, 1, `images: ${[...new Set(images)].join(', ')}`);
  });
});
