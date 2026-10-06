/**
 * Size caps for every message that crosses the app <-> sandbox boundary.
 *
 * Shell -> app messages come from untrusted user code (the build can forge them), so the
 * app rejects anything above these caps. The shell truncates to the same caps before
 * sending, so honest shells never hit the rejection path.
 */
export const LIMITS = {
  /** Max console arguments forwarded per call. Extra args are summarized in one marker arg. */
  consoleMaxArgs: 20,
  /** Max characters per serialized console argument. */
  consoleArgMaxChars: 2_000,
  /** Max characters of a runtime error message. */
  errorMessageMaxChars: 2_000,
  /** Max characters of a runtime error stack. */
  errorStackMaxChars: 8_000,
  /** Max console messages per second the shell forwards. Extra messages are dropped and counted. */
  consoleMaxPerSecond: 100,
  /** Max characters of a `load` JS bundle (app -> shell, trusted, but still bounded). */
  bundleJsMaxChars: 10_000_000,
  /** Max characters of a `load` CSS bundle. */
  bundleCssMaxChars: 2_000_000,
  /** Max import map entries. */
  importMapMaxEntries: 200,
  /** Max characters of an import map specifier or URL. */
  importMapValueMaxChars: 2_048,
  /** Max characters of a thumbnail data URL. */
  thumbnailMaxChars: 2_000_000,
  /** Max error strings in a storage-reset ack. */
  storageResetMaxErrors: 20,
} as const;

/** Truncates `s` to `max` characters, appending a marker that says how much was cut. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const marker = `… [truncated ${s.length - max} chars]`;
  if (max <= marker.length) return s.slice(0, max);
  return s.slice(0, max - marker.length) + marker;
}
