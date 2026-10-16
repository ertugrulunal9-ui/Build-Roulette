/**
 * Whether this browser has seen the welcome screen (T-049, docs/09 §9.6), and whether it is
 * open. Plain TS (no React), so the e2e can import the storage key.
 *
 * - **Status**, remembered in localStorage under {@link WELCOME_KEY}: `new` (never closed: the
 *   welcome opens by itself on a player-facing entry point), `skipped` (closed before the last
 *   step: it stays closed, and the lobby's "New here?" card still offers it) and `done` (closed
 *   on the last step).
 * - **Storage blocked** (a private window, blocked site data): every read and write is in
 *   try/catch, and the status is kept in memory, so the player can still close the welcome for
 *   this page view.
 * - **Open**: by itself while the status is `new`, or on request ("How it works",
 *   {@link openWelcome}). Only the pages that mount the welcome (the home page, `/play` before a
 *   battle, a room's lobby) ever show it.
 */

/** The localStorage key (the e2e marks the welcome as seen with it, e2e/welcome.ts). */
export const WELCOME_KEY = 'br:welcome';

export type WelcomeStatus = 'new' | 'skipped' | 'done';

/** The status once known in this page view (set by every close, so blocked storage works). */
let memory: WelcomeStatus | null = null;
/** "How it works" asked for it. */
let requested = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function readStored(): WelcomeStatus {
  try {
    const value = window.localStorage.getItem(WELCOME_KEY);
    if (value === null) return 'new';
    return value === 'skipped' ? 'skipped' : 'done';
  } catch {
    // Storage blocked: never seen, as far as we can tell.
    return 'new';
  }
}

/** This browser's status (`new` when storage is blocked and nothing was closed yet). */
export function welcomeStatus(): WelcomeStatus {
  return memory ?? readStored();
}

/** Whether the welcome shows now (where it is mounted). */
export function isWelcomeOpen(): boolean {
  return requested || welcomeStatus() === 'new';
}

/** "How it works": opens the welcome again, from its first step. */
export function openWelcome(): void {
  requested = true;
  emit();
}

/**
 * Closes the welcome and remembers it. `finished`: closed on the last step ("Let's play",
 * "Practice first"); otherwise skipped (Esc, "Skip", a link out), unless it was finished before.
 */
export function closeWelcome(finished: boolean): void {
  const next: WelcomeStatus = finished || welcomeStatus() === 'done' ? 'done' : 'skipped';
  memory = next;
  requested = false;
  try {
    window.localStorage.setItem(WELCOME_KEY, next);
  } catch {
    // Storage blocked: closed for this page view only.
  }
  emit();
}

/**
 * The welcome's host went away (the lobby when a battle starts): a pending "How it works"
 * request ends with it, so the welcome does not pop up again later by itself.
 */
export function dropWelcomeRequest(): void {
  if (!requested) return;
  requested = false;
  emit();
}

export function subscribeWelcome(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Tests: forget the in-memory state. */
export function resetWelcomeForTests(): void {
  memory = null;
  requested = false;
  emit();
}
