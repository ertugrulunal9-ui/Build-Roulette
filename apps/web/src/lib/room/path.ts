import { shellParam } from '../hosting/shells';

/**
 * The room code in a `/r/{code}` URL path (the browser's: every room shares one exported
 * page, T-033/T-037). `''` when the path has none, or an undecodable one.
 */
export function roomCodeFromPath(pathname: string): string {
  return shellParam('/r', pathname);
}
