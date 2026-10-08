/**
 * Load test configuration: profiles plus command-line overrides (`--rooms 20 --players 6`).
 *
 * Time compression: real battles last 5–15 min of BUILDING plus REVEAL, VOTING and RESULTS
 * (about 20 min). The generator shortens every phase through SQL on each battle it starts
 * (see db.ts `compressBattle`), so a battle takes a few minutes. Client cadences that are
 * wall-clock rates in the product (heartbeat 10 s, autosave 30 s, clock resync 60 s,
 * presence ≤ 4 per 30 s) are NOT compressed: the concurrent load per connected client is
 * the real one. Per-battle totals of those rate-driven items are scaled back to real battle
 * lengths in the cost model (cost.ts), not taken from the compressed run as they are.
 */

export type RealtimeLimits = 'keep' | 'free' | 'pro' | 'pro-nocap' | 'unlimited';
export type AuthMode = 'admin' | 'anonymous';

export interface LoadConfig {
  profile: string;
  rooms: number;
  /** Players per room, host included (2–8). */
  players: number;
  battlesPerRoom: number;
  /** Room starts are spread evenly over this many seconds. */
  rampS: number;
  /** Child processes that share the rooms (each has its own event loop). */
  procs: number;

  // Compressed phase lengths (seconds), written into each battle by SQL.
  /** BUILDING length; the schema's check on challenges.time_limit_seconds allows ≥ 60. */
  buildS: number;
  spinningS: number;
  shippingS: number;
  revealSlotS: number;
  votingS: number;
  resultsS: number;
  /** How long RESULTS waits for screenshots before DESTROY (product default 600). */
  captureDeadlineS: number;

  // Client cadences (product values, not compressed).
  heartbeatMs: number;
  autosaveMs: number;
  clockResyncMs: number;

  // Player behaviour.
  /** Share of players who ship by hand; the rest auto-ship from their autosave or DNF. */
  shipShare: number;
  /** Share of players who never autosave nor ship (DNF, e.g. a phone player). */
  dnfShare: number;
  /** Share of voters who never vote (VOTING then runs to its deadline). */
  silentVoterShare: number;
  /** Probability that the host clicks "next" in a REVEAL slot (else the slot times out). */
  hostNextShare: number;

  // Services and environment.
  /** Run the capture worker (Playwright Chromium) during the test. */
  capture: boolean;
  captureConcurrency: number;
  realtimeLimits: RealtimeLimits;
  auth: AuthMode;
  /** After the last room finished: wait at most this long for the capture/destroy queues. */
  drainTimeoutS: number;
  /** A room that has not finished after this long is abandoned by the generator. */
  roomTimeoutS: number;
  seed: number;
  outDir: string;
  /** Sample docker stats (needs the docker CLI). */
  dockerStats: boolean;
  /** HTTP requests that take longer are aborted and counted as `timeout`. */
  requestTimeoutMs: number;
  /** Raise the local Kong gateway's nginx worker_connections to this (0: leave it at 512). */
  gatewayConnections: number;
  /** Realtime's authorization pool for the run (0: leave it; the local default is 1). */
  realtimeDbPool: number;
}

const BASE: LoadConfig = {
  profile: 'custom',
  rooms: 10,
  players: 6,
  battlesPerRoom: 1,
  rampS: 30,
  procs: 1,
  buildS: 60,
  spinningS: 3,
  shippingS: 5,
  revealSlotS: 5,
  votingS: 20,
  resultsS: 10,
  captureDeadlineS: 240,
  heartbeatMs: 10_000,
  autosaveMs: 30_000,
  clockResyncMs: 60_000,
  shipShare: 0.75,
  dnfShare: 0.05,
  silentVoterShare: 0.05,
  hostNextShare: 0.6,
  capture: true,
  captureConcurrency: 2,
  realtimeLimits: 'keep',
  auth: 'admin',
  drainTimeoutS: 300,
  roomTimeoutS: 1200,
  seed: 20261007,
  outDir: 'loadtest-results',
  dockerStats: true,
  requestTimeoutMs: 20_000,
  gatewayConnections: 8192,
  realtimeDbPool: 0,
};

export const PROFILES: Record<string, Partial<LoadConfig>> = {
  /** A few minutes on a fresh stack: CI (workflow_dispatch) and the hub's re-run. */
  smoke: { rooms: 3, players: 4, battlesPerRoom: 1, rampS: 5, procs: 1, captureDeadlineS: 180 },
  /** M5 target: 50 rooms × 8 players = 400 clients, two battles per room. */
  full: {
    rooms: 50,
    players: 8,
    battlesPerRoom: 2,
    rampS: 60,
    procs: 4,
    realtimeLimits: 'pro-nocap',
    captureConcurrency: 2,
  },
};

const NUMERIC: (keyof LoadConfig)[] = [
  'rooms',
  'players',
  'battlesPerRoom',
  'rampS',
  'procs',
  'buildS',
  'spinningS',
  'shippingS',
  'revealSlotS',
  'votingS',
  'resultsS',
  'captureDeadlineS',
  'heartbeatMs',
  'autosaveMs',
  'clockResyncMs',
  'shipShare',
  'dnfShare',
  'silentVoterShare',
  'hostNextShare',
  'captureConcurrency',
  'drainTimeoutS',
  'roomTimeoutS',
  'seed',
  'requestTimeoutMs',
  'gatewayConnections',
  'realtimeDbPool',
];

/** `--battles-per-room` → `battlesPerRoom`. */
function camel(flag: string): string {
  return flag.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

export class UsageError extends Error {}

export function parseArgs(argv: readonly string[]): LoadConfig {
  const raw: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (!a.startsWith('--')) throw new UsageError(`unexpected argument ${a}`);
    const eq = a.indexOf('=');
    if (eq > 0) {
      raw[camel(a.slice(2, eq))] = a.slice(eq + 1);
      continue;
    }
    const key = camel(a.slice(2));
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      raw[key] = next;
      i++;
    } else {
      raw[key] = true;
    }
  }
  if (raw['smoke'] === true) raw['profile'] = 'smoke';
  if (raw['full'] === true) raw['profile'] = 'full';
  delete raw['smoke'];
  delete raw['full'];

  const profileName = typeof raw['profile'] === 'string' ? raw['profile'] : 'custom';
  const profile = profileName === 'custom' ? {} : PROFILES[profileName];
  if (!profile) throw new UsageError(`unknown profile ${profileName}`);
  const cfg: LoadConfig = { ...BASE, ...profile, profile: profileName };
  delete raw['profile'];

  for (const [key, value] of Object.entries(raw)) {
    if (!(key in BASE)) throw new UsageError(`unknown option --${key}`);
    const k = key as keyof LoadConfig;
    if (NUMERIC.includes(k)) {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new UsageError(`--${key} must be a number`);
      (cfg as unknown as Record<string, unknown>)[k] = n;
    } else if (typeof BASE[k] === 'boolean') {
      (cfg as unknown as Record<string, unknown>)[k] =
        value === true || value === 'true' || value === '1';
    } else {
      (cfg as unknown as Record<string, unknown>)[k] = String(value);
    }
  }
  return validate(cfg);
}

export function validate(cfg: LoadConfig): LoadConfig {
  const problems: string[] = [];
  const int = (k: keyof LoadConfig, min: number, max: number) => {
    const v = cfg[k] as number;
    if (!Number.isInteger(v) || v < min || v > max) problems.push(`${k} must be ${min}–${max}`);
  };
  const share = (k: keyof LoadConfig) => {
    const v = cfg[k] as number;
    if (!(v >= 0 && v <= 1)) problems.push(`${k} must be between 0 and 1`);
  };
  int('rooms', 1, 500);
  int('players', 2, 8);
  int('battlesPerRoom', 1, 20);
  int('procs', 1, 16);
  int('buildS', 60, 3600);
  int('spinningS', 1, 60);
  int('shippingS', 1, 60);
  int('revealSlotS', 2, 60);
  int('votingS', 5, 180);
  int('resultsS', 2, 120);
  int('captureDeadlineS', 30, 600);
  int('captureConcurrency', 1, 8);
  share('shipShare');
  share('dnfShare');
  share('silentVoterShare');
  share('hostNextShare');
  if (cfg.shipShare + cfg.dnfShare > 1) problems.push('shipShare + dnfShare must be ≤ 1');
  if (!['keep', 'free', 'pro', 'pro-nocap', 'unlimited'].includes(cfg.realtimeLimits)) {
    problems.push('realtimeLimits must be keep, free, pro, pro-nocap or unlimited');
  }
  if (!['admin', 'anonymous'].includes(cfg.auth)) problems.push('auth must be admin or anonymous');
  if (problems.length > 0) throw new UsageError(problems.join('; '));
  return { ...cfg, procs: Math.min(cfg.procs, cfg.rooms) };
}

/** The battle settings the generator writes into each battle (db.ts). */
export function compressedSettings(cfg: LoadConfig): Record<string, number> {
  return {
    spinning_s: cfg.spinningS,
    shipping_s: cfg.shippingS,
    reveal_slot_s: cfg.revealSlotS,
    voting_s: cfg.votingS,
    results_s: cfg.resultsS,
    capture_deadline_s: cfg.captureDeadlineS,
  };
}

/** Product defaults (supabase/migrations: default_battle_settings, reveal_slot_seconds). */
export const PRODUCT_DURATIONS = {
  spinning_s: 6,
  shipping_s: 15,
  /** round(clamp(300 / n, 30, 60)) for n final builds. */
  reveal_slot_s: (n: number) => Math.round(Math.min(60, Math.max(30, 300 / n))),
  voting_s: 60,
  results_s: 60,
  capture_deadline_s: 600,
  build_s: [300, 600, 900],
} as const;

export const HELP = `Build Roulette load generator (tools/loadtest, T-025)

  pnpm --filter @br/loadtest loadtest [--profile smoke|full] [options]

Options (defaults in src/config.ts):
  --rooms N --players N --battles-per-room N --ramp-s S --procs N
  --build-s S --spinning-s S --shipping-s S --reveal-slot-s S --voting-s S --results-s S
  --capture-deadline-s S
  --heartbeat-ms MS --autosave-ms MS --clock-resync-ms MS
  --ship-share P --dnf-share P --silent-voter-share P --host-next-share P
  --capture true|false --capture-concurrency N
  --realtime-limits keep|free|pro|pro-nocap|unlimited   (local Realtime tenant quotas)
  --auth admin|anonymous
  --realtime-db-pool N      (Realtime authorization pool, db_pool; 0 leaves the local default 1)
  --gateway-connections N   (local Kong nginx worker_connections; 0 keeps the default 512)
  --drain-timeout-s S --room-timeout-s S --seed N --out-dir DIR --docker-stats true|false
`;
