/**
 * What the workers need from Supabase, as an interface so the job logic can be unit tested
 * with fakes (test/fakes.ts). The real implementation is `SupabaseBackend` (supabase.ts).
 *
 * RPC contract (service_role, supabase/migrations/20261004120400_jobs.sql):
 * - `claim_job(kind)` returns a jobs row with a 2-minute lease, or nothing;
 * - `complete_capture(build, status, path)`; `fail_job(job, error)` (backoff and the final
 *   attempt are handled in SQL: at 5 attempts the job fails and the build's
 *   capture_status becomes `failed`); `complete_destroy(battle)`.
 */

export type JobKind = 'capture' | 'destroy';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed';
export type BuildStatus = 'draft' | 'shipped' | 'auto_shipped' | 'dnf';
export type CaptureStatus = 'pending' | 'captured' | 'fallback' | 'failed';

export interface Job {
  id: number;
  kind: JobKind;
  /** Build id (capture) or battle id (destroy). */
  ref_id: string;
  status: JobStatus;
  attempts: number;
  run_after: string;
  last_error: string | null;
}

export interface BuildRow {
  id: string;
  battle_id: string;
  builder_id: string;
  status: BuildStatus;
  capture_status: CaptureStatus;
}

/** Most attempts a job gets (`claim_job` / `fail_job` in SQL). */
export const MAX_JOB_ATTEMPTS = 5;
/** `claim_job` lease. A job must finish (or be given up) well within it. */
export const JOB_LEASE_MS = 120_000;

export const BUCKET_EPHEMERAL = 'ephemeral-builds';
export const BUCKET_SCREENSHOTS = 'screenshots';

export interface StorageEntry {
  /** Name relative to the listed prefix (no slashes). */
  name: string;
  isFolder: boolean;
}

export interface Backend {
  claimJob(kind: JobKind): Promise<Job | null>;
  completeCapture(
    buildId: string,
    status: Exclude<CaptureStatus, 'pending'>,
    path: string | null,
  ): Promise<void>;
  /** Returns the job after the failure was recorded (`status: 'failed'` once given up). */
  failJob(jobId: number, error: string): Promise<Job>;
  completeDestroy(battleId: string): Promise<void>;
  getBuild(buildId: string): Promise<BuildRow | null>;
  /** The battle's phase, or null if there is no such battle. */
  getBattlePhase(battleId: string): Promise<string | null>;

  /** A short-lived URL that reads the object without credentials; null if it does not exist. */
  createSignedUrl(bucket: string, path: string, expiresInSeconds: number): Promise<string | null>;
  /** The object's bytes; null if it does not exist. */
  download(bucket: string, path: string): Promise<Uint8Array | null>;
  upload(bucket: string, path: string, body: Uint8Array, contentType: string): Promise<void>;
  /** One level of a folder (`prefix` ends with `/`), all pages. */
  list(bucket: string, prefix: string): Promise<StorageEntry[]>;
  /** Deletes the objects through the Storage API; returns the names it deleted. */
  remove(bucket: string, paths: readonly string[]): Promise<string[]>;
}

/** An error from Supabase with the HTTP status and the stable error code (`message`). */
export class BackendError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(message);
    this.name = 'BackendError';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Canonical lowercase UUID text, as storage paths use it. Guards every path we build. */
export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}
