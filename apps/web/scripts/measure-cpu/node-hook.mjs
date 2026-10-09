// Preloaded into `next start` by the CPU measurement (T-033, runtime.ts NodeRuntime):
// `NODE_OPTIONS=--import …/node-hook.mjs CPU_PROBE_PORT=…`. For each request carrying an
// `x-cpu-probe: <id>` header it reads the main thread's CPU time (`process.threadCpuUsage`)
// when the request arrives and when the response finishes, then keeps sampling every 50 ms
// until the thread has been quiet for 100 ms, to also count work after the response (`after()`,
// the cache write); `x-cpu-probe-hold: <ms>` keeps it sampling at least that long. `GET /settle/<id>` on CPU_PROBE_PORT answers with both numbers once that
// is known (the client asks a moment later, so its own request is not counted).
import http from 'node:http';

const port = Number(process.env.CPU_PROBE_PORT);
const probes = new Map();
const cpuMs = () => {
  const u = process.threadCpuUsage();
  return (u.user + u.system) / 1000;
};

function track(rec) {
  let last = cpuMs();
  rec.finish = last;
  rec.settled = last;
  let quietTicks = 0;
  const started = Date.now();
  const holdUntil = started + rec.holdMs;
  const timer = setInterval(() => {
    const now = cpuMs();
    // A 50 ms window with less than 0.3 ms of CPU is quiet (a tick itself costs microseconds).
    if (now - last > 0.3) {
      quietTicks = 0;
      rec.settled = now;
    } else {
      quietTicks++;
    }
    last = now;
    const quiet = quietTicks >= 2 && Date.now() >= holdUntil;
    if (quiet || Date.now() - started > 5000 + rec.holdMs) {
      clearInterval(timer);
      rec.done = true;
      for (const waiter of rec.waiters) waiter();
    }
  }, 50);
}

const emit = http.Server.prototype.emit;
http.Server.prototype.emit = function (event, req, res) {
  if (event === 'request' && req && typeof req.headers['x-cpu-probe'] === 'string') {
    const holdMs = Number(req.headers['x-cpu-probe-hold'] ?? 0) || 0;
    const rec = { start: cpuMs(), finish: null, settled: null, done: false, waiters: [], holdMs };
    probes.set(req.headers['x-cpu-probe'], rec);
    res.once('finish', () => track(rec));
  }
  return emit.apply(this, arguments);
};

if (port && !globalThis.__cpuProbeServer) {
  globalThis.__cpuProbeServer = true;
  const server = http.createServer((req, res) => {
    if (req.url === '/ping') return void res.end('ok');
    const id = /^\/settle\/(.+)$/.exec(req.url ?? '')?.[1];
    const rec = id ? probes.get(id) : undefined;
    if (!rec) {
      res.statusCode = 404;
      return void res.end();
    }
    const answer = () => {
      probes.delete(id);
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          toFinishMs: rec.finish - rec.start,
          settledMs: rec.settled - rec.start,
        }),
      );
    };
    if (rec.done) answer();
    else rec.waiters.push(answer);
  });
  server.on('error', () => undefined);
  server.listen(port, '127.0.0.1');
  server.unref();
}
