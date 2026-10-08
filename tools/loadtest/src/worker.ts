/**
 * A generator process: runs its share of the rooms (forked by main.ts, one event loop per
 * process) and sends its raw metrics back over IPC.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { LoadConfig } from './config';
import { openDb } from './db';
import type { StackEnv } from './env';
import { countingWebSocket, instrumentedFetch } from './instrument';
import { Metrics, type RawMetrics } from './metrics';
import { sleep } from './player';
import { Rng } from './rng';
import { runRoom } from './room';

export interface ShardTask {
  cfg: LoadConfig;
  env: StackEnv;
  runId: string;
  proc: number;
  rooms: number[];
  /** Epoch ms at which room 0 starts (rooms are spread over cfg.rampS from there). */
  t0: number;
}

export type ShardMessage =
  | { type: 'log'; msg: string }
  | { type: 'done'; metrics: RawMetrics }
  | { type: 'error'; error: string };

export async function runShard(task: ShardTask, log: (msg: string) => void): Promise<RawMetrics> {
  const { cfg, env } = task;
  const metrics = new Metrics(task.proc);
  const db = openDb(env.DB_URL, 2);
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  const ticker = setInterval(() => {
    metrics.tick();
  }, 5000);
  const client = {
    apiUrl: env.API_URL,
    anonKey: env.ANON_KEY,
    serviceKey: env.SERVICE_ROLE_KEY,
    metrics,
    fetch: instrumentedFetch(metrics, cfg.requestTimeoutMs),
    WebSocket: countingWebSocket(metrics),
    auth: cfg.auth,
    runId: task.runId,
  };
  const rng = new Rng(cfg.seed);
  try {
    await Promise.all(
      task.rooms.map(async (i) => {
        const startAt = task.t0 + (cfg.rooms > 1 ? (i * cfg.rampS * 1000) / cfg.rooms : 0);
        await sleep(startAt - Date.now());
        const deadline = new Promise<void>((resolve) =>
          setTimeout(() => {
            metrics.count('room_timeout');
            log(`room ${String(i)}: room timeout after ${String(cfg.roomTimeoutS)} s`);
            resolve();
          }, cfg.roomTimeoutS * 1000).unref(),
        );
        await Promise.race([runRoom({ cfg, client, metrics, db, rng, log }, i), deadline]);
      }),
    );
  } finally {
    clearInterval(ticker);
    loop.disable();
    metrics.raw.eventLoopDelayMs = {
      p50: Math.round(loop.percentile(50) / 1e4) / 100,
      p99: Math.round(loop.percentile(99) / 1e4) / 100,
      max: Math.round(loop.max / 1e4) / 100,
    };
    await db.end();
  }
  return metrics.finish();
}

// Forked by main.ts: one task in, one message with the metrics out.
if (process.send) {
  const send = (m: ShardMessage) =>
    new Promise<void>((resolve) => {
      process.send?.(m, undefined, {}, () => {
        resolve();
      });
    });
  process.once('message', (task: ShardTask) => {
    const log = (msg: string) => void send({ type: 'log', msg: `[p${String(task.proc)}] ${msg}` });
    runShard(task, log).then(
      async (metrics) => {
        await send({ type: 'done', metrics });
        process.exit(0);
      },
      async (e: unknown) => {
        await send({
          type: 'error',
          error: e instanceof Error ? (e.stack ?? e.message) : String(e),
        });
        process.exit(1);
      },
    );
  });
}
