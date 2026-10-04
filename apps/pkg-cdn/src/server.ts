/**
 * HTTP layer (node:http). Routes:
 *
 *   GET /health                         JSON health + metrics (queues, in-flight work, cache)
 *   GET /<name>@<exact>[/sub][?...]     bundled ES module (or a raw file for .css, fonts, ...)
 *   GET /<name>[@<range|tag>][/sub]     302 to the exact-version URL (query preserved)
 *
 * Every request gets an AbortSignal that fires when the client disconnects or the request
 * deadline passes; queued and shared work for it is cancelled (see ./limiter.ts). Overload
 * is answered with 503 + Retry-After.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { PackageCdn, rawContentType, type PackageCdnOptions } from './cdn';
import type { CdnConfig } from './config';
import { CdnError, errorMessage } from './errors';
import { packagePath, parseCdnUrl } from './url';

const IMMUTABLE = 'public, max-age=31536000, immutable';
const REDIRECT_CACHE = 'public, max-age=300';

const BASE_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'X-Content-Type-Options': 'nosniff',
};

export type Logger = (line: string) => void;

function noLog(): void {
  // Logging is opt-in.
}

export interface HandlerOptions {
  log?: Logger;
}

export interface RequestStats {
  /** Requests being handled now. */
  active: number;
  total: number;
  /** Responses by status code. */
  byStatus: Record<string, number>;
  /** 503 load-shedding responses. */
  shed: number;
  /** Requests that hit the request deadline (504). */
  timedOut: number;
  /** Requests whose client went away before the response. */
  clientClosed: number;
}

export function createCdnHandler(cdn: PackageCdn, opts: HandlerOptions = {}) {
  const log = opts.log ?? noLog;
  const started = Date.now();
  const requestTimeoutMs = cdn.config.requestTimeoutMs;
  const stats: RequestStats = {
    active: 0,
    total: 0,
    byStatus: {},
    shed: 0,
    timedOut: 0,
    clientClosed: 0,
  };

  function send(
    req: IncomingMessage,
    res: ServerResponse,
    status: number,
    headers: Record<string, string>,
    body?: string | Buffer,
  ): void {
    res.writeHead(status, { ...BASE_HEADERS, ...headers });
    if (req.method === 'HEAD' || body === undefined) res.end();
    else res.end(body);
  }

  function sendError(req: IncomingMessage, res: ServerResponse, e: unknown): number {
    const err =
      e instanceof CdnError
        ? e
        : new CdnError(500, 'build-failed', `internal error: ${errorMessage(e)}`);
    const headers: Record<string, string> = {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Pkg-Cdn-Error': err.code,
    };
    if (err.retryAfterSeconds !== undefined) {
      headers['Retry-After'] = Math.ceil(err.retryAfterSeconds).toString();
    }
    send(req, res, err.status, headers, `pkg-cdn: ${err.message}\n`);
    return err.status;
  }

  function metrics() {
    return {
      ok: true,
      uptimeSeconds: Math.round((Date.now() - started) / 1000),
      requests: stats,
      ...cdn.metrics(),
    };
  }

  async function route(
    req: IncomingMessage,
    res: ServerResponse,
    signal: AbortSignal,
  ): Promise<string> {
    // Parse the raw request target ourselves: WHATWG URL parsing would silently resolve
    // `..` segments, and a request for `/x@1.0.0/../../y` must be rejected, not rewritten.
    const target = req.url ?? '/';
    const q = target.indexOf('?');
    const url = {
      pathname: q === -1 ? target : target.slice(0, q),
      search: q === -1 ? '' : target.slice(q),
    };
    if (req.method === 'OPTIONS') {
      send(req, res, 204, {
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Max-Age': '86400',
      });
      return '';
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(
        req,
        res,
        405,
        { 'Content-Type': 'text/plain', Allow: 'GET, HEAD, OPTIONS' },
        'pkg-cdn: method not allowed\n',
      );
      return '';
    }
    if (url.pathname === '/') {
      send(
        req,
        res,
        200,
        { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
        'Build Roulette package CDN (esm.sh-compatible). GET /<name>@<version>[/<subpath>]?external=react,react-dom\n',
      );
      return '';
    }
    // `/health`, not `/metrics`: "metrics" is a real npm package name ("health" is too, but
    // this route predates the metrics).
    if (url.pathname === '/health') {
      send(
        req,
        res,
        200,
        { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        JSON.stringify(metrics()),
      );
      return '';
    }

    const parsed = parseCdnUrl(url.pathname, url.search);
    const resolved = await cdn.resolve(parsed, signal);
    if (!resolved.exact) {
      const location = packagePath(parsed.name, resolved.version, parsed.subpath) + url.search;
      send(
        req,
        res,
        302,
        { Location: location, 'Cache-Control': REDIRECT_CACHE, 'Content-Type': 'text/plain' },
        `redirecting to ${location}\n`,
      );
      return '';
    }

    const asModule = parsed.query.module || parsed.query.external.length > 0;
    const rawType = rawContentType(parsed.subpath, asModule);
    if (rawType !== null) {
      const file = await cdn.rawFile(resolved.meta, parsed.subpath, signal);
      try {
        res.writeHead(200, {
          ...BASE_HEADERS,
          'Content-Type': rawType,
          'Content-Length': file.size.toString(),
          'Cache-Control': IMMUTABLE,
          // Raw files are data; if one is opened directly it must not run anything.
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        });
        if (req.method === 'HEAD') res.end();
        else await pipeline(file.handle.createReadStream({ autoClose: false }), res);
      } finally {
        await file.handle.close();
      }
      return 'raw';
    }

    const t0 = performance.now();
    const out = await cdn.bundle(
      {
        name: resolved.name,
        version: resolved.version,
        subpath: parsed.subpath,
        external: parsed.query.external,
        deps: parsed.query.deps,
        target: parsed.query.target,
        dev: parsed.query.dev,
      },
      resolved.meta,
      signal,
    );
    const headers: Record<string, string> = {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': IMMUTABLE,
      'X-Cache': out.cache === 'hit' ? 'HIT' : 'MISS',
      'Server-Timing': `bundle;dur=${(performance.now() - t0).toFixed(1)}`,
    };
    if (out.meta.stubbedBuiltins.length > 0) {
      headers['X-Pkg-Cdn-Stubbed-Builtins'] = out.meta.stubbedBuiltins.join(',');
    }
    send(req, res, 200, headers, out.code);
    return out.cache;
  }

  const handle = async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const t0 = performance.now();
    stats.active++;
    stats.total++;
    // One signal per request: the deadline, or the client going away first.
    const controller = new AbortController();
    const timer = setTimeout(() => {
      stats.timedOut++;
      controller.abort(
        new CdnError(504, 'timeout', `request took longer than ${requestTimeoutMs.toString()} ms`),
      );
    }, requestTimeoutMs);
    const onClose = () => {
      if (!res.writableFinished && !controller.signal.aborted) {
        stats.clientClosed++;
        controller.abort(new CdnError(499, 'cancelled', 'the client closed the connection'));
      }
    };
    res.on('close', onClose);
    let status = 500;
    let note = '';
    try {
      note = await route(req, res, controller.signal);
      status = res.statusCode;
    } catch (e) {
      if (res.headersSent || res.destroyed) {
        res.destroy();
        status = e instanceof CdnError ? e.status : 500;
        note = e instanceof CdnError ? e.code : 'internal';
      } else {
        status = sendError(req, res, e);
        note = e instanceof CdnError ? e.code : 'internal';
      }
    } finally {
      clearTimeout(timer);
      res.off('close', onClose);
      stats.active--;
    }
    const key = status.toString();
    stats.byStatus[key] = (stats.byStatus[key] ?? 0) + 1;
    if (status === 503) stats.shed++;
    log(
      `${req.method ?? '?'} ${req.url ?? ''} ${key} ${(performance.now() - t0).toFixed(0)}ms${note ? ` ${note}` : ''}`,
    );
  };
  return Object.assign(handle, { stats, metrics });
}

export interface CdnServer {
  url: string;
  server: Server;
  cdn: PackageCdn;
  close(): Promise<void>;
}

export async function startCdnServer(
  config: CdnConfig,
  opts: PackageCdnOptions & HandlerOptions = {},
): Promise<CdnServer> {
  const cdn = new PackageCdn(config, opts);
  await cdn.init();
  const handle = createCdnHandler(cdn, opts);
  const server = createServer((req, res) => {
    void handle(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      resolve();
    });
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : config.port;
  const host = config.host.includes(':') ? `[${config.host}]` : config.host;
  return {
    url: `http://${host}:${port.toString()}`,
    server,
    cdn,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      });
      await cdn.close();
    },
  };
}
