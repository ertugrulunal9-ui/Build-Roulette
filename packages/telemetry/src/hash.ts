/**
 * The pseudonymous user id sent to Sentry and PostHog (T-030): the first 128 bits of
 * SHA-256("br-telemetry:v1:" + the anonymous Supabase user id), as 32 hex characters.
 *
 * Why not the raw id: it is not secret. `/u/{user id}` is the player's public history page,
 * which shows their display name, so anyone who can read the telemetry could go from an
 * event to a name. Why this is enough: the ids are random v4 UUIDs (122 random bits), so the
 * hash cannot be reversed by trying ids, while an operator who is given an id (a support
 * request) can still compute its hash and find that player's events. The prefix only keeps
 * the value specific to this use; it is not a secret (it is in the browser bundle).
 *
 * Web Crypto only (browsers, Node 22 and workerd all have `crypto.subtle`); null where it is
 * missing (an insecure http origin), and then events carry no user at all.
 */
import { isUuid } from './scrub';

export const USER_HASH_PREFIX = 'br-telemetry:v1:';

export async function hashUserId(userId: string): Promise<string | null> {
  const subtle = (globalThis.crypto as Crypto | undefined)?.subtle;
  if (!subtle || !isUuid(userId)) return null;
  const digest = await subtle.digest(
    'SHA-256',
    new TextEncoder().encode(USER_HASH_PREFIX + userId.toLowerCase()),
  );
  return Array.from(new Uint8Array(digest).slice(0, 16), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}
