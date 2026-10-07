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

/**
 * Scales the measured run to one real battle:
 * - rate-driven traffic (heartbeat, version check, clock sync, presence, Realtime and API
 *   bytes per client-minute) × online minutes × players;
 * - broadcasts: measured battle/room events per player-battle → events(P) × P deliveries;
 * - reveal downloads: measured bytes per (viewer, build) pair × P × final builds;
 * - captures: final builds × the assumed browser seconds per capture.
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
  const battles = Math.max(1, r.battles.started);
  const clientMin = Math.max(1e-9, r.clients.clientMinutes);
  const Ft = Math.max(1, r.battles.finalBuilds.mean || Pt);

  // Broadcast deliveries: events per battle grow with players, each goes to every player.
  const evB = r.db.rowsPerBattle['battle_events'] ?? 0;
  const evR = r.db.rowsPerBattle['room_events'] ?? 0;
  const fixedB = 7; // spinning, building, shipping, voting, results, destroyed phases + `destroyed`
  const perPlayerB = Math.max(0, (evB - fixedB) / Pt);
  const perPlayerR = evR / Pt; // joins, readies, the start and reopen spread per player
  const eventsReal = fixedB + perPlayerB * P + perPlayerR * P;
  const broadcastDeliveries = eventsReal * P;
  // Presence: sends per client-minute (measured, throttled) delivered to every member.
  const presencePerMin = (r.realtime.presence.sent || 0) / clientMin;
  const presenceMsgs = presencePerMin * onlineMin * P * (1 + P);
  const realtimeMessages = broadcastDeliveries + presenceMsgs;

  // Egress: API + Realtime bytes per client-minute (rate-driven and event-driven mixed,
  // treated as time-driven), plus storage downloads per (viewer, build) pair.
  const storageDown = Object.entries(r.storage.bytes)
    .filter(([k]) => k.startsWith('down:') && k !== 'down:screenshot')
    .reduce((x, [, n]) => x + n, 0);
  const storageDownPerPair = storageDown / battles / (Pt * Ft);
  const shotPerPair = a.screenshotKB.value * 1024;
  const apiDown = Object.entries(r.http)
    .filter(([k]) => k.startsWith('rpc:') || k.startsWith('rest:') || k.startsWith('auth:token'))
    .reduce((x, [, h]) => x + h.bytesDown, 0);
  const apiPerClientMin = apiDown / clientMin;
  const rtPerClientMin = r.realtime.bytesIn / clientMin;
  const egressBytes =
    storageDownPerPair * P * F +
    shotPerPair * P * F +
    (apiPerClientMin + rtPerClientMin) * onlineMin * P;

  const apiCalls = Object.entries(r.http)
    .filter(([k]) => k.startsWith('rpc:') || k.startsWith('rest:') || k.startsWith('storage:'))
    .reduce((x, [, h]) => x + h.n, 0);

  return {
    realtimeMessages,
    realtimeConnMinutes: onlineMin * P,
    egressGB: egressBytes / 1e9,
    storageGBAdded: (F * a.screenshotKB.value * 1024) / 1e9,
    dbBytesAdded:
      r.battles.started > 0 ? (r.db.sizeBytes.after - r.db.sizeBytes.before) / battles : 0,
    browserSeconds: F * a.browserSecPerCapture.value,
    workerRequests: P * a.workerRequestsPerPlayer.value,
    workerCpuMs: P * a.workerRequestsPerPlayer.value * a.workerCpuMsPerRequest.value,
    apiRequests: (apiCalls / clientMin) * onlineMin * P,
    onlineMin,
    sources: {
      realtimeMessages: `measured events/player-battle (battle ${perPlayerB.toFixed(2)}, room ${perPlayerR.toFixed(2)}) + presence ${presencePerMin.toFixed(2)}/client-min; billing rule assumed`,
      egressGB: `measured: reveal ${(storageDownPerPair / 1024).toFixed(1)} KiB per (viewer, build), API ${(apiPerClientMin / 1024).toFixed(1)} KiB and Realtime ${(rtPerClientMin / 1024).toFixed(1)} KiB per client-minute; screenshots assumed ${String(a.screenshotKB.value)} KB`,
      browserSeconds: `assumed ${String(a.browserSecPerCapture.value)} s per capture (local capture job p50 ${String(r.capture.jobMs['capture']?.p50 ?? 'n/a')} ms)`,
      apiRequests: `measured ${(apiCalls / clientMin).toFixed(2)} HTTP calls per client-minute`,
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
