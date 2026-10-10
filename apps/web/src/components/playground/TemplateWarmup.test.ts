// @vitest-environment happy-dom
/**
 * T-032: the lobby's hidden preview hands the shell the template's import map (an empty
 * bundle), so the shell warms React's entry points into the browser's cache.
 */
import { PreviewHandle } from '@br/runtime';
import { REACT_VERSION } from '@br/workspace';
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { playgroundConfig } from '../../lib/playground/config';
import { TemplateWarmup, warmupBuild } from './TemplateWarmup';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('TemplateWarmup', () => {
  it('the warm-up build is empty and maps every React entry point, exact versions only', () => {
    const build = warmupBuild('https://pkg.example');
    expect(build.js).toBe('');
    expect(build.css).toBe('');
    expect(build.importMap.imports).toEqual({
      react: `https://pkg.example/react@${REACT_VERSION}`,
      'react/jsx-runtime': `https://pkg.example/react@${REACT_VERSION}/jsx-runtime?external=react,react-dom`,
      'react/jsx-dev-runtime': `https://pkg.example/react@${REACT_VERSION}/jsx-dev-runtime?external=react,react-dom`,
      'react/': `https://pkg.example/react@${REACT_VERSION}&external=react,react-dom/`,
      'react-dom': `https://pkg.example/react-dom@${REACT_VERSION}?external=react,react-dom,scheduler`,
      'react-dom/client': `https://pkg.example/react-dom@${REACT_VERSION}/client?external=react,react-dom,scheduler`,
      'react-dom/': `https://pkg.example/react-dom@${REACT_VERSION}&external=react,react-dom,scheduler/`,
      // React DOM's scheduler at its exact version (T-040), warmed with the rest.
      scheduler: 'https://pkg.example/scheduler@0.28.0',
    });
  });

  it('loads it in a hidden reveal-mode preview of the usual shell, and lets it go on unmount', () => {
    const loads: unknown[][] = [];
    vi.spyOn(PreviewHandle.prototype, 'load').mockImplementation((...args) => {
      loads.push(args);
      return 1;
    });
    const dispose = vi.spyOn(PreviewHandle.prototype, 'dispose');
    render(createElement(TemplateWarmup));
    const frame = document.querySelector<HTMLIFrameElement>('iframe[data-testid=template-warmup]');
    expect(frame?.getAttribute('src')).toBe(playgroundConfig.shellUrl);
    expect(frame?.getAttribute('sandbox')).not.toContain('allow-popups');
    expect(frame?.closest('[aria-hidden=true]')).not.toBeNull();
    expect(loads).toEqual([[warmupBuild(playgroundConfig.cdnBaseUrl), 'reveal']]);
    cleanup();
    expect(dispose).toHaveBeenCalled();
  });
});
