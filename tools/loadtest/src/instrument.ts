/**
 * Instrumentation that every simulated client shares: a `fetch` that times and sizes each
 * HTTP request (Auth, PostgREST, Storage) and a WebSocket transport that counts Realtime
 * frames. Both are plugged into supabase-js through its own options (`global.fetch`,
 * `realtime.transport`), so the client code paths are the stock ones.
 */
import type { Metrics } from './metrics';

export interface RequestClass {
  /** Metrics key, e.g. "rpc:heartbeat", "storage:upload", "auth:token". */
  key: string;
  /** For storage objects: the file class ("autosave/bundle.js", "thumb.webp", "screenshot"). */
  file: string | null;
  battleId: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Classifies a Supabase API request by its path. */
export function classifyRequest(method: string, url: string): RequestClass {
  const { pathname } = new URL(url);
  const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const none = { file: null, battleId: null };
  if (parts[0] === 'rest' && parts[2] === 'rpc' && parts[3]) {
    return { key: `rpc:${parts[3]}`, ...none };
  }
  if (parts[0] === 'rest' && parts[2]) return { key: `rest:${parts[2]}`, ...none };
  if (parts[0] === 'auth') {
    const rest = parts.slice(2).join('/');
    if (rest.startsWith('admin/users')) return { key: 'auth:admin_users', ...none };
    return { key: `auth:${rest || 'root'}`, ...none };
  }
  if (parts[0] === 'storage' && parts[2] === 'object') {
    // /storage/v1/object/public/{bucket}/{battle}/{build}.webp       (screenshots, public)
    // /storage/v1/object/sign/{bucket}/...                           (signed URLs)
    // /storage/v1/object/{bucket}/{battle}/{user}/{file...}          (upload, download)
    let i = 3;
    let mode: string | null = null;
    if (parts[i] === 'public' || parts[i] === 'sign' || parts[i] === 'authenticated') {
      mode = parts[i] ?? null;
      i++;
    }
    const bucket = parts[i];
    const battle = parts[i + 1] ?? null;
    const battleId = battle && UUID.test(battle) ? battle : null;
    if (bucket === 'screenshots') {
      return {
        key: mode === 'public' ? 'storage:public' : 'storage:screenshot',
        file: 'screenshot',
        battleId,
      };
    }
    const file = parts.slice(i + 3).join('/') || null;
    if (mode === 'sign') return { key: 'storage:sign', file, battleId };
    const m = method.toUpperCase();
    const key =
      m === 'POST' || m === 'PUT'
        ? 'storage:upload'
        : m === 'GET'
          ? 'storage:download'
          : `storage:${m.toLowerCase()}`;
    return { key, file, battleId };
  }
  if (parts[0] === 'realtime') return { key: 'realtime:http', ...none };
  return { key: 'other', ...none };
}

/** Request body size in bytes (strings, Blobs, FormData of Blobs, ArrayBuffers). */
export function bodySize(body: unknown): number {
  if (body === null || body === undefined) return 0;
  if (typeof body === 'string') return Buffer.byteLength(body);
  if (body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  if (body instanceof FormData) {
    let n = 0;
    for (const [k, v] of body.entries()) {
      n += Buffer.byteLength(k) + (typeof v === 'string' ? Buffer.byteLength(v) : v.size);
    }
    return n;
  }
  if (body instanceof URLSearchParams) return Buffer.byteLength(body.toString());
  return 0;
}

const NULL_BODY = new Set([101, 103, 204, 205, 304]);

export function instrumentedFetch(metrics: Metrics, timeoutMs: number): typeof fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const cls = classifyRequest(method, url);
    const up = bodySize(init?.body);
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    metrics.requestStarted();
    const t0 = performance.now();
    let res: Response;
    let buf: ArrayBuffer;
    try {
      res = await fetch(input, { ...init, signal });
      buf = await res.arrayBuffer();
    } catch (e) {
      const status = timeout.aborted ? 'timeout' : 'network';
      metrics.requestEnded(cls.key, performance.now() - t0, status, up, 0);
      metrics.error(`${status}:${cls.key}`);
      throw e;
    }
    const ms = performance.now() - t0;
    metrics.requestEnded(cls.key, ms, String(res.status), up, buf.byteLength);
    if (cls.file && res.ok) {
      if (cls.key === 'storage:upload') metrics.storage('up', cls.file, cls.battleId, up);
      else if (cls.key === 'storage:download' || cls.key === 'storage:public') {
        metrics.storage('down', cls.file, cls.battleId, buf.byteLength);
      }
    }
    return new Response(NULL_BODY.has(res.status) || buf.byteLength === 0 ? null : buf, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  };
}

/**
 * The Phoenix event of a Realtime frame. Protocol 2.0.0 text frames are JSON arrays
 * `[join_ref, ref, topic, event, payload]`; broadcasts can also arrive as binary frames.
 */
export function frameEvent(data: unknown): { event: string; bytes: number } {
  if (typeof data === 'string') {
    let event = 'unparsed';
    try {
      const msg: unknown = JSON.parse(data);
      if (Array.isArray(msg)) event = String(msg[3]);
      else if (msg && typeof msg === 'object' && 'event' in msg) event = String(msg.event);
    } catch {
      // keep "unparsed"
    }
    return { event, bytes: Buffer.byteLength(data) };
  }
  if (data instanceof ArrayBuffer) {
    const kind = new Uint8Array(data)[0];
    return { event: `binary:${String(kind)}`, bytes: data.byteLength };
  }
  if (ArrayBuffer.isView(data)) {
    const kind = new Uint8Array(data.buffer, data.byteOffset, 1)[0];
    return { event: `binary:${String(kind)}`, bytes: data.byteLength };
  }
  if (data instanceof Blob) return { event: 'binary:blob', bytes: data.size };
  return { event: 'unknown', bytes: 0 };
}

/** A WebSocket class (Node 22's global one) that counts connections and frames. */
export function countingWebSocket(metrics: Metrics): typeof WebSocket {
  return class CountingWebSocket extends WebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      let open = false;
      this.addEventListener('open', () => {
        open = true;
        metrics.wsOpened();
      });
      this.addEventListener('close', () => {
        if (open) metrics.wsClosed();
        open = false;
      });
      this.addEventListener('message', (ev: MessageEvent) => {
        const f = frameEvent(ev.data);
        metrics.wsFrame('in', f.event, f.bytes);
      });
    }

    override send(data: string | Blob | BufferSource): void {
      const f = frameEvent(data);
      metrics.wsFrame('out', f.event, f.bytes);
      super.send(data);
    }
  };
}
