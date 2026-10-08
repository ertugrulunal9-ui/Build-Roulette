/**
 * What error reports and analytics events are tagged with (T-030), kept by the app as it
 * goes and read when something is sent: the room, the battle and its phase (random UUIDs and
 * an enum, never a room code or a name), and the pseudonymous user id.
 *
 * `identifyUser` is called with the anonymous Supabase user id once the tab has a session
 * (`ensureSignedIn`). Only its hash (`hashUserId`, @br/telemetry) is kept, and only when some
 * telemetry is configured; nothing here sends anything.
 */
import { hashUserId } from '@br/telemetry/hash';
import { isUuid } from '@br/telemetry/scrub';
import { telemetryConfig, type TelemetryConfig } from './config';

export interface TelemetryContext {
  roomId: string | null;
  battleId: string | null;
  phase: string | null;
  mode: 'solo' | 'multiplayer' | null;
}

const EMPTY: TelemetryContext = { roomId: null, battleId: null, phase: null, mode: null };

let context: TelemetryContext = EMPTY;
let userHash: string | null = null;
let hashing: Promise<string | null> | null = null;
let identifiedAs: string | null = null;
const userWaiters = new Set<(hash: string | null) => void>();

export function telemetryEnabled(config: TelemetryConfig = telemetryConfig): boolean {
  return config.sentryDsn !== null || config.posthogKey !== null;
}

/** Updates the room / battle / phase the next reports are tagged with. */
export function setTelemetryContext(patch: Partial<TelemetryContext>): void {
  const next = { ...context, ...patch };
  // Only random UUIDs leave the browser as ids.
  if (next.roomId !== null && !isUuid(next.roomId)) next.roomId = null;
  if (next.battleId !== null && !isUuid(next.battleId)) next.battleId = null;
  context = next;
}

export function telemetryContext(): TelemetryContext {
  return context;
}

/** The signed-in (anonymous) user: remembered as its hash, when telemetry is on. */
export function identifyUser(userId: string, config: TelemetryConfig = telemetryConfig): void {
  if (!telemetryEnabled(config) || userId === identifiedAs) return;
  identifiedAs = userId;
  const run = hashUserId(userId).catch(() => null);
  hashing = run;
  void run.then((hash) => {
    if (hashing !== run) return;
    userHash = hash;
    for (const w of userWaiters) w(hash);
    userWaiters.clear();
  });
}

/** The hashed user id, or null (not signed in yet, no Web Crypto). */
export function currentUserHash(): string | null {
  return userHash;
}

/**
 * Resolves with the hashed user id once it is known (or null after `timeoutMs`, for a page
 * that never signs in).
 */
export function userHashReady(timeoutMs = 10_000): Promise<string | null> {
  if (userHash !== null) return Promise.resolve(userHash);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      userWaiters.delete(done);
      resolve(null);
    }, timeoutMs);
    const done = (hash: string | null) => {
      clearTimeout(timer);
      resolve(hash);
    };
    userWaiters.add(done);
  });
}

/** Tests only. */
export function resetTelemetryContext(): void {
  context = EMPTY;
  userHash = null;
  hashing = null;
  identifiedAs = null;
  userWaiters.clear();
}
