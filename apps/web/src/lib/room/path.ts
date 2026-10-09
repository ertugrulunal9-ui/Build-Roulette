/**
 * The room code in a `/r/{code}` URL path (the browser's: every room shares one prerendered
 * page, T-033). `''` when the path has none, or an undecodable one.
 */
export function roomCodeFromPath(pathname: string): string {
  const m = /^\/r\/([^/]+)\/?$/.exec(pathname);
  if (!m?.[1]) return '';
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return '';
  }
}
