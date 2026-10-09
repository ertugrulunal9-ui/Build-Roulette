/**
 * Checks the measurement method on a Worker whose work is known (T-033): a plain loop of a
 * given length, a request that only waits on a slow upstream, and an empty one. The same
 * harness as the app (wrangler dev, the inspector proxy, the profile estimate, schedstat).
 *
 * - The loop: the isolate CPU from the profile should match the workerd thread's CPU (the
 *   loop is all the thread does), minus the small fixed cost of the request itself.
 * - The wait: 300 ms of wall time, ~0 CPU: the profile must not count waiting.
 * - The empty request: the floor of the thread measurement (routing in the local runtime).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fmt, stats } from './profile';
import { WorkersRuntime } from './runtime';

export interface CalibrationRow {
  workload: string;
  threadMs: number;
  isolateMs: number;
  wallMs: number;
  n: number;
}

export async function calibrate(dir: string, samplingUs: number): Promise<CalibrationRow[]> {
  const upstream = createServer((_req, res) => {
    setTimeout(() => res.end('slow'), 300);
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = (upstream.address() as AddressInfo).port;
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    `${dir}/worker.js`,
    `export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/busy') {
      const n = Number(url.searchParams.get('n'));
      let x = 0;
      for (let i = 0; i < n; i++) x += Math.sqrt(i) * Math.sin(i);
      return new Response(String(x));
    }
    if (url.pathname === '/wait') {
      return new Response(await (await fetch('http://127.0.0.1:${String(upstreamPort)}/')).text());
    }
    return new Response('ok');
  },
};
`,
  );
  writeFileSync(
    `${dir}/wrangler.jsonc`,
    JSON.stringify({ name: 'cpu-calibration', main: 'worker.js', compatibility_date: '2026-10-01' }),
  );
  const rt = new WorkersRuntime({
    port: 8798,
    inspectorPort: 9298,
    samplingUs,
    logFile: `${dir}/wrangler.log`,
    config: `${dir}/wrangler.jsonc`,
  });
  const rows: CalibrationRow[] = [];
  try {
    await rt.start();
    const workloads: [string, string][] = [
      ['empty request', '/'],
      ['wait 300 ms on a fetch', '/wait'],
      ['loop 2·10⁵', '/busy?n=200000'],
      ['loop 10⁶', '/busy?n=1000000'],
      ['loop 4·10⁶', '/busy?n=4000000'],
    ];
    for (const [workload, path] of workloads) {
      for (let i = 0; i < 3; i++) await rt.request({ path });
      const thread: number[] = [];
      const isolate: number[] = [];
      const wall: number[] = [];
      for (let i = 0; i < 16; i++) {
        const profiled = i % 2 === 1;
        const m = await rt.measure({ path }, profiled);
        if (profiled && m.isolate) isolate.push(m.isolate.cpuMs);
        else thread.push(m.threadMs);
        wall.push(m.wallMs);
      }
      rows.push({
        workload,
        threadMs: stats(thread).median,
        isolateMs: stats(isolate).median,
        wallMs: stats(wall).median,
        n: thread.length,
      });
    }
  } finally {
    await rt.stop();
    upstream.close();
  }
  return rows;
}

export function calibrationTable(rows: CalibrationRow[]): string {
  return [
    '| Workload | workerd thread, unprofiled (median) | isolate CPU from the profile (median) | wall (median) |',
    '|---|---|---|---|',
    ...rows.map(
      (r) => `| ${r.workload} | ${fmt(r.threadMs)} ms | ${fmt(r.isolateMs)} ms | ${fmt(r.wallMs)} ms |`,
    ),
  ].join('\n');
}
