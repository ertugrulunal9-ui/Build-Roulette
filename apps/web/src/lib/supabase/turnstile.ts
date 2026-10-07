/**
 * Cloudflare Turnstile for anonymous sign-ups (docs/02 R9, supabase/README.md "Abuse
 * controls"). When `NEXT_PUBLIC_TURNSTILE_SITE_KEY` is set (production), the browser gets a
 * Turnstile token before `signInAnonymously`, and Supabase Auth verifies it (dashboard →
 * Auth → Bot and Abuse Protection, provider Turnstile, with the secret key). Without the
 * key (local dev, tests) there is no widget and no token, and the local stack does not ask
 * for one.
 *
 * The widget is rendered on demand with `appearance: 'interaction-only'`: invisible unless
 * Cloudflare wants the visitor to click, in which case it appears at the bottom of the
 * screen until solved. One token per sign-in (tokens are single-use).
 */

export const TURNSTILE_SCRIPT_URL =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

/** The subset of `window.turnstile` used here. */
export interface TurnstileApi {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      appearance?: 'always' | 'execute' | 'interaction-only';
      action?: string;
      callback: (token: string) => void;
      'error-callback'?: (code?: string) => void;
      'expired-callback'?: () => void;
      'timeout-callback'?: () => void;
    },
  ): string | undefined;
  remove(widgetId: string): void;
}

export function turnstileSiteKey(): string | null {
  const key = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim();
  return key ? key : null;
}

let scriptPromise: Promise<TurnstileApi> | null = null;

/** Loads the Turnstile script once and resolves with `window.turnstile`. */
export function loadTurnstile(doc: Document = document): Promise<TurnstileApi> {
  const win = doc.defaultView as (Window & { turnstile?: TurnstileApi }) | null;
  if (win?.turnstile) return Promise.resolve(win.turnstile);
  scriptPromise ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = doc.createElement('script');
    script.src = TURNSTILE_SCRIPT_URL;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      if (win?.turnstile) resolve(win.turnstile);
      else reject(new Error('Turnstile loaded without window.turnstile'));
    };
    script.onerror = () => {
      scriptPromise = null;
      reject(new Error('Turnstile could not be loaded'));
    };
    doc.head.appendChild(script);
  });
  return scriptPromise;
}

export interface CaptchaOptions {
  /** Default: `NEXT_PUBLIC_TURNSTILE_SITE_KEY`. */
  siteKey?: string | null;
  /** Default: the real script (tests pass a fake). */
  load?: () => Promise<TurnstileApi>;
  doc?: Document;
  /** Give up after this long (the visitor may need to click). Default 120 s. */
  timeoutMs?: number;
}

/**
 * A fresh Turnstile token, or undefined when Turnstile is not configured. Rejects when the
 * widget fails or times out (the sign-in then fails with a clear error instead of hanging).
 */
export async function getCaptchaToken(opts: CaptchaOptions = {}): Promise<string | undefined> {
  const siteKey = opts.siteKey === undefined ? turnstileSiteKey() : opts.siteKey;
  if (!siteKey) return undefined;
  const doc = opts.doc ?? document;
  const api = await (opts.load ?? (() => loadTurnstile(doc)))();
  const container = doc.createElement('div');
  container.setAttribute('data-testid', 'turnstile');
  container.style.cssText =
    'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483000';
  doc.body.appendChild(container);
  let widgetId: string | undefined;
  try {
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Turnstile timed out'));
      }, opts.timeoutMs ?? 120_000);
      const done = (fn: () => void) => {
        clearTimeout(timer);
        fn();
      };
      widgetId = api.render(container, {
        sitekey: siteKey,
        appearance: 'interaction-only',
        action: 'anonymous-sign-in',
        callback: (token) => {
          done(() => {
            resolve(token);
          });
        },
        'error-callback': (code) => {
          done(() => {
            reject(new Error(`Turnstile error${code ? ` ${code}` : ''}`));
          });
        },
        'expired-callback': () => {
          done(() => {
            reject(new Error('Turnstile token expired'));
          });
        },
        'timeout-callback': () => {
          done(() => {
            reject(new Error('Turnstile challenge timed out'));
          });
        },
      });
    });
  } finally {
    if (widgetId !== undefined) {
      try {
        api.remove(widgetId);
      } catch {
        // already gone
      }
    }
    container.remove();
  }
}
