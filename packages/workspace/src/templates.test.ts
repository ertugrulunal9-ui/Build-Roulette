import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { detectBareImports } from './bare-imports';
import { validateWorkspace } from './limits';
import { REACT_VERSION, TEMPLATES, TEMPLATE_IDS, createWorkspace, isTemplateId } from './templates';

describe('templates', () => {
  it('defaults to react-ts', () => {
    const ws = createWorkspace();
    expect(ws.manifest).toEqual({
      template: 'react-ts',
      entry: 'src/main.tsx',
      dependencies: { react: REACT_VERSION, 'react-dom': REACT_VERSION },
      tailwind: false,
    });
    expect(Object.keys(ws.files)).toEqual(['src/main.tsx', 'src/App.tsx', 'src/styles.css']);
  });

  it.each(TEMPLATE_IDS)(
    '%s is valid, has its entry and declares every package it imports',
    (id) => {
      const ws = createWorkspace(id);
      expect(validateWorkspace(ws)).toEqual([]);
      expect(ws.manifest.template).toBe(id);
      const imported = detectBareImports(ws.files).map((b) => b.name);
      for (const name of imported) expect(Object.keys(ws.manifest.dependencies)).toContain(name);
      for (const version of Object.values(ws.manifest.dependencies)) {
        expect(version).toMatch(/^\d+\.\d+\.\d+$/);
      }
    },
  );

  it('returns independent copies', () => {
    const a = createWorkspace();
    a.files['src/App.tsx'] = 'changed';
    a.manifest.dependencies['zustand'] = '5.0.0';
    const b = createWorkspace();
    expect(b.files['src/App.tsx']).toBe(TEMPLATES['react-ts'].files['src/App.tsx']);
    expect(b.manifest.dependencies).not.toHaveProperty('zustand');
  });

  it('isTemplateId', () => {
    expect(isTemplateId('react-ts')).toBe(true);
    expect(isTemplateId('vanilla-ts')).toBe(true);
    expect(isTemplateId('svelte')).toBe(false);
    expect(isTemplateId(1)).toBe(false);
  });

  it('pins the React version the local mock CDN serves (packages/runtime devDependencies)', () => {
    // Drift guard: the mock CDN only serves the React installed in @br/runtime. Replace this
    // check when the self-hosted package CDN (T-006) becomes the default.
    const runtimePkg = JSON.parse(
      readFileSync(new URL('../../runtime/package.json', import.meta.url), 'utf8'),
    ) as { devDependencies: Record<string, string> };
    expect(runtimePkg.devDependencies['react']).toBe(REACT_VERSION);
    expect(runtimePkg.devDependencies['react-dom']).toBe(REACT_VERSION);
  });
});
