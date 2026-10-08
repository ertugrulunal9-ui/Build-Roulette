/**
 * The visitor's privacy signals (T-030): Do Not Track (`navigator.doNotTrack`, the old
 * `window.doNotTrack` / `msDoNotTrack`) and Global Privacy Control
 * (`navigator.globalPrivacyControl`). Either one turns product analytics off for the page
 * and keeps the (pseudonymous) user id out of error reports; anonymous error reports still
 * go out, they are what keeps the game working.
 */
interface PrivacyNavigator {
  doNotTrack?: string | null;
  msDoNotTrack?: string | null;
  globalPrivacyControl?: boolean;
}

export function privacySignal(
  nav: PrivacyNavigator | undefined = typeof navigator === 'undefined'
    ? undefined
    : (navigator as PrivacyNavigator),
  win: { doNotTrack?: string | null } | undefined = typeof window === 'undefined'
    ? undefined
    : (window as { doNotTrack?: string | null }),
): boolean {
  if (nav?.globalPrivacyControl === true) return true;
  const dnt = nav?.doNotTrack ?? win?.doNotTrack ?? nav?.msDoNotTrack ?? null;
  return dnt === '1' || dnt === 'yes';
}
