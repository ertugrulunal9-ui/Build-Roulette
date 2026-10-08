/**
 * A local stand-in for Sentry's and PostHog's ingest endpoints, for tests (Node only).
 * It accepts anything (with CORS, so a browser page can post to it), records every request,
 * and decodes the two payloads we send:
 *
 * - Sentry: `POST /api/{project}/envelope/` (a newline-delimited envelope: header, then item
 *   header + payload pairs); the `event` items are collected in `sentryEvents`.
 * - PostHog: `POST /batch/` (`{api_key, batch: [...]}`), or `/i/v0/e/` / `/capture/` with one
 *   event; the events are collected in `posthogEvents`.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { gunzipSync } from 'node:zlib';

export interface IngestRequest {
  method: string;
  /** Path and query, as received. */
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface FakeIngest {
  /** `http://127.0.0.1:{port}` */
  origin: string;
  port: number;
  requests: IngestRequest[];
  sentryEvents: Record<string, unknown>[];
  posthogEvents: Record<string, unknown>[];
  /** A Sentry DSN pointing here (`http://public@127.0.0.1:{port}/{project}`). */
  dsn(project?: number): string;
  reset(): void;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let buf = Buffer.concat(chunks);
      if (req.headers['content-encoding'] === 'gzip') buf = gunzipSync(buf);
      resolve(buf.toString('utf8'));
    });
    req.on('error', reject);
  });
}

/** The `event` items of a Sentry envelope. */
export function parseEnvelope(body: string): Record<string, unknown>[] {
  const lines = body.split('\n').filter((l) => l.trim() !== '');
  const events: Record<string, unknown>[] = [];
  // lines[0] is the envelope header; then item header / payload pairs.
  for (let i = 1; i + 1 < lines.length; i += 2) {
    const header = JSON.parse(lines[i] ?? '{}') as { type?: string };
    if (header.type === 'event') {
      events.push(JSON.parse(lines[i + 1] ?? '{}') as Record<string, unknown>);
    }
  }
  return events;
}

export async function startFakeIngest(port = 0): Promise<FakeIngest> {
  const requests: IngestRequest[] = [];
  const sentryEvents: Record<string, unknown>[] = [];
  const posthogEvents: Record<string, unknown>[] = [];
  const server: Server = createServer((req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': req.headers.origin ?? '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] ?? '*',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors).end();
      return;
    }
    void readBody(req).then(
      (body) => {
        const url = req.url ?? '/';
        requests.push({ method: req.method ?? 'GET', url, headers: req.headers, body });
        try {
          if (/^\/api\/\d+\/envelope\/?/.test(url)) sentryEvents.push(...parseEnvelope(body));
          else if (url.startsWith('/batch')) {
            const json = JSON.parse(body) as { batch?: Record<string, unknown>[] };
            posthogEvents.push(...(json.batch ?? []));
          } else if (url.startsWith('/i/v0/e') || url.startsWith('/capture')) {
            posthogEvents.push(JSON.parse(body) as Record<string, unknown>);
          }
        } catch {
          // Recorded in `requests` anyway.
        }
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }).end('{"status":1}');
      },
      () => {
        res.writeHead(400, cors).end();
      },
    );
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const addr = server.address();
  const actual = typeof addr === 'object' && addr ? addr.port : port;
  const origin = `http://127.0.0.1:${String(actual)}`;
  return {
    origin,
    port: actual,
    requests,
    sentryEvents,
    posthogEvents,
    dsn: (project = 1) => `http://public@127.0.0.1:${String(actual)}/${String(project)}`,
    reset() {
      requests.length = 0;
      sentryEvents.length = 0;
      posthogEvents.length = 0;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
