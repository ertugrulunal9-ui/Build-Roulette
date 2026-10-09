/**
 * Test data for the CPU measurement (T-033) on the LOCAL Supabase stack: finished battles
 * (2–8 builds, with or without a PNG screenshot of rank 1) and players with a history. What a
 * per-battle link preview (T-038's Pages Function, which reads `get_public_battle`) needs to
 * be measured with. Inserted with psql as the superuser, like the moderation e2e
 * (e2e/stack.ts), and committed. Players are inserted straight into `auth.users`
 * (anonymous), so hundreds of them do not run into the Auth sign-up rate limit.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { uploadScreenshot } from '../../e2e/stack';

export interface StackEnv {
  API_URL: string;
  ANON_KEY: string;
  DB_URL: string;
}

export interface BattleFixture {
  battle: string;
  /** Rank order: builds[0] is rank 1. */
  builds: { user: string; build: string }[];
}

export interface BattleOptions {
  /** Players (and shipped builds), default 2. */
  players?: number;
  /** `settled`: DESTROYED with destroyed_at. `live`: RESULTS (screenshots may still land). */
  state?: 'settled' | 'live';
  /** A PNG screenshot for rank 1 (the battle's `og:image`), default none. */
  screenshot?: 'png' | 'none';
  /** Vote counts and category awards (an M4 battle), default true. */
  voted?: boolean;
  /** Reuse these players (rank order) instead of new ones. */
  users?: string[];
}

const q = (s: string) => `'${s.replaceAll("'", "''")}'`;

export function makeSql(env: StackEnv) {
  return (query: string): string =>
    execFileSync('psql', [env.DB_URL, '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], {
      input: query,
      encoding: 'utf8',
    }).trim();
}

/** A 1280×800 PNG that looks like a page (bands and blocks; compresses like a UI screenshot). */
export function screenshotPng(seed: number): Uint8Array {
  const w = 1280;
  const h = 800;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < w; x++) {
      const block = ((x >> 6) + (y >> 5) + seed) % 7;
      const header = y < 72;
      const r = header ? 14 : 30 + block * 20;
      const g = header ? 165 : 40 + ((x * 3 + y + seed) & 63);
      const b = header ? 233 : 90 + block * 15;
      const i = row + 1 + x * 3;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const byte of buf) c = (crcTable[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw, { level: 6 })),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

export class Fixtures {
  private readonly sql: (query: string) => string;
  private png: Uint8Array | null = null;
  private seq = 0;

  constructor(private readonly env: StackEnv) {
    this.sql = makeSql(env);
  }

  /** New anonymous players with a profile. */
  players(n: number): string[] {
    const ids = Array.from({ length: n }, () => randomUUID());
    const values = ids.map((id) => `(${q(id)}::uuid)`).join(', ');
    this.sql(`
      insert into auth.users (id, instance_id, aud, role, is_anonymous, created_at, updated_at)
      select id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', true,
             now(), now()
      from (values ${values}) v(id);
      insert into public.profiles (id, display_name)
      select id, 'Probe ' || substr(id::text, 1, 6) from (values ${values}) v(id)
      on conflict (id) do nothing;`);
    return ids;
  }

  /** A finished battle (see BattleOptions), committed. */
  async battle(opts: BattleOptions = {}): Promise<BattleFixture> {
    const n = opts.users?.length ?? opts.players ?? 2;
    const users = opts.users ?? this.players(n);
    const settled = (opts.state ?? 'settled') === 'settled';
    const voted = opts.voted ?? true;
    const seq = ++this.seq;
    const rows = users
      .map((u, i) => {
        const votes = voted ? Math.max(0, n - i) : 0;
        const counts = voted
          ? `'{"overall":${String(votes)},"rule":${String(i % 2)},"style":${String(
              (i + 1) % 2,
            )},"chaos":0}'::jsonb`
          : 'null::jsonb';
        return `(${q(u)}::uuid, ${String(i + 1)}, ${String(100_000 + i * 15_000)}, ${String(
          votes,
        )}, ${counts})`;
      })
      .join(', ');
    const out = this.sql(`
      with c as (
        insert into public.challenges (build_text, rule_text, style_text, time_limit_seconds)
        values ('A CPU probe ${String(seq)}', 'Two colours only', 'Newspaper', 600) returning id),
      b as (
        insert into public.battles (challenge_id, host_id, settings, phase, version, finished_at,
                                    is_complete, building_started_at, building_ends_at,
                                    phase_ends_at, destroyed_at)
        select c.id, ${q(users[0] ?? '')}, '{"mode":"${n > 1 ? 'multiplayer' : 'solo'}"}',
               '${settled ? 'destroyed' : 'results'}', 9, now() - interval '2 minutes', true,
               now() - interval '14 minutes', now() - interval '4 minutes',
               ${settled ? 'null' : `now() + interval '1 hour'`}, ${settled ? 'now()' : 'null'}
        from c returning id),
      u(id, rank, ms, votes, counts) as (values ${rows}),
      r as (
        insert into public.battle_players (battle_id, user_id, display_name)
        select b.id, u.id, 'Probe ' || substr(u.id::text, 1, 6) from b, u returning battle_id),
      x as (
        insert into public.builds (battle_id, builder_id, name, status, shipped_at, completion_ms,
                                   final_rank, capture_status, total_votes, vote_counts, stats)
        select b.id, u.id, 'Probe build ' || u.rank, 'shipped', now() - interval '5 minutes',
               u.ms, u.rank, 'failed', u.votes, u.counts,
               '{"files":4,"lines":180,"deps":["react","three"]}'::jsonb
        from b, u returning id, builder_id, final_rank)
      select json_build_object(
        'battle', (select id from b),
        'builds', (select json_agg(json_build_object('user', builder_id, 'build', id)
                                   order by final_rank) from x));`);
    const fx = JSON.parse(out) as BattleFixture;
    if (voted && fx.builds[0]) {
      const top = fx.builds[0];
      const second = fx.builds[1] ?? top;
      this.sql(`
        insert into public.awards (battle_id, build_id, award, source, votes) values
          (${q(fx.battle)}, ${q(top.build)}, 'overall', 'vote', ${String(n)}),
          (${q(fx.battle)}, ${q(second.build)}, 'chaos', 'vote', 1),
          (${q(fx.battle)}, ${q(top.build)}, 'fastest_ship', 'auto', null);`);
    }
    if (opts.screenshot === 'png' && fx.builds[0]) {
      this.png ??= screenshotPng(1);
      const path = `${fx.battle}/${fx.builds[0].build}.png`;
      await uploadScreenshot(path, this.png, 'image/png');
      this.sql(`update public.builds set capture_status = 'captured', screenshot_path = ${q(path)},
                captured_at = now() where id = ${q(fx.builds[0].build)};`);
    }
    return fx;
  }

  /**
   * Marks a build as removed by a moderator, as `take_down_build` leaves it for the public
   * pages (`taken_down_at`; get_public_battle then drops its name, screenshot and awards).
   * Not the whole takedown (no takedown job, the screenshot stays in Storage): the measurement
   * only needs what the link-preview Function reads.
   */
  takeDown(build: string): void {
    this.sql(`update public.builds set taken_down_at = now() where id = ${q(build)};`);
  }
}
