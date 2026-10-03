/**
 * A request failure with an HTTP status and a human-readable reason. The reason is sent in
 * the response body, so it must never contain server paths or secrets.
 */
export type CdnErrorCode =
  | 'bad-request'
  | 'invalid-name'
  | 'invalid-version'
  | 'unknown-package'
  | 'unknown-version'
  | 'not-found'
  | 'denied'
  | 'too-large'
  | 'too-many-dependencies'
  | 'integrity'
  | 'unsafe-tarball'
  | 'unsupported'
  | 'build-failed'
  | 'timeout'
  | 'registry-error';

export class CdnError extends Error {
  readonly status: number;
  readonly code: CdnErrorCode;

  constructor(status: number, code: CdnErrorCode, message: string) {
    super(message);
    this.name = 'CdnError';
    this.status = status;
    this.code = code;
  }
}

export function isCdnError(e: unknown): e is CdnError {
  return e instanceof CdnError;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
