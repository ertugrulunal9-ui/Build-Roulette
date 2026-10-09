/**
 * A full page load of an app path (T-037). Next's client router fetches a page's flight data
 * from `{path}.txt`, which the static export has only for real pages: a shell path
 * (`/r/{code}`, `/battles/{id}`, `/u/{id}`) is a host rewrite, and its `.txt` request would get
 * the shell's HTML, after which the router falls back to a page load anyway. Going there
 * directly skips that wasted request. Also used where a page load is the point (signing in or
 * out of /admin resets every piece of client state).
 */
export function loadPage(path: string): void {
  window.location.assign(new URL(path, window.location.origin).href);
}

/** `loadPage`, without a history entry for the current page. */
export function replacePage(path: string): void {
  window.location.replace(new URL(path, window.location.origin).href);
}
