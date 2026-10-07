/**
 * Self-explaining failures for the rooms e2e (multiplayer*.spec.ts, chaos*.spec.ts): import
 * `test` and `expect` from here instead of `@playwright/test`.
 *
 * Every page of every player (rooms.ts `newPlayer` / `newPhone`) keeps a timestamped log of
 * its console, page errors, failed requests and Realtime WebSocket traffic (Phoenix frames,
 * heartbeats left out). When a test fails, an automatic fixture attaches, next to
 * Playwright's own trace and screenshots:
 *
 * - `players.md`: per player, the page URL, the visible stages (lobby, reveal, vote…) with
 *   their data attributes, the Realtime channels by topic (joined, closed, errored), and the
 *   last log lines; plus a labelled screenshot of every open page;
 * - `db.json`: a snapshot of every battle and room created during the test (battles, their
 *   events with timestamps, players, builds, votes per voter, room members with
 *   last_seen_at, the job queue) and the pg_cron runs that failed or were slow meanwhile;
 * - `services.log`: what the e2e services (capture worker, shell) printed during the test
 *   (scripts/solo-services.ts writes it with `BR_SERVICES_LOG`);
 * - `docker-*.log`: the Supabase containers' logs (Realtime, Postgres, Auth) during the test.
 *
 * On CI the job uploads `test-results/` (the configs' output directory) on failure.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test as base, expect, type Page, type TestInfo } from '@playwright/test';
import { sql } from './stack';

export { expect };

/** How many log lines a page keeps (the oldest are dropped). */
const LOG_LIMIT = 3_000;
/** The Supabase containers whose logs a failure attaches (`supabase_<svc>_<project_id>`). */
const CONTAINERS = ['realtime', 'db', 'auth', 'rest', 'storage'];
const PROJECT_ID = 'build-roulette';

export interface PageLog {
  label: string;
  lines: string[];
  /** Phoenix topic → its latest known state (join sent, joined, closed, errored…). */
  channels: Map<string, { state: string; at: string; detail?: string }>;
}

interface Tracked {
  name: string;
  page: Page;
  log: PageLog;
}

const tracked = new WeakMap<TestInfo, Tracked[]>();

function push(log: PageLog, line: string): void {
  log.lines.push(`${new Date().toISOString()} ${line}`);
  if (log.lines.length > LOG_LIMIT) log.lines.splice(0, log.lines.length - LOG_LIMIT);
}

/** A Phoenix (Realtime) frame, serializer 1.0 (object) or 2.0 (array). */
function phoenix(
  text: string,
): { topic: string; event: string; payload: unknown; ref: unknown } | null {
  try {
    const m = JSON.parse(text) as unknown;
    if (Array.isArray(m) && m.length === 5) {
      return { topic: String(m[2]), event: String(m[3]), payload: m[4], ref: m[1] };
    }
    if (m && typeof m === 'object' && 'topic' in m && 'event' in m) {
      const o = m as { topic: unknown; event: unknown; payload: unknown; ref: unknown };
      return { topic: String(o.topic), event: String(o.event), payload: o.payload, ref: o.ref };
    }
  } catch {
    // Not JSON: logged as is.
  }
  return null;
}

function channelState(log: PageLog, dir: 'sent' | 'received', text: string): void {
  const f = phoenix(text);
  if (!f || f.topic === 'phoenix') return;
  const at = new Date().toISOString();
  const status = (f.payload as { status?: unknown } | null)?.status;
  if (dir === 'sent' && f.event === 'phx_join') {
    log.channels.set(f.topic, { state: 'joining', at });
  } else if (dir === 'sent' && f.event === 'phx_leave') {
    log.channels.set(f.topic, { state: 'leaving', at });
  } else if (dir === 'received' && f.event === 'phx_reply') {
    const prev = log.channels.get(f.topic);
    if (prev?.state === 'joining') {
      log.channels.set(f.topic, {
        state: status === 'ok' ? 'joined' : `join ${String(status)}`,
        at,
        ...(status === 'ok' ? {} : { detail: JSON.stringify(f.payload).slice(0, 300) }),
      });
    } else if (prev?.state === 'leaving') {
      log.channels.set(f.topic, { state: 'left', at });
    }
  } else if (dir === 'received' && (f.event === 'phx_close' || f.event === 'phx_error')) {
    log.channels.set(f.topic, {
      state: f.event === 'phx_close' ? 'closed by server' : 'errored',
      at,
      detail: JSON.stringify(f.payload).slice(0, 300),
    });
  } else if (dir === 'received' && f.event === 'system' && status !== 'ok') {
    log.channels.set(f.topic, {
      state: 'system error',
      at,
      detail: JSON.stringify(f.payload).slice(0, 300),
    });
  }
}

/** Starts logging `page` (console, errors, failed requests, Realtime frames) for `info`. */
export function trackPage(info: TestInfo, name: string, page: Page): void {
  const pages = tracked.get(info) ?? [];
  tracked.set(info, pages);
  const n = pages.filter((t) => t.name === name).length;
  const log: PageLog = {
    label: n === 0 ? name : `${name} (page ${String(n + 1)})`,
    lines: [],
    channels: new Map(),
  };
  pages.push({ name, page, log });
  page.on('console', (m) => {
    push(log, `console.${m.type()}: ${m.text().slice(0, 1_000)}`);
  });
  page.on('pageerror', (e) => {
    push(log, `pageerror: ${e.message}`);
  });
  page.on('crash', () => {
    push(log, 'page crashed');
  });
  page.on('requestfailed', (r) => {
    push(
      log,
      `requestfailed: ${r.method()} ${r.url().slice(0, 200)} ${r.failure()?.errorText ?? ''}`,
    );
  });
  page.on('response', (r) => {
    if (r.status() >= 400)
      push(log, `HTTP ${String(r.status())} ${r.request().method()} ${r.url().slice(0, 200)}`);
  });
  page.on('framenavigated', (f) => {
    if (f === page.mainFrame()) push(log, `navigated: ${f.url()}`);
  });
  page.on('websocket', (ws) => {
    if (!ws.url().includes('/realtime/')) return;
    push(log, `ws open ${ws.url().replace(/apikey=[^&]+/, 'apikey=…')}`);
    const frame = (dir: 'sent' | 'received') => (f: { payload: string | Buffer }) => {
      const text = typeof f.payload === 'string' ? f.payload : f.payload.toString();
      if (text.includes('"heartbeat"') && text.includes('"phoenix"')) return;
      channelState(log, dir, text);
      push(log, `ws ${dir === 'sent' ? '→' : '←'} ${text.slice(0, 400)}`);
    };
    ws.on('framesent', frame('sent'));
    ws.on('framereceived', frame('received'));
    ws.on('socketerror', (e) => {
      push(log, `ws error ${e}`);
    });
    ws.on('close', () => {
      push(log, 'ws closed');
      for (const [topic, c] of log.channels) {
        if (c.state === 'joined' || c.state === 'joining') {
          log.channels.set(topic, { state: 'socket closed', at: new Date().toISOString() });
        }
      }
    });
  });
}

/** The stages and banners a room page can show, with their data attributes. */
const STAGES = [
  'lobby',
  'spin',
  'build-stage',
  'spectator-stage',
  'shipped-banner',
  'times-up',
  'reveal-stage',
  'reveal-host-controls',
  'vote-stage',
  'vote-progress',
  'ballot-complete',
  'votes-unsent',
  'results',
  'room-ended',
  'reconnecting',
  'countdown',
  'toast',
  'join-error',
];

async function pageState(page: Page): Promise<string> {
  if (page.isClosed()) return '(closed)';
  try {
    const stages = await page.evaluate((ids) => {
      const out: string[] = [];
      for (const id of ids) {
        for (const el of Array.from(document.querySelectorAll(`[data-testid="${id}"]`))) {
          const h = el as HTMLElement;
          const attrs = Object.entries(h.dataset)
            .filter(([k]) => k !== 'testid')
            .map(([k, v]) => `${k}=${String(v)}`)
            .join(' ');
          const visible = h.offsetParent !== null || getComputedStyle(h).position === 'fixed';
          const text = (h.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120);
          out.push(`${id}${visible ? '' : ' (hidden)'} ${attrs} | ${text}`);
        }
      }
      return out;
    }, STAGES);
    return [`url: ${page.url()}`, ...stages].join('\n');
  } catch (e) {
    return `(state unavailable: ${e instanceof Error ? e.message : String(e)})`;
  }
}

function tryRun(fn: () => string): string {
  try {
    return fn();
  } catch (e) {
    return `(failed: ${e instanceof Error ? e.message : String(e)})`;
  }
}

/** Every battle and room created since `since` (database clock), as JSON. */
function dbSnapshot(since: string): string {
  return sql(`select jsonb_pretty(jsonb_build_object(
    'now', clock_timestamp(),
    'battles', (select coalesce(jsonb_agg(jsonb_build_object(
        'battle', to_jsonb(b),
        'events', (select coalesce(jsonb_agg(jsonb_build_object('v', e.version, 'type', e.type,
            'actor', e.actor_id, 'at', e.created_at, 'payload', e.payload) order by e.version), '[]')
          from public.battle_events e where e.battle_id = b.id),
        'players', (select coalesce(jsonb_agg(to_jsonb(p) order by p.display_name), '[]')
          from public.battle_players p where p.battle_id = b.id),
        'builds', (select coalesce(jsonb_agg(to_jsonb(x) - 'source' - 'files' order by x.builder_id), '[]')
          from public.builds x where x.battle_id = b.id),
        'votes', (select coalesce(jsonb_agg(jsonb_build_object('voter', v.voter_id, 'category', v.category,
            'build', v.build_id)), '[]') from public.votes v where v.battle_id = b.id),
        'jobs', (select coalesce(jsonb_agg(to_jsonb(j) order by j.id), '[]') from public.jobs j
          where j.ref_id = b.id or j.ref_id in (select id from public.builds where battle_id = b.id))
      ) order by b.created_at), '[]') from public.battles b where b.created_at >= '${since}'),
    'rooms', (select coalesce(jsonb_agg(jsonb_build_object(
        'room', to_jsonb(r),
        'members', (select coalesce(jsonb_agg(to_jsonb(m) order by m.joined_at), '[]')
          from public.room_members m where m.room_id = r.id)
      )), '[]') from public.rooms r where r.created_at >= '${since}' or r.id in
        (select room_id from public.battles where created_at >= '${since}')),
    'job_queue', (select jsonb_object_agg(s, n) from (select status::text s, count(*) n
      from public.jobs group by status) q),
    'cron_runs', (select jsonb_build_object('count', count(*),
        'failed', count(*) filter (where status <> 'succeeded'),
        'max_ms', max(extract(epoch from end_time - start_time) * 1000)::int,
        'p95_ms', (percentile_cont(0.95) within group (order by extract(epoch from end_time - start_time) * 1000))::int)
      from cron.job_run_details where start_time >= '${since}'),
    'cron_problems', (select coalesce(jsonb_agg(jsonb_build_object('job', jobid, 'status', status,
        'start', start_time, 'ms', (extract(epoch from end_time - start_time) * 1000)::int,
        'message', left(return_message, 300)) order by start_time), '[]')
      from cron.job_run_details where start_time >= '${since}'
        and (status <> 'succeeded' or end_time - start_time > interval '1 second')),
    'connections', (select jsonb_object_agg(coalesce(application_name, '?') || ':' || coalesce(state, '?'), n)
      from (select application_name, state, count(*) n from pg_stat_activity group by 1, 2) a)
  ))`);
}

function servicesLog(sinceMs: number): string {
  const file = process.env['BR_SERVICES_LOG'];
  if (!file) return '(BR_SERVICES_LOG not set)';
  const text = readFileSync(file, 'utf8');
  // Lines start with an ISO timestamp (scripts/solo-services.ts); keep the test's window.
  return text
    .split('\n')
    .filter((l) => {
      const t = Date.parse(l.slice(0, 24));
      return Number.isNaN(t) || t >= sinceMs - 2_000;
    })
    .join('\n');
}

async function attachDiagnostics(info: TestInfo, sinceDb: string, sinceMs: number) {
  const pages = tracked.get(info) ?? [];
  const sections: string[] = [];
  for (const [i, t] of pages.entries()) {
    const channels = [...t.log.channels.entries()]
      .map(([topic, c]) => `- ${topic}: ${c.state} at ${c.at}${c.detail ? ` ${c.detail}` : ''}`)
      .join('\n');
    sections.push(
      `## ${t.log.label}\n\n### State\n\n\`\`\`\n${await pageState(t.page)}\n\`\`\`\n\n` +
        `### Realtime channels\n\n${channels || '(none)'}\n\n` +
        `### Log (last 400 lines)\n\n\`\`\`\n${t.log.lines.slice(-400).join('\n')}\n\`\`\`\n`,
    );
    if (!t.page.isClosed()) {
      try {
        await info.attach(`screen-${String(i + 1)}-${t.log.label}`, {
          body: await t.page.screenshot({ timeout: 5_000 }),
          contentType: 'image/png',
        });
      } catch {
        // A hung page: its state above says so.
      }
    }
  }
  await info.attach('players.md', {
    body: sections.join('\n') || '(no tracked pages)',
    contentType: 'text/markdown',
  });
  // The full logs, for anything older than the last 400 lines.
  await info.attach('players-full.log', {
    body: pages.map((t) => `==== ${t.log.label}\n${t.log.lines.join('\n')}`).join('\n\n'),
    contentType: 'text/plain',
  });
  await info.attach('db.json', {
    body: tryRun(() => dbSnapshot(sinceDb)),
    contentType: 'application/json',
  });
  await info.attach('services.log', {
    body: tryRun(() => servicesLog(sinceMs)),
    contentType: 'text/plain',
  });
  const sinceDocker = new Date(sinceMs - 2_000).toISOString();
  for (const svc of CONTAINERS) {
    await info.attach(`docker-${svc}.log`, {
      body: tryRun(() => {
        // Containers log to stdout and stderr (Postgres: stderr); merged by timestamp.
        const r = spawnSync(
          'docker',
          ['logs', '--timestamps', '--since', sinceDocker, `supabase_${svc}_${PROJECT_ID}`],
          { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
        );
        if (r.error) throw r.error;
        return [...r.stdout.split('\n'), ...r.stderr.split('\n')].filter(Boolean).sort().join('\n');
      }),
      contentType: 'text/plain',
    });
  }
}

export const test = base.extend<{ diagnostics: undefined }>({
  diagnostics: [
    // eslint-disable-next-line no-empty-pattern -- Playwright fixtures destructure their deps.
    async ({}, use, info) => {
      const sinceDb = tryRun(() => sql('select clock_timestamp()'));
      const sinceMs = Date.now();
      await use(undefined);
      if (info.status !== info.expectedStatus) {
        await attachDiagnostics(info, sinceDb, sinceMs);
      }
    },
    { auto: true, timeout: 120_000 },
  ],
});
