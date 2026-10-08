/**
 * The cost model of docs/07 (T-025): plan prices and quotas (ASSUMED, one table), the
 * behaviour of a real battle (ASSUMED), and per-battle usage MEASURED by a load-test report.
 * `deriveUsage` turns a report (compressed battles, P_test players) into the usage of one
 * real battle (P players, a real build length), `monthly` prices N battles a month.
 *
 * Every price is from the author's knowledge of the public price lists, NOT re-checked:
 * this container cannot reach the pricing pages (2026-10-07). Update `PRICES` when they are
 * checked; docs/07 is regenerated with `pnpm --filter @br/loadtest cost <report.json>`.
 */
import type { Report } from './report';

export interface Price {
  value: number;
  unit: string;
  note: string;
}

/** ASSUMED prices and plan quotas (USD), as known to the author; dated 2026-10-07. */
export const PRICES = {
  // Supabase Pro
  supabaseBase: {
    value: 25,
    unit: '$/month',
    note: 'Pro plan; includes $10 of compute credits (one Micro instance)',
  },
  supabaseComputeMicro: {
    value: 10,
    unit: '$/month',
    note: 'Micro compute (shared 2 vCPU ARM, 1 GB); covered by the credit',
  },
  supabaseComputeSmall: {
    value: 15,
    unit: '$/month',
    note: 'Small compute (2 GB); the credit covers $10 of it',
  },
  supabaseComputeMedium: { value: 60, unit: '$/month', note: 'Medium compute (4 GB)' },
  supabaseComputeLarge: {
    value: 110,
    unit: '$/month',
    note: 'Large compute (8 GB, 2 dedicated cores)',
  },
  realtimePeakConnIncluded: { value: 500, unit: 'peak connections', note: 'Pro quota' },
  realtimePeakConnOver: { value: 10, unit: '$ per 1,000 peak connections', note: 'over the quota' },
  realtimeMsgIncluded: { value: 5_000_000, unit: 'messages/month', note: 'Pro quota' },
  realtimeMsgOver: { value: 2.5, unit: '$ per 1M messages', note: 'over the quota' },
  realtimeMsgPerSecPro: {
    value: 500,
    unit: 'messages/s',
    note: 'Pro rate limit with spend cap (2,500 without)',
  },
  egressIncludedGB: {
    value: 250,
    unit: 'GB/month',
    note: 'Pro, uncached egress (Auth, PostgREST, Storage, Realtime)',
  },
  egressOverPerGB: { value: 0.09, unit: '$/GB', note: 'over the quota' },
  storageIncludedGB: { value: 100, unit: 'GB', note: 'Pro, file storage' },
  storageOverPerGBMonth: { value: 0.021, unit: '$/GB-month', note: 'over the quota' },
  dbIncludedGB: { value: 8, unit: 'GB', note: 'Pro, database disk' },
  dbOverPerGBMonth: { value: 0.125, unit: '$/GB-month', note: 'over the quota' },
  mauIncluded: { value: 100_000, unit: 'MAU', note: 'Pro; anonymous sign-ins count as MAU' },
  mauOver: { value: 0.00325, unit: '$/MAU', note: 'over the quota' },
  // Cloudflare (Workers Paid)
  workersBase: {
    value: 5,
    unit: '$/month',
    note: 'Workers Paid (needed for Containers and Browser Rendering)',
  },
  workersReqIncluded: { value: 10_000_000, unit: 'requests/month', note: 'Workers Paid' },
  workersReqOver: { value: 0.3, unit: '$ per 1M requests', note: '' },
  workersCpuIncludedMs: { value: 30_000_000, unit: 'CPU ms/month', note: 'Workers Paid' },
  workersCpuOver: { value: 0.02, unit: '$ per 1M CPU ms', note: '' },
  pagesStatic: {
    value: 0,
    unit: '$',
    note: 'Pages static requests are free and unlimited (sandbox shell)',
  },
  browserHoursIncluded: {
    value: 10,
    unit: 'browser hours/month',
    note: 'Browser Rendering on Workers Paid',
  },
  browserHourOver: { value: 0.09, unit: '$/browser hour', note: '' },
  browserConcIncluded: {
    value: 10,
    unit: 'concurrent browsers (monthly average)',
    note: 'Workers Paid',
  },
  browserConcOver: {
    value: 2,
    unit: '$ per extra concurrent browser',
    note: 'monthly average of daily peaks',
  },
  containerMemGiBs: {
    value: 0.0000025,
    unit: '$/GiB-s',
    note: 'Containers; 25 GiB-h/month included',
  },
  containerCpuVs: {
    value: 0.00002,
    unit: '$/vCPU-s',
    note: 'Containers; 375 vCPU-min/month included',
  },
  containerDiskGBs: {
    value: 0.00000007,
    unit: '$/GB-s',
    note: 'Containers; 200 GB-h/month included',
  },
  containerEgressGB: {
    value: 0.025,
    unit: '$/GB',
    note: 'Containers egress (NA/EU), 1 TB included; behind the CDN cache',
  },
  r2: {
    value: 0,
    unit: '$',
    note: 'R2 only for the OpenNext ISR cache: within the free tier (10 GB, 1M A, 10M B ops)',
  },
  domain: {
    value: 10.44,
    unit: '$/year',
    note: 'app domain, .com at Cloudflare Registrar (at cost)',
  },
  domainUsercontent: {
    value: 10.44,
    unit: '$/year',
    note: 'usercontent domain (stage 2 only; stage 1 uses *.pages.dev)',
  },
} satisfies Record<string, Price>;

/** ASSUMED behaviour of a real battle and of the audience (2026-10-07). */
export const ASSUMPTIONS = {
  players: { value: 6, note: 'players per battle (docs/01 §1.7)' },
  buildMin: { value: 10, note: 'build minutes (docs/01 §1.7); the server draws 5, 10 or 15' },
  lobbyMin: { value: 2, note: 'minutes in the lobby before a battle' },
  votingMin: { value: 1, note: 'VOTING (default 60 s; often ends early)' },
  resultsMin: { value: 1, note: 'RESULTS (60 s, plus the capture wait)' },
  shippingMin: { value: 0.25, note: 'SHIPPING grace (15 s)' },
  finalShare: {
    value: 0.95,
    note: 'share of players with a final build (shipped or auto-shipped)',
  },
  screenshotKB: {
    value: 100,
    note: 'permanent WebP per final build (real apps; test builds are ~10 KB)',
  },
  battlesPerPlayerMonth: {
    value: 3,
    note: 'battles per unique player per month (MAU = players × battles / this)',
  },
  peakFactor: { value: 4, note: 'peak-hour concurrency over the monthly average' },
  workerRequestsPerPlayer: {
    value: 15,
    note: 'Worker requests per player per battle (pages, RSC, results, OG image)',
  },
  workerCpuMsPerRequest: { value: 10, note: 'CPU ms per Worker request (SSR)' },
  browserSecPerCapture: {
    value: 6,
    note: 'Browser Rendering seconds per screenshot (measured locally: see usage), rounded up',
  },
  containerActiveHours: {
    value: 730,
    note: 'package-CDN container hours/month (always on, worst case)',
  },
  containerMemGiB: { value: 1, note: 'container memory (instance type "basic")' },
  containerCpuUtil: {
    value: 0.25,
    note: 'vCPU-equivalents billed on average (1/4 vCPU, mostly idle behind the cache)',
  },
  containerDiskGB: { value: 4, note: 'container disk' },
};

export interface Usage {
  /** Per real battle. */
  realtimeMessages: number;
  realtimeConnMinutes: number;
  egressGB: number;
  storageGBAdded: number;
  dbBytesAdded: number;
  browserSeconds: number;
  workerRequests: number;
  workerCpuMs: number;
  apiRequests: number;
  /** Online minutes of one player in one battle (lobby included). */
  onlineMin: number;
  /** Where each figure comes from. */
  sources: Record<string, string>;
}

const revealSlotS = (n: number) => Math.round(Math.min(60, Math.max(30, 300 / n)));

/** The calls whose number grows with time online (heartbeat, version check, clock sync). */
const RATE_KEYS = new Set(['rpc:heartbeat', 'rest:battles', 'rpc:server_now']);

/**
 * Scales a measured run to one real battle of `players` players (docs/07 §3):
 *
 * - **event-driven** traffic (snapshots, nudges, ship, votes, reveal downloads, broadcasts)
 *   is taken per battle from the run; when the run had another player count P_t, it is
 *   scaled by (P / P_t)² (events grow with players and each goes to every player);
 * - **rate-driven** traffic (heartbeat, version check, clock sync) is taken per
 *   client-minute and multiplied by real online minutes × P;
 * - **presence**: sends per BUILDING minute (activity goes out only then) × real build minutes,
 *   plus the other sends per player-battle, each delivered to every member;
 * - **screenshots** are downloaded as often as measured, at the assumed real size;
 * - **captures**: final builds × the assumed browser seconds per capture.
 */
export function deriveUsage(r: Report, a = ASSUMPTIONS): Usage {
  const P = a.players.value;
  const F = Math.max(2, Math.round(P * a.finalShare.value));
  const onlineMin =
    a.lobbyMin.value +
    0.1 +
    a.buildMin.value +
    a.shippingMin.value +
    (F * revealSlotS(F)) / 60 +
    a.votingMin.value +
    a.resultsMin.value;
  const Pt = r.meta.config.players;
  const scale = (P / Pt) ** 2;
  const battles = Math.max(1, r.battles.started);
  const playerBattles = Math.max(1, r.battles.playerBattles);
  const clientMin = Math.max(1e-9, r.clients.clientMinutes);

  let eventCalls = 0;
  let eventBytes = 0;
  let rateCalls = 0;
  let rateBytes = 0;
  for (const [k, h] of Object.entries(r.http)) {
    if (!(k.startsWith('rpc:') || k.startsWith('rest:'))) continue;
    if (RATE_KEYS.has(k)) {
      rateCalls += h.n;
      rateBytes += h.bytesDown;
    } else {
      eventCalls += h.n;
      eventBytes += h.bytesDown;
    }
  }
  const storageCalls = (r.http['storage:download']?.n ?? 0) + (r.http['storage:upload']?.n ?? 0);
  const revealBytes = r.http['storage:download']?.bytesDown ?? 0;
  const shots = r.http['storage:public']?.n ?? 0;
  const authBytesPerPlayer =
    (r.http['auth:token']?.bytesDown ?? 0) / Math.max(1, r.clients.created);

  // Realtime: broadcast deliveries (binary user-broadcast frames) and presence.
  const broadcastIn = Object.entries(r.realtime.framesIn)
    .filter(([k]) => k.startsWith('binary:') || k === 'broadcast')
    .reduce((x, [, n]) => x + n, 0);
  const framesIn = Object.values(r.realtime.framesIn).reduce((x, n) => x + n, 0);
  const bytesPerFrame = framesIn ? r.realtime.bytesIn / framesIn : 0;
  const buildingSends = r.sim['presence_sent:building'] ?? 0;
  const buildMinTest = (playerBattles * r.meta.config.buildS) / 60;
  const presencePerBuildMin = buildingSends / Math.max(1e-9, buildMinTest);
  const presenceOtherPerPlayer = (r.realtime.presence.sent - buildingSends) / playerBattles;
  const presenceSends = P * (presencePerBuildMin * a.buildMin.value + presenceOtherPerPlayer);
  const presenceMsgs = presenceSends * (1 + P); // the send + one presence_diff per member
  const broadcastMsgs = (broadcastIn / battles) * scale;
  const realtimeMessages = broadcastMsgs + presenceMsgs;

  const egressBytes =
    (eventBytes / battles) * scale +
    (rateBytes / clientMin) * onlineMin * P +
    (revealBytes / battles) * scale +
    (shots / battles) * scale * a.screenshotKB.value * 1024 +
    (broadcastMsgs + presenceSends * P) * bytesPerFrame +
    authBytesPerPlayer * P;

  return {
    realtimeMessages,
    realtimeConnMinutes: onlineMin * P,
    egressGB: egressBytes / 1e9,
    storageGBAdded: (F * a.screenshotKB.value * 1024) / 1e9,
    dbBytesAdded: (r.db.sizeBytes.after - r.db.sizeBytes.before) / battles,
    browserSeconds: F * a.browserSecPerCapture.value,
    workerRequests: P * a.workerRequestsPerPlayer.value,
    workerCpuMs: P * a.workerRequestsPerPlayer.value * a.workerCpuMsPerRequest.value,
    apiRequests:
      ((eventCalls + storageCalls) / battles) * scale + (rateCalls / clientMin) * onlineMin * P,
    onlineMin,
    sources: {
      realtimeMessages: `measured: ${(broadcastIn / battles).toFixed(0)} broadcast deliveries per battle at ${String(Pt)} players; presence ${presencePerBuildMin.toFixed(2)} sends per BUILDING minute + ${presenceOtherPerPlayer.toFixed(1)} other per player-battle, × (1 + P) deliveries; billing rule assumed`,
      egressGB: `measured per battle: API ${(eventBytes / battles / 1024).toFixed(0)} KiB, reveal downloads ${(revealBytes / battles / 1024).toFixed(0)} KiB, ${(shots / battles).toFixed(0)} screenshot views; per client-minute ${(rateBytes / clientMin / 1024).toFixed(1)} KiB; screenshots assumed ${String(a.screenshotKB.value)} KB`,
      browserSeconds: `assumed ${String(a.browserSecPerCapture.value)} s per capture (local capture job p50 ${String(r.capture.jobMs['capture']?.p50 ?? 'n/a')} ms)`,
      apiRequests: `measured: ${((eventCalls + storageCalls) / battles).toFixed(0)} event-driven calls per battle + ${(rateCalls / clientMin).toFixed(2)} per client-minute`,
      scale: `run at ${String(Pt)} players per battle; event-driven figures × (${String(P)}/${String(Pt)})² = ${scale.toFixed(2)}`,
    },
  };
}

export interface LineItem {
  item: string;
  usage: string;
  cost: number;
}

/** Monthly cost of N real battles (fixed bases included). */
export function monthly(
  u: Usage,
  battles: number,
  monthsOfScreenshots = 12,
  a = ASSUMPTIONS,
): { items: LineItem[]; total: number } {
  const p = PRICES;
  const P = a.players.value;
  const over = (used: number, included: number) => Math.max(0, used - included);
  const items: LineItem[] = [];
  const add = (item: string, usage: string, cost: number) => items.push({ item, usage, cost });

  add('Supabase Pro (base, Micro compute)', 'fixed', p.supabaseBase.value);
  const msgs = u.realtimeMessages * battles;
  add(
    'Realtime messages',
    `${(msgs / 1e6).toFixed(2)} M`,
    (over(msgs, p.realtimeMsgIncluded.value) / 1e6) * p.realtimeMsgOver.value,
  );
  const avgConc = (battles * u.realtimeConnMinutes) / 43_800;
  const peak = Math.ceil(avgConc * a.peakFactor.value);
  add(
    'Realtime peak connections',
    `${String(peak)} peak`,
    (over(peak, p.realtimePeakConnIncluded.value) / 1000) * p.realtimePeakConnOver.value,
  );
  const egress = u.egressGB * battles;
  add(
    'Supabase egress',
    `${egress.toFixed(1)} GB`,
    over(egress, p.egressIncludedGB.value) * p.egressOverPerGB.value,
  );
  // Screenshots accumulate: the month's storage after `monthsOfScreenshots` months at this rate.
  const stored = u.storageGBAdded * battles * monthsOfScreenshots;
  add(
    `Storage (screenshots after ${String(monthsOfScreenshots)} months)`,
    `${stored.toFixed(1)} GB`,
    over(stored, p.storageIncludedGB.value) * p.storageOverPerGBMonth.value,
  );
  const mau = (battles * P) / a.battlesPerPlayerMonth.value;
  add(
    'MAU (anonymous players)',
    String(Math.round(mau)),
    over(mau, p.mauIncluded.value) * p.mauOver.value,
  );
  add('Cloudflare Workers Paid (base)', 'fixed', p.workersBase.value);
  const req = u.workerRequests * battles;
  const cpu = u.workerCpuMs * battles;
  add(
    'Workers requests + CPU',
    `${(req / 1e6).toFixed(2)} M req, ${(cpu / 1e6).toFixed(1)} M CPU-ms`,
    (over(req, p.workersReqIncluded.value) / 1e6) * p.workersReqOver.value +
      (over(cpu, p.workersCpuIncludedMs.value) / 1e6) * p.workersCpuOver.value,
  );
  const hours = (u.browserSeconds * battles) / 3600;
  add(
    'Browser Rendering (captures)',
    `${hours.toFixed(1)} browser-h`,
    over(hours, p.browserHoursIncluded.value) * p.browserHourOver.value,
  );
  const s = a.containerActiveHours.value * 3600;
  const memCost = Math.max(0, a.containerMemGiB.value * s - 25 * 3600) * p.containerMemGiBs.value;
  const cpuCost = Math.max(0, a.containerCpuUtil.value * s - 375 * 60) * p.containerCpuVs.value;
  const diskCost = Math.max(0, a.containerDiskGB.value * s - 200 * 3600) * p.containerDiskGBs.value;
  add(
    'Containers (package CDN)',
    `${String(a.containerActiveHours.value)} h`,
    memCost + cpuCost + diskCost,
  );
  add('Pages (sandbox shell), R2 (ISR cache)', 'free tier', 0);
  add('Domain (app)', '1 domain', p.domain.value / 12);
  const total = items.reduce((x, i) => x + i.cost, 0);
  return { items, total };
}

/** Battles per month at which each included quota runs out (first bottleneck first). */
export function quotaLimits(
  u: Usage,
  a = ASSUMPTIONS,
): { quota: string; battlesPerMonth: number }[] {
  const p = PRICES;
  const P = a.players.value;
  const rows = [
    {
      quota: 'Realtime messages (5 M/month)',
      battlesPerMonth: p.realtimeMsgIncluded.value / u.realtimeMessages,
    },
    {
      quota: `Realtime peak connections (500, peak factor ${String(a.peakFactor.value)})`,
      battlesPerMonth:
        ((p.realtimePeakConnIncluded.value / a.peakFactor.value) * 43_800) / u.realtimeConnMinutes,
    },
    {
      quota: 'Supabase egress (250 GB/month)',
      battlesPerMonth: p.egressIncludedGB.value / u.egressGB,
    },
    {
      quota: 'Browser Rendering (10 h/month)',
      battlesPerMonth: (p.browserHoursIncluded.value * 3600) / u.browserSeconds,
    },
    {
      quota: 'MAU (100 k)',
      battlesPerMonth: (p.mauIncluded.value * a.battlesPerPlayerMonth.value) / P,
    },
    {
      quota: 'Workers requests (10 M/month)',
      battlesPerMonth: p.workersReqIncluded.value / u.workerRequests,
    },
    {
      quota: 'Storage (100 GB, screenshots for 12 months)',
      battlesPerMonth: p.storageIncludedGB.value / 12 / u.storageGBAdded,
    },
  ];
  return rows.sort((x, y) => x.battlesPerMonth - y.battlesPerMonth);
}
