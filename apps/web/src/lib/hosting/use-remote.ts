'use client';

/**
 * Loads a static shell's data in the browser (T-037): `loading` until `load()` settles, then
 * `ready` with its value (null meaning "nothing there") or `error`. `key` names what is loaded
 * (the id, the cursor); a new key loads again, and an answer for an older key is dropped.
 * `retry()` loads the same key again. `key: null` waits (the page is not hydrated yet).
 */
import { useCallback, useEffect, useState } from 'react';

export type Remote<T> =
  | { status: 'loading' }
  | { status: 'ready'; value: T }
  | { status: 'error'; message: string };

export function useRemote<T>(
  key: string | null,
  load: () => Promise<T>,
): { state: Remote<T>; retry: () => void } {
  const [result, setResult] = useState<{ key: string; attempt: number; state: Remote<T> } | null>(
    null,
  );
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (key === null) return;
    let live = true;
    load().then(
      (value) => {
        if (live) setResult({ key, attempt, state: { status: 'ready', value } });
      },
      (e: unknown) => {
        if (live) {
          setResult({
            key,
            attempt,
            state: { status: 'error', message: e instanceof Error ? e.message : String(e) },
          });
        }
      },
    );
    return () => {
      live = false;
    };
    // `load` is a fresh closure every render; `key` is what it loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt]);

  const retry = useCallback(() => {
    setAttempt((n) => n + 1);
  }, []);
  const current =
    result && result.key === key && result.attempt === attempt
      ? result.state
      : { status: 'loading' as const };
  return { state: current, retry };
}
