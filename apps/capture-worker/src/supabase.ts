/**
 * `Backend` over Supabase's HTTP APIs (PostgREST RPCs and the Storage API) with the service
 * role key. Plain `fetch`, no SDK: the worker uses a handful of endpoints, and keeping them
 * explicit makes the contract with T-011's SQL easy to review.
 *
 * Storage API quirks handled here (verified against the local stack):
 * - errors come as HTTP 400 with the real status in the body (`{"statusCode":"404"}`);
 * - `object/list` lists ONE folder level; folders are entries with `id: null`;
 * - `DELETE object/{bucket}` with `{prefixes: [...]}` deletes exact object names and returns
 *   the deleted rows (unknown names are ignored).
 *
 * The service key is sent as `apikey`, and also as a Bearer token when it is a JWT (the
 * legacy `service_role` key). The newer `sb_secret_…` keys are not JWTs and go in `apikey`
 * only; the hosted gateway turns them into a service_role JWT.
 */
import type { BudgetBackend, BudgetState } from './budget';
import {
  BackendError,
  type Backend,
  type BuildRow,
  type CaptureStatus,
  type Job,
  type JobKind,
  type StorageEntry,
} from './backend';

export interface SupabaseBackendOptions {
  /** e.g. http://127.0.0.1:54321 or https://<ref>.supabase.co */
  url: string;
  /**
   * Base of the signed Storage URLs handed to the browser, when it reaches Supabase under
   * another name than we do (the local Edge Runtime calls `http://kong:8000`, the browser
   * `http://127.0.0.1:54321`). Default: `url`.
   */
  publicUrl?: string | undefined;
  serviceKey: string;
  /** Per-request timeout. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const LIST_PAGE = 1000;

export class SupabaseBackend implements Backend, BudgetBackend {
  private readonly base: string;
  private readonly publicBase: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: SupabaseBackendOptions) {
    this.base = opts.url.replace(/\/+$/, '');
    this.publicBase = (opts.publicUrl ?? opts.url).replace(/\/+$/, '');
    this.headers = {
      apikey: opts.serviceKey,
      ...(opts.serviceKey.startsWith('eyJ') ? { authorization: `Bearer ${opts.serviceKey}` } : {}),
    };
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  // ─── RPCs and tables ────────────────────────────────────────────────────

  async claimJob(kind: JobKind): Promise<Job | null> {
    const row = (await this.rpc('claim_job', { p_kind: kind })) as
      (Omit<Job, 'id'> & { id: number | null }) | null;
    // PostgREST returns an object whose fields are all null when the function returns NULL.
    const id = row?.id ?? null;
    if (row === null || id === null) return null;
    return { ...row, id };
  }

  async completeCapture(
    buildId: string,
    status: Exclude<CaptureStatus, 'pending'>,
    path: string | null,
  ): Promise<void> {
    await this.rpc('complete_capture', { p_build_id: buildId, p_status: status, p_path: path });
  }

  async failJob(jobId: number, error: string): Promise<Job> {
    return (await this.rpc('fail_job', { p_job_id: jobId, p_error: error.slice(0, 2000) })) as Job;
  }

  async completeDestroy(battleId: string): Promise<void> {
    await this.rpc('complete_destroy', { p_battle_id: battleId });
  }

  async completeTakedown(buildId: string): Promise<void> {
    await this.rpc('complete_takedown', { p_build_id: buildId });
  }

  async getBuild(buildId: string): Promise<BuildRow | null> {
    const q = new URLSearchParams({
      id: `eq.${buildId}`,
      select: 'id,battle_id,builder_id,status,capture_status,taken_down_at',
    });
    const res = await this.request('GET', `/rest/v1/builds?${q.toString()}`);
    const rows = (await this.json(res)) as BuildRow[];
    return rows[0] ?? null;
  }

  async getBattlePhase(battleId: string): Promise<string | null> {
    const q = new URLSearchParams({ id: `eq.${battleId}`, select: 'phase' });
    const res = await this.request('GET', `/rest/v1/battles?${q.toString()}`);
    const rows = (await this.json(res)) as { phase: string }[];
    return rows[0]?.phase ?? null;
  }

  // ─── Browser Rendering budget (T-034) ───────────────────────────────────

  async reserveBrowserTime(reserveMs: number, limitMs: number): Promise<BudgetState> {
    const row = (await this.rpc('browser_budget_reserve', {
      p_reserve_ms: reserveMs,
      p_limit_ms: limitMs,
    })) as {
      granted: boolean;
      day: string;
      used_ms: number;
      reserved_ms: number;
      limit_ms: number;
    };
    return {
      granted: row.granted,
      day: row.day,
      usedMs: row.used_ms,
      reservedMs: row.reserved_ms,
      limitMs: row.limit_ms,
    };
  }

  async settleBrowserTime(
    day: string,
    reservedMs: number,
    usedMs: number,
    rateLimited: boolean,
  ): Promise<void> {
    await this.rpc('browser_budget_settle', {
      p_day: day,
      p_reserved_ms: reservedMs,
      p_used_ms: usedMs,
      p_rate_limited: rateLimited,
    });
  }

  // ─── Storage ────────────────────────────────────────────────────────────

  async createSignedUrl(
    bucket: string,
    path: string,
    expiresInSeconds: number,
  ): Promise<string | null> {
    const res = await this.request(
      'POST',
      `/storage/v1/object/sign/${bucket}/${encodePath(path)}`,
      {
        json: { expiresIn: expiresInSeconds },
        allowNotFound: true,
      },
    );
    if (res === null) return null;
    const body = (await this.json(res)) as { signedURL?: string };
    if (!body.signedURL)
      throw new BackendError('sign: no signedURL in the response', 500, undefined);
    return `${this.publicBase}/storage/v1${body.signedURL}`;
  }

  async download(bucket: string, path: string): Promise<Uint8Array | null> {
    const res = await this.request(
      'GET',
      `/storage/v1/object/authenticated/${bucket}/${encodePath(path)}`,
      { allowNotFound: true },
    );
    if (res === null) return null;
    return new Uint8Array(await res.arrayBuffer());
  }

  async upload(bucket: string, path: string, body: Uint8Array, contentType: string): Promise<void> {
    const res = await this.request('POST', `/storage/v1/object/${bucket}/${encodePath(path)}`, {
      body,
      headers: { 'content-type': contentType, 'x-upsert': 'true', 'cache-control': 'max-age=300' },
    });
    await res.arrayBuffer();
  }

  async list(bucket: string, prefix: string): Promise<StorageEntry[]> {
    const out: StorageEntry[] = [];
    for (let offset = 0; ; offset += LIST_PAGE) {
      const res = await this.request('POST', `/storage/v1/object/list/${bucket}`, {
        json: { prefix, limit: LIST_PAGE, offset, sortBy: { column: 'name', order: 'asc' } },
      });
      const page = (await this.json(res)) as { name: string; id: string | null }[];
      for (const e of page) out.push({ name: e.name, isFolder: e.id === null });
      if (page.length < LIST_PAGE) return out;
    }
  }

  async remove(bucket: string, paths: readonly string[]): Promise<string[]> {
    if (paths.length === 0) return [];
    const res = await this.request('DELETE', `/storage/v1/object/${bucket}`, {
      json: { prefixes: paths },
    });
    const rows = (await this.json(res)) as { name: string }[];
    return rows.map((r) => r.name);
  }

  // ─── HTTP ───────────────────────────────────────────────────────────────

  private async rpc(fn: string, args: Record<string, unknown>): Promise<unknown> {
    const res = await this.request('POST', `/rest/v1/rpc/${fn}`, { json: args });
    return this.json(res);
  }

  private async json(res: Response): Promise<unknown> {
    const text = await res.text();
    return text ? (JSON.parse(text) as unknown) : null;
  }

  private request(
    method: string,
    path: string,
    opts: {
      json?: unknown;
      body?: Uint8Array;
      headers?: Record<string, string>;
      allowNotFound: true;
    },
  ): Promise<Response | null>;
  private request(
    method: string,
    path: string,
    opts?: {
      json?: unknown;
      body?: Uint8Array;
      headers?: Record<string, string>;
      allowNotFound?: false;
    },
  ): Promise<Response>;
  private async request(
    method: string,
    path: string,
    opts: {
      json?: unknown;
      body?: Uint8Array;
      headers?: Record<string, string>;
      allowNotFound?: boolean;
    } = {},
  ): Promise<Response | null> {
    const headers: Record<string, string> = { ...this.headers, ...opts.headers };
    let body: BodyInit | undefined;
    if (opts.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.json);
    } else if (opts.body) {
      body = new Uint8Array(opts.body); // a copy backed by a plain ArrayBuffer (BodyInit)
    }
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (res.ok) return res;
    const text = await res.text().catch(() => '');
    let parsed: { message?: string; code?: string; statusCode?: string; details?: string } = {};
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      // not JSON
    }
    // Storage: HTTP 400 with the real status in the body.
    const status = parsed.statusCode ? Number(parsed.statusCode) : res.status;
    if (status === 404 && opts.allowNotFound) return null;
    const label = `${method} ${path.split('?')[0] ?? path}`;
    throw new BackendError(
      `${label}: HTTP ${String(status)} ${parsed.message ?? text.slice(0, 200)}${parsed.details ? ` (${parsed.details})` : ''}`,
      status,
      parsed.message,
    );
  }
}

/** Encodes each path segment (object names here are UUIDs and fixed file names). */
export function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}
