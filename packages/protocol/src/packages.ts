/**
 * Package CDN failure texts (T-032), shared by the sandbox shell (a module that could not
 * load) and the bundler (package CSS that could not be fetched), so a player sees the same
 * words in the preview and in the Problems panel.
 */

/** How one package URL failed: no answer at all, an answer too late, or an HTTP error. */
export type PackageFailure =
  | { url: string; kind: 'unreachable' }
  | { url: string; kind: 'timeout' }
  | { url: string; kind: 'http'; status: number; detail?: string };

/** Most package names listed in one message; the rest are counted. */
export const PACKAGE_LABELS_MAX = 3;

/**
 * `zustand@5.0.15`, `react-dom@19.3.0/client`, `three@0.186.1/examples/jsm/x.js`: the path of
 * a package CDN URL (esm.sh shape), without the query. Falls back to the URL itself.
 */
export function packageLabel(url: string): string {
  try {
    const path = new URL(url).pathname.replace(/^\/+/, '');
    const label = decodeURIComponent(path);
    return label === '' ? url : label;
  } catch {
    return url;
  }
}

function labels(urls: readonly string[]): string {
  const names = [...new Set(urls.map(packageLabel))];
  const shown = names.slice(0, PACKAGE_LABELS_MAX).join(', ');
  const more = names.length - PACKAGE_LABELS_MAX;
  return more > 0 ? `${shown} (+${String(more)} more)` : shown;
}

/**
 * The text for packages that could not load, worst first: no answer (`unreachable`), then
 * no answer in time (`timeout`), then HTTP errors. Null when there is nothing to report.
 */
export function describePackageFailures(failures: readonly PackageFailure[]): string | null {
  const unreachable = failures.filter((f) => f.kind === 'unreachable').map((f) => f.url);
  const timeout = failures.filter((f) => f.kind === 'timeout').map((f) => f.url);
  const http = failures.filter(
    (f): f is Extract<PackageFailure, { kind: 'http' }> => f.kind === 'http',
  );
  const lines: string[] = [];
  if (unreachable.length > 0) lines.push(`Package server unreachable: ${labels(unreachable)}`);
  if (timeout.length > 0) lines.push(`Package server not responding: ${labels(timeout)}`);
  for (const f of http.slice(0, PACKAGE_LABELS_MAX)) {
    lines.push(
      `Package server error (HTTP ${String(f.status)}) for ${packageLabel(f.url)}${f.detail ? `: ${f.detail}` : ''}`,
    );
  }
  if (http.length > PACKAGE_LABELS_MAX) {
    lines.push(`(+${String(http.length - PACKAGE_LABELS_MAX)} more package errors)`);
  }
  if (lines.length === 0) return null;
  if (unreachable.length > 0 || timeout.length > 0) {
    lines.push(
      'Packages this browser loaded before keep working; a new one needs the package server.',
    );
  }
  return lines.join('\n');
}

/**
 * The text for a module graph that is still waiting for packages after `waitedMs`: the
 * package server neither answered nor failed for `urls` yet. It may still answer (a package
 * nobody asked for before can take a while to build), so this is not an error yet.
 */
export function describePackageStall(urls: readonly string[], waitedMs: number): string | null {
  if (urls.length === 0) return null;
  return `Still waiting for the package server after ${String(Math.round(waitedMs / 1000))} s: ${labels(urls)}\nThe preview starts as soon as it answers.`;
}

/** First line of an error body, trimmed and capped (the CDN's own error text). */
export function errorDetail(body: string, max = 200): string {
  const line = body.trim().split('\n')[0]?.trim() ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
