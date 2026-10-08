/**
 * Merges the generator processes' raw metrics with the database's event timestamps and the
 * samplers, and writes report.json (everything, for cost.ts) and report.md (for people).
 */
import type { LoadConfig } from './config';
import type { DbSample, StatementRow } from './db';
import type { DockerSample } from './docker';
import { isBillable, type BattleRecord, type HttpClassStats, type RawMetrics } from './metrics';
import type { CaptureLog } from './services';
import { bump, mergeCounts, roundSummary, sortedEntries, summarize, type Summary } from './stats';
import type { TenantLimits } from './realtime-tenant';

export interface EventTime {
  key: string;
  version: number;
  type: string;
  detail: string | null;
  /** 'server' (sweep_deadlines, workers: no actor) or 'client' (an RPC). */
  source: string;
  ms: number;
}

export interface RunInputs {
  runId: string;
  cfg: LoadConfig;
  startedAt: number;
  endedAt: number;
  shards: RawMetrics[];
  events: EventTime[];
  dbSamples: DbSample[];
  docker: DockerSample[];
  dockerAvailable: boolean;
  capture: CaptureLog | null;
  captureOutcomes: { status: Record<string, number>; latencyMs: number[] } | null;
  rowsPerBattle: Record<string, number>;
  screenshotBytes: number;
  dbSizeBytes: { before: number; after: number };
  statements: StatementRow[];
  statementsReset: boolean;
  realtimeLimits: { before: TenantLimits | null; applied: TenantLimits | null };
  host: { cpus: number; memGiB: number; node: string; loadAvg: number[][]; cpuBusyPct: number[] };
  notes: string[];
}

export interface Report {
  meta: {
    runId: string;
    profile: string;
    config: LoadConfig;
    startedAt: string;
    endedAt: string;
    durationS: number;
    host: RunInputs['host'];
    realtimeLimits: RunInputs['realtimeLimits'];
    notes: string[];
  };
  clients: { created: number; peakWs: number; peakClients: number; clientMinutes: number };
  battles: {
    started: number;
    byOutcome: Record<string, number>;
    durationS: Summary;
    drawnBuildS: Record<string, number>;
    plans: Record<string, number>;
    finalBuilds: Summary;
    playerBattles: number;
  };
  propagation: {
    clockOffsetMs: Summary;
    battlePhaseMs: Summary;
    /** Battle phase events by who caused them: the sweep (one transaction for many battles) or an RPC. */
    battlePhaseBySource: Record<string, Summary>;
    battleAllMs: Summary;
    roomAllMs: Summary;
    byType: Record<string, Summary>;
    unmatchedReceipts: number;
    deliveries: { events: number; expected: number; received: number; ratio: number };
    verdict: { metric: string; p95Ms: number; thresholdMs: number; met: boolean };
  };
  http: Record<
    string,
    {
      n: number;
      p50: number;
      p95: number;
      p99: number;
      max: number;
      status: Record<string, number>;
      bytesUp: number;
      bytesDown: number;
    }
  >;
  errors: { byCode: Record<string, number>; byCall: Record<string, number> };
  realtime: {
    wsOpened: number;
    wsClosed: number;
    peakConcurrentWs: number;
    framesIn: Record<string, number>;
    framesOut: Record<string, number>;
    bytesIn: number;
    bytesOut: number;
    broadcastReceipts: number;
    billableIn: number;
    billableOut: number;
    billablePerSec: Summary;
    presence: { sent: number; deferred: number; failed: number };
    channelStatus: Record<string, number>;
  };
  storage: {
    bytes: Record<string, number>;
    counts: Record<string, number>;
    perBattle: { up: Summary; down: Summary; upCount: Summary; downCount: Summary };
    screenshotBytesPerBattle: number;
  };
  capture: {
    enabled: boolean;
    jobs: Record<string, number>;
    jobMs: Record<string, Summary>;
    renderMs: Summary;
    readyReasons: Record<string, number>;
    screenshotBytes: Summary;
    outcomes: Record<string, number>;
    shipToCaptureMs: Summary;
    throughputPerMin: number;
    backlog: { t: number; queued: number; running: number }[];
    maxBacklog: number;
    workerErrors: Record<string, number>;
  };
  db: {
    maxActive: number;
    maxWaitingLocks: number;
    commitsPerSec: Summary;
    deadlocks: number;
    rowsPerBattle: Record<string, number>;
    sizeBytes: { before: number; after: number };
    statements: StatementRow[];
    statementsReset: boolean;
    samples: DbSample[];
  };
  docker: {
    available: boolean;
    containers: Record<string, { meanCpu: number; maxCpu: number; maxMemMiB: number }>;
    samples: number;
  };
  generator: {
    procs: number;
    eventLoopDelayMs: RawMetrics['eventLoopDelayMs'][];
    /** Mean cores used by all generator processes over the run. */
    cores: number;
  };
  timeseries: { t: number; ws: number; inflight: number; reqsPerSec: number; clients: number }[];
  sim: Record<string, number>;
  rates: {
    /** Per client-minute: calls driven by the clock (heartbeat, version check, clock sync). */
    perClientMinute: Record<string, number>;
    /** Per battle (event-driven calls), from the compressed run. */
    perBattle: Record<string, number>;
  };
}

/** RPCs whose count grows with time online rather than with battle events. */
export const RATE_DRIVEN = new Set(['rpc:heartbeat', 'rest:battles', 'rpc:server_now']);

function mergeHttp(shards: RawMetrics[]): Record<string, HttpClassStats> {
  const out: Record<string, HttpClassStats> = {};
  for (const s of shards) {
    for (const [k, v] of Object.entries(s.http)) {
      const o = (out[k] ??= { lat: [], status: {}, bytesUp: 0, bytesDown: 0 });
      for (const x of v.lat) o.lat.push(x);
      for (const [st, n] of Object.entries(v.status)) bump(o.status, st, n);
      o.bytesUp += v.bytesUp;
      o.bytesDown += v.bytesDown;
    }
  }
  return out;
}

export function buildReport(inp: RunInputs): Report {
  const { shards, cfg } = inp;
  const battles: BattleRecord[] = shards.flatMap((s) => s.battles);
  const http = mergeHttp(shards);
  const sim = mergeCounts(shards.map((s) => s.sim));

  // ── Propagation: receipts joined with battle_events / room_events created_at ──
  const evIndex = new Map<string, EventTime>();
  for (const e of inp.events) evIndex.set(`${e.key}#${String(e.version)}`, e);
  const phase: number[] = [];
  const phaseBySource: Record<string, number[]> = {};
  const battleAll: number[] = [];
  const roomAll: number[] = [];
  const byType: Record<string, number[]> = {};
  const perEvent = new Map<string, number>();
  let unmatched = 0;
  let receiptsTotal = 0;
  for (const s of shards) {
    for (const [key, version, at] of s.receipts) {
      receiptsTotal++;
      const id = `${key}#${String(version)}`;
      const ev = evIndex.get(id);
      if (!ev) {
        unmatched++;
        continue;
      }
      perEvent.set(id, (perEvent.get(id) ?? 0) + 1);
      const d = at - ev.ms;
      const t =
        ev.type === 'phase'
          ? `phase ${ev.detail ?? ''}`
          : `${key.startsWith('b') ? 'battle' : 'room'} ${ev.type}`;
      (byType[t] ??= []).push(d);
      if (key.startsWith('b:')) {
        battleAll.push(d);
        if (ev.type === 'phase') {
          phase.push(d);
          (phaseBySource[ev.source] ??= []).push(d);
        }
      } else {
        roomAll.push(d);
      }
    }
  }
  // Delivery: battle events from version 3 on (every client is subscribed by then) should
  // reach every player of the battle.
  const playersOf = new Map(battles.map((b) => [b.battleId, b.players]));
  let expected = 0;
  let received = 0;
  let events = 0;
  for (const e of inp.events) {
    if (!e.key.startsWith('b:') || e.version < 3) continue;
    const players = playersOf.get(e.key.slice(2));
    if (!players) continue;
    events++;
    expected += players;
    received += Math.min(players, perEvent.get(`${e.key}#${String(e.version)}`) ?? 0);
  }
  const phaseSummary = roundSummary(summarize(phase));

  // ── Realtime ──
  const framesIn = mergeCounts(shards.map((s) => s.ws.framesIn));
  const framesOut = mergeCounts(shards.map((s) => s.ws.framesOut));
  const perSec = mergeCounts(shards.map((s) => s.ws.billableInPerSec));
  const billableIn = Object.entries(framesIn)
    .filter(([k]) => isBillable(k))
    .reduce((a, [, n]) => a + n, 0);
  const billableOut = Object.entries(framesOut)
    .filter(([k]) => isBillable(k))
    .reduce((a, [, n]) => a + n, 0);

  // ── Storage ──
  const byBattle = shards.flatMap((s) => Object.values(s.storageByBattle));
  const nBattles = Math.max(1, battles.length);

  // ── Capture ──
  const cap = inp.capture;
  const capJobs: Record<string, number> = {};
  const capJobMs: Record<string, number[]> = {};
  for (const j of cap?.jobs ?? []) {
    bump(capJobs, `${j.kind}:${j.result}`);
    (capJobMs[j.kind] ??= []).push(j.ms);
  }
  const captures = (cap?.jobs ?? []).filter((j) => j.kind === 'capture');
  const capSpanMin =
    captures.length > 1
      ? (Math.max(...captures.map((j) => j.t)) - Math.min(...captures.map((j) => j.t))) / 60000
      : 0;
  const backlog = inp.dbSamples.map((d) => ({
    t: d.t,
    queued: d.jobs['capture:queued'] ?? 0,
    running: d.jobs['capture:running'] ?? 0,
  }));

  // ── DB ──
  const commits: number[] = [];
  for (let i = 1; i < inp.dbSamples.length; i++) {
    const a = inp.dbSamples[i - 1];
    const b = inp.dbSamples[i];
    if (!a || !b) continue;
    commits.push(((b.xactCommit - a.xactCommit) * 1000) / Math.max(1, b.t - a.t));
  }
  const active = inp.dbSamples.map((d) =>
    Object.entries(d.activity)
      .filter(([k]) => k.startsWith('active'))
      .reduce((a, [, n]) => a + n, 0),
  );

  // ── Docker ──
  const containers: Report['docker']['containers'] = {};
  const cpuSamples: Record<string, number[]> = {};
  const memMax: Record<string, number> = {};
  for (const s of inp.docker) {
    for (const [name, c] of Object.entries(s.containers)) {
      (cpuSamples[name] ??= []).push(c.cpu);
      memMax[name] = Math.max(memMax[name] ?? 0, c.memMiB);
    }
  }
  for (const [name, xs] of Object.entries(cpuSamples)) {
    containers[name] = {
      meanCpu: Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10,
      maxCpu: Math.round(Math.max(...xs) * 10) / 10,
      maxMemMiB: memMax[name] ?? 0,
    };
  }

  // ── Rates ──
  const clientMinutes = shards.reduce((a, s) => a + s.clients.clientMs, 0) / 60000;
  const perClientMinute: Record<string, number> = {};
  const perBattle: Record<string, number> = {};
  for (const [k, v] of Object.entries(http)) {
    const n = v.lat.length;
    if (RATE_DRIVEN.has(k))
      perClientMinute[k] = Math.round((n / Math.max(1e-9, clientMinutes)) * 1000) / 1000;
    else perBattle[k] = Math.round((n / nBattles) * 10) / 10;
  }
  perClientMinute['presence_sent'] =
    Math.round(
      (shards.reduce((a, s) => a + s.presence.sent, 0) / Math.max(1e-9, clientMinutes)) * 1000,
    ) / 1000;

  // Time series (merged by 5 s bucket).
  const ts = new Map<
    number,
    { t: number; ws: number; inflight: number; reqsPerSec: number; clients: number }
  >();
  for (const s of shards) {
    for (const p of s.timeseries) {
      const k = Math.round(p.t / 5000) * 5000;
      const o = ts.get(k) ?? { t: k, ws: 0, inflight: 0, reqsPerSec: 0, clients: 0 };
      o.ws += p.ws;
      o.inflight += p.inflight;
      o.reqsPerSec += p.reqs / 5;
      o.clients += p.clients;
      ts.set(k, o);
    }
  }

  const byOutcome: Record<string, number> = {};
  for (const b of battles) bump(byOutcome, b.outcome);
  const drawn: Record<string, number> = {};
  for (const b of battles) bump(drawn, String(b.drawnBuildS));

  return {
    meta: {
      runId: inp.runId,
      profile: cfg.profile,
      config: cfg,
      startedAt: new Date(inp.startedAt).toISOString(),
      endedAt: new Date(inp.endedAt).toISOString(),
      durationS: Math.round((inp.endedAt - inp.startedAt) / 1000),
      host: inp.host,
      realtimeLimits: inp.realtimeLimits,
      notes: inp.notes,
    },
    clients: {
      created: shards.reduce((a, s) => a + s.clients.created, 0),
      peakWs: shards.reduce((a, s) => a + s.ws.peakOpen, 0),
      peakClients: shards.reduce((a, s) => a + s.clients.peak, 0),
      clientMinutes: Math.round(clientMinutes * 10) / 10,
    },
    battles: {
      started: battles.length,
      byOutcome,
      durationS: roundSummary(
        summarize(
          battles
            .filter((b) => b.endedAt)
            .map((b) => ((b.endedAt ?? b.startedAt) - b.startedAt) / 1000),
        ),
      ),
      drawnBuildS: drawn,
      plans: mergeCounts(battles.map((b) => b.plans)),
      finalBuilds: roundSummary(summarize(battles.map((b) => b.finalBuilds))),
      playerBattles: battles.reduce((a, b) => a + b.players, 0),
    },
    propagation: {
      clockOffsetMs: roundSummary(summarize(shards.flatMap((s) => s.clockOffsetMs)), 2),
      battlePhaseMs: phaseSummary,
      battlePhaseBySource: Object.fromEntries(
        sortedEntries(phaseBySource).map(([k, v]) => [k, roundSummary(summarize(v))]),
      ),
      battleAllMs: roundSummary(summarize(battleAll)),
      roomAllMs: roundSummary(summarize(roomAll)),
      byType: Object.fromEntries(
        sortedEntries(byType).map(([k, v]) => [k, roundSummary(summarize(v))]),
      ),
      unmatchedReceipts: unmatched,
      deliveries: {
        events,
        expected,
        received,
        ratio: expected ? Math.round((received / expected) * 10000) / 10000 : 1,
      },
      verdict: {
        metric:
          'p95 of battle phase-change propagation (battle_events.created_at → client receipt)',
        p95Ms: phaseSummary.p95,
        thresholdMs: 1000,
        met: phaseSummary.n > 0 && phaseSummary.p95 < 1000,
      },
    },
    http: Object.fromEntries(
      sortedEntries(http).map(([k, v]) => {
        const s = summarize(v.lat);
        return [
          k,
          {
            n: s.n,
            p50: Math.round(s.p50 * 10) / 10,
            p95: Math.round(s.p95 * 10) / 10,
            p99: Math.round(s.p99 * 10) / 10,
            max: Math.round(s.max * 10) / 10,
            status: v.status,
            bytesUp: v.bytesUp,
            bytesDown: v.bytesDown,
          },
        ];
      }),
    ),
    errors: {
      byCode: mergeCounts(shards.map((s) => s.errors)),
      byCall: mergeCounts(shards.map((s) => s.rpcErrors)),
    },
    realtime: {
      wsOpened: shards.reduce((a, s) => a + s.ws.opened, 0),
      wsClosed: shards.reduce((a, s) => a + s.ws.closed, 0),
      peakConcurrentWs: shards.reduce((a, s) => a + s.ws.peakOpen, 0),
      framesIn,
      framesOut,
      bytesIn: shards.reduce((a, s) => a + s.ws.bytesIn, 0),
      bytesOut: shards.reduce((a, s) => a + s.ws.bytesOut, 0),
      broadcastReceipts: receiptsTotal,
      billableIn,
      billableOut,
      billablePerSec: roundSummary(summarize(Object.values(perSec))),
      presence: {
        sent: shards.reduce((a, s) => a + s.presence.sent, 0),
        deferred: shards.reduce((a, s) => a + s.presence.deferred, 0),
        failed: shards.reduce((a, s) => a + s.presence.failed, 0),
      },
      channelStatus: mergeCounts(shards.map((s) => s.channel)),
    },
    storage: {
      bytes: mergeCounts(shards.map((s) => s.storageBytes)),
      counts: mergeCounts(shards.map((s) => s.storageCount)),
      perBattle: {
        up: roundSummary(summarize(byBattle.map((b) => b.up)), 0),
        down: roundSummary(summarize(byBattle.map((b) => b.down)), 0),
        upCount: roundSummary(summarize(byBattle.map((b) => b.upCount))),
        downCount: roundSummary(summarize(byBattle.map((b) => b.downCount))),
      },
      screenshotBytesPerBattle: Math.round(inp.screenshotBytes / nBattles),
    },
    capture: {
      enabled: cfg.capture,
      jobs: capJobs,
      jobMs: Object.fromEntries(
        Object.entries(capJobMs).map(([k, v]) => [k, roundSummary(summarize(v), 0)]),
      ),
      renderMs: roundSummary(summarize(cap?.renderMs ?? []), 0),
      readyReasons: cap?.readyReasons ?? {},
      screenshotBytes: roundSummary(summarize(cap?.screenshotBytes ?? []), 0),
      outcomes: inp.captureOutcomes?.status ?? {},
      shipToCaptureMs: roundSummary(summarize(inp.captureOutcomes?.latencyMs ?? []), 0),
      throughputPerMin: capSpanMin > 0 ? Math.round((captures.length / capSpanMin) * 10) / 10 : 0,
      backlog,
      maxBacklog: Math.max(0, ...backlog.map((b) => b.queued + b.running)),
      workerErrors: (cap?.errors ?? []).reduce<Record<string, number>>((a, e) => {
        bump(a, e);
        return a;
      }, {}),
    },
    db: {
      maxActive: Math.max(0, ...active),
      maxWaitingLocks: Math.max(0, ...inp.dbSamples.map((d) => d.waitingLocks)),
      commitsPerSec: roundSummary(summarize(commits)),
      deadlocks:
        inp.dbSamples.length > 1
          ? (inp.dbSamples[inp.dbSamples.length - 1]?.deadlocks ?? 0) -
            (inp.dbSamples[0]?.deadlocks ?? 0)
          : 0,
      rowsPerBattle: Object.fromEntries(
        Object.entries(inp.rowsPerBattle).map(([k, v]) => [
          k,
          Math.round((v / nBattles) * 10) / 10,
        ]),
      ),
      sizeBytes: inp.dbSizeBytes,
      statements: inp.statements,
      statementsReset: inp.statementsReset,
      samples: inp.dbSamples,
    },
    docker: { available: inp.dockerAvailable, containers, samples: inp.docker.length },
    generator: {
      procs: shards.length,
      eventLoopDelayMs: shards.map((s) => s.eventLoopDelayMs),
      cores:
        Math.round(
          (shards.reduce((a, s) => a + s.cpuMs, 0) / Math.max(1, inp.endedAt - inp.startedAt)) *
            100,
        ) / 100,
    },
    timeseries: [...ts.values()].sort((a, b) => a.t - b.t),
    sim,
    rates: { perClientMinute, perBattle },
  };
}

// ─── Markdown ─────────────────────────────────────────────────────────────────────────

const kb = (n: number) => `${(n / 1024).toFixed(1)} KiB`;
const mb = (n: number) => `${(n / 1048576).toFixed(2)} MiB`;
const f = (n: number, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : '–');

function sumRow(name: string, s: Summary, unit = 'ms'): string {
  return `| ${name} | ${String(s.n)} | ${f(s.p50)} | ${f(s.p95)} | ${f(s.p99)} | ${f(s.max)} | ${unit} |`;
}

export function renderMarkdown(r: Report): string {
  const L: string[] = [];
  const c = r.meta.config;
  L.push(`# Load test report: ${r.meta.profile} (${r.meta.runId})`, '');
  L.push(
    `${String(c.rooms)} rooms × ${String(c.players)} players × ${String(c.battlesPerRoom)} battle(s), ramp ${String(c.rampS)} s, ${String(c.procs)} generator process(es). ` +
      `Started ${r.meta.startedAt}, ${String(r.meta.durationS)} s. Host: ${String(r.meta.host.cpus)} CPUs, ${f(r.meta.host.memGiB)} GiB, Node ${r.meta.host.node}.`,
    '',
  );
  const v = r.propagation.verdict;
  L.push(
    `**M5 exit criterion (p95 phase-change propagation < 1 s): ${v.met ? 'MET' : 'NOT MET'}**: p95 = ${f(v.p95Ms)} ms over ${String(r.propagation.battlePhaseMs.n)} phase-event deliveries.`,
    '',
  );
  L.push('## Phases (compressed)', '');
  L.push(
    `BUILDING ${String(c.buildS)} s (drawn: ${JSON.stringify(r.battles.drawnBuildS)}), SPINNING ${String(c.spinningS)} s, SHIPPING ${String(c.shippingS)} s, REVEAL slot ${String(c.revealSlotS)} s, VOTING ${String(c.votingS)} s, RESULTS ${String(c.resultsS)} s, capture deadline ${String(c.captureDeadlineS)} s. Heartbeat ${String(c.heartbeatMs)} ms, autosave ${String(c.autosaveMs)} ms (not compressed).`,
    '',
  );
  L.push('## Battles', '');
  L.push(
    `Started ${String(r.battles.started)}, outcomes ${JSON.stringify(r.battles.byOutcome)}, plans ${JSON.stringify(r.battles.plans)}, final builds per battle p50 ${f(r.battles.finalBuilds.p50, 0)}. Duration (start → DESTROYED seen) p50 ${f(r.battles.durationS.p50)} s, max ${f(r.battles.durationS.max)} s.`,
    '',
  );
  L.push(
    `Clients: ${String(r.clients.created)} created, peak ${String(r.clients.peakClients)} at once, peak ${String(r.realtime.peakConcurrentWs)} concurrent WebSockets, ${f(r.clients.clientMinutes)} client-minutes.`,
    '',
  );
  L.push('## Propagation (server event created_at → client receipt)', '');
  L.push('| Events | n | p50 | p95 | p99 | max | unit |', '|---|---|---|---|---|---|---|');
  L.push(sumRow('battle `phase`', r.propagation.battlePhaseMs));
  for (const [k, s] of Object.entries(r.propagation.battlePhaseBySource)) {
    L.push(
      sumRow(`battle \`phase\`, caused by ${k === 'server' ? 'the sweep/worker' : 'an RPC'}`, s),
    );
  }
  L.push(sumRow('all battle events', r.propagation.battleAllMs));
  L.push(sumRow('all room events', r.propagation.roomAllMs));
  for (const [k, s] of Object.entries(r.propagation.byType)) L.push(sumRow(k, s));
  L.push(sumRow('clock offset (client − server)', r.propagation.clockOffsetMs));
  L.push(
    '',
    `Deliveries of battle events v≥3: ${String(r.propagation.deliveries.received)} / ${String(r.propagation.deliveries.expected)} (${f(r.propagation.deliveries.ratio * 100, 2)} %). Receipts without a DB event: ${String(r.propagation.unmatchedReceipts)}.`,
    '',
  );
  L.push('## Requests (latency in ms)', '');
  L.push(
    '| Call | n | p50 | p95 | p99 | max | statuses | up | down |',
    '|---|---|---|---|---|---|---|---|---|',
  );
  for (const [k, h] of Object.entries(r.http)) {
    L.push(
      `| ${k} | ${String(h.n)} | ${f(h.p50)} | ${f(h.p95)} | ${f(h.p99)} | ${f(h.max)} | ${JSON.stringify(h.status)} | ${kb(h.bytesUp)} | ${kb(h.bytesDown)} |`,
    );
  }
  L.push('', '## Errors', '');
  L.push('| Code | n |', '|---|---|');
  for (const [k, n] of sortedEntries(r.errors.byCall)) L.push(`| ${k} | ${String(n)} |`);
  if (Object.keys(r.errors.byCall).length === 0) L.push('| (none) | 0 |');
  L.push('', '## Realtime', '');
  L.push(
    `WebSockets opened ${String(r.realtime.wsOpened)}, closed ${String(r.realtime.wsClosed)}, peak concurrent ${String(r.realtime.peakConcurrentWs)}. ` +
      `Billable messages (assumed rule): in ${String(r.realtime.billableIn)}, out ${String(r.realtime.billableOut)}; inbound per second p50 ${f(r.realtime.billablePerSec.p50)}, p99 ${f(r.realtime.billablePerSec.p99)}, max ${f(r.realtime.billablePerSec.max)}. ` +
      `Presence: sent ${String(r.realtime.presence.sent)}, deferred by the throttle ${String(r.realtime.presence.deferred)}, failed ${String(r.realtime.presence.failed)}. Bytes in ${mb(r.realtime.bytesIn)}, out ${mb(r.realtime.bytesOut)}.`,
    '',
  );
  L.push(`Frames in: \`${JSON.stringify(r.realtime.framesIn)}\``, '');
  L.push(`Frames out: \`${JSON.stringify(r.realtime.framesOut)}\``, '');
  L.push(`Channel statuses: \`${JSON.stringify(r.realtime.channelStatus)}\``, '');
  L.push('## Storage', '');
  L.push('| Direction:file | count | bytes |', '|---|---|---|');
  for (const [k, n] of sortedEntries(r.storage.bytes))
    L.push(`| ${k} | ${String(r.storage.counts[k] ?? 0)} | ${kb(n)} |`);
  L.push(
    '',
    `Per battle: up p50 ${kb(r.storage.perBattle.up.p50)} (mean ${kb(r.storage.perBattle.up.mean)}), down p50 ${kb(r.storage.perBattle.down.p50)} (mean ${kb(r.storage.perBattle.down.mean)}); screenshots kept ${kb(r.storage.screenshotBytesPerBattle)} per battle.`,
    '',
  );
  L.push('## Capture', '');
  if (!r.capture.enabled) L.push('Capture worker not running in this run.', '');
  else {
    L.push(
      `Jobs ${JSON.stringify(r.capture.jobs)}; outcomes ${JSON.stringify(r.capture.outcomes)}; throughput ${f(r.capture.throughputPerMin)} captures/min (concurrency ${String(c.captureConcurrency)}); max backlog ${String(r.capture.maxBacklog)}.`,
      '',
      `Capture job ms p50 ${f(r.capture.jobMs['capture']?.p50 ?? Number.NaN, 0)}, p95 ${f(r.capture.jobMs['capture']?.p95 ?? Number.NaN, 0)}; render ms p50 ${f(r.capture.renderMs.p50, 0)}; ready ${JSON.stringify(r.capture.readyReasons)}; screenshot bytes p50 ${f(r.capture.screenshotBytes.p50, 0)}; SHIPPING end → captured p50 ${f(r.capture.shipToCaptureMs.p50 / 1000)} s, p95 ${f(r.capture.shipToCaptureMs.p95 / 1000)} s.`,
      '',
    );
    const step = Math.max(1, Math.ceil(r.capture.backlog.length / 20));
    L.push('Backlog over time (queued + running):', '', '```');
    const t0 = r.capture.backlog[0]?.t ?? 0;
    for (let i = 0; i < r.capture.backlog.length; i += step) {
      const b = r.capture.backlog[i];
      if (b)
        L.push(
          `${String(Math.round((b.t - t0) / 1000)).padStart(5)} s  ${'#'.repeat(Math.min(80, b.queued + b.running))} ${String(b.queued)}+${String(b.running)}`,
        );
    }
    L.push('```', '');
  }
  L.push('## Database', '');
  L.push(
    `Max active backends ${String(r.db.maxActive)}, max waiting locks ${String(r.db.maxWaitingLocks)}, commits/s p50 ${f(r.db.commitsPerSec.p50)} max ${f(r.db.commitsPerSec.max)}, deadlocks ${String(r.db.deadlocks)}. DB size ${mb(r.db.sizeBytes.before)} → ${mb(r.db.sizeBytes.after)}.`,
    '',
    `Rows per battle: \`${JSON.stringify(r.db.rowsPerBattle)}\``,
    '',
  );
  if (r.db.statements.length) {
    L.push(
      '| Statement (pg_stat_statements, top by total time) | calls | total ms | mean ms |',
      '|---|---|---|---|',
    );
    for (const s of r.db.statements.slice(0, 12)) {
      L.push(
        `| \`${s.query.replace(/\|/g, '\\|')}\` | ${String(s.calls)} | ${f(s.total_ms)} | ${f(s.mean_ms, 2)} |`,
      );
    }
    L.push('');
  }
  L.push('## Containers (docker stats, 100% = 1 core)', '');
  if (!r.docker.available) L.push('docker stats not available.', '');
  else {
    L.push('| Container | mean CPU % | max CPU % | max MiB |', '|---|---|---|---|');
    for (const [k, x] of sortedEntries(r.docker.containers))
      L.push(`| ${k} | ${f(x.meanCpu)} | ${f(x.maxCpu)} | ${f(x.maxMemMiB)} |`);
    L.push('');
  }
  L.push('## Generator', '');
  L.push(
    `Event-loop delay per process (p50/p99/max ms): ${r.generator.eventLoopDelayMs.map((e) => `${f(e.p50)}/${f(e.p99)}/${f(e.max)}`).join(', ')}. Generator CPU: ${f(r.generator.cores, 2)} cores on average. Host CPU busy % (5 s samples): ${r.meta.host.cpuBusyPct.map((x) => f(x, 0)).join(' ')}. Host load average (1 min): ${r.meta.host.loadAvg.map((l) => f(l[0] ?? 0, 1)).join(' ')}.`,
    '',
    `Client counters: \`${JSON.stringify(r.sim)}\``,
    '',
  );
  L.push('## Rates used by the cost model', '');
  L.push(`Per client-minute: \`${JSON.stringify(r.rates.perClientMinute)}\``, '');
  L.push(`Per battle: \`${JSON.stringify(r.rates.perBattle)}\``, '');
  if (r.meta.notes.length) {
    L.push('## Notes', '');
    for (const n of r.meta.notes) L.push(`- ${n}`);
    L.push('');
  }
  return L.join('\n');
}
