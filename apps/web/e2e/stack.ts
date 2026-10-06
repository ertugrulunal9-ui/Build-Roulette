/**
 * The local Supabase stack from the solo e2e's point of view: psql as the superuser to move
 * deadlines and inspect storage (like the pgTAP tests and supabase/scripts/e2e-solo.mjs).
 * DB_URL comes from the environment or `supabase status -o env`.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
let dbUrl: string | null = process.env['DB_URL'] ?? null;

function databaseUrl(): string {
  if (dbUrl) return dbUrl;
  const out = execFileSync('npx', ['-y', 'supabase@2.119.0', 'status', '-o', 'env'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const m = /^DB_URL="?(.*?)"?$/m.exec(out);
  if (!m?.[1]) throw new Error('DB_URL not found: is the local Supabase stack running?');
  dbUrl = m[1];
  return dbUrl;
}

/** Runs SQL as the superuser; returns the unaligned, tuples-only output. */
export function sql(query: string): string {
  return execFileSync(
    'psql',
    [databaseUrl(), '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', query],
    { encoding: 'utf8' },
  ).trim();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function assertUuid(id: string): string {
  if (!UUID.test(id)) throw new Error(`not a uuid: ${id}`);
  return id;
}

/** Names of the battle's objects in `ephemeral-builds`. */
export function ephemeralObjects(battleId: string): string[] {
  const out = sql(
    `select name from storage.objects where bucket_id = 'ephemeral-builds' and name like '${assertUuid(battleId)}/%' order by name`,
  );
  return out === '' ? [] : out.split('\n');
}

export function battleRow(battleId: string): {
  phase: string;
  destroyed_at: string | null;
} {
  return JSON.parse(
    sql(
      `select json_build_object('phase', phase, 'destroyed_at', destroyed_at) from public.battles where id = '${assertUuid(battleId)}'`,
    ),
  ) as { phase: string; destroyed_at: string | null };
}
