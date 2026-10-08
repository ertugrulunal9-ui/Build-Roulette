/**
 * Sentry DSN checks without the SDK (T-030), for code that only needs to know whether
 * reporting is on (e.g. a page or server action): importing the reporter there would bundle
 * `@sentry/core` into that route as well. Same grammar as the SDK's `dsnFromString`:
 * `{protocol}://{public_key}[:{secret}]@{host}[:{port}]/[{path}/]{project_id}`.
 */
const DSN_RE = /^(?:(\w+):)\/\/(?:(\w+)(?::(\w+)?)?@)([\w.-]+)(?::(\d+))?\/(.+)/;

/** A DSN that can be used, or null (empty, whitespace or malformed: reporting stays off). */
export function usableDsn(dsn: string | null | undefined): string | null {
  const v = dsn?.trim() ?? '';
  if (v === '') return null;
  const m = DSN_RE.exec(v);
  if (!m) return null;
  const [, protocol, , , , , path = ''] = m;
  const projectId = path.split('/').pop() ?? '';
  if ((protocol !== 'http' && protocol !== 'https') || !/^\d+$/.test(projectId)) return null;
  return v;
}
