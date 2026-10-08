/**
 * Where caught client errors go (T-030): client-errors.ts sets the sink once the Sentry chunk
 * is loaded; app/global-error.tsx reports through it. A module of its own so that importing
 * it (which a server-rendered component does) brings no SDK into the server bundle.
 */
let sink: ((error: unknown) => void) | null = null;

export function setErrorSink(next: ((error: unknown) => void) | null): void {
  sink = next;
}

/** Reports an error the app caught itself; a no-op while reporting is off or loading. */
export function reportClientError(error: unknown): void {
  sink?.(error);
}
