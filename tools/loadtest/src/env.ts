/**
 * The stack's URLs and keys: from the environment, or from `supabase status -o env` (the
 * local stack). The load test only targets a LOCAL stack: it raises local Realtime quotas,
 * rewrites battle deadlines with SQL and creates hundreds of users.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export interface StackEnv {
  API_URL: string;
  ANON_KEY: string;
  SERVICE_ROLE_KEY: string;
  DB_URL: string;
  JWT_SECRET: string;
}

const KEYS = ['API_URL', 'ANON_KEY', 'SERVICE_ROLE_KEY', 'DB_URL', 'JWT_SECRET'] as const;

export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const SUPABASE_CLI = 'supabase@2.119.0';

export function loadStackEnv(): StackEnv {
  const found: Record<string, string | undefined> = {};
  for (const k of KEYS) found[k] = process.env[k];
  if (KEYS.some((k) => !found[k])) {
    let out = '';
    try {
      out = execFileSync('npx', ['-y', SUPABASE_CLI, 'status', '-o', 'env'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      throw new Error('the local Supabase stack is not running (supabase status failed)');
    }
    for (const line of out.split('\n')) {
      const m = /^([A-Z_]+)="?(.*?)"?$/.exec(line.trim());
      const key = m?.[1];
      if (key && m[2] && !found[key]) found[key] = m[2];
    }
  }
  for (const k of KEYS) if (!found[k]) throw new Error(`missing ${k} (is the stack running?)`);
  const env = found as unknown as StackEnv;
  const host = new URL(env.API_URL).hostname;
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error(`refusing to load-test a non-local stack (${env.API_URL})`);
  }
  return env;
}

/** The superuser-ish connection string (supabase_admin) for `_realtime` and stats views. */
export function adminDbUrl(dbUrl: string): string {
  const u = new URL(dbUrl);
  u.username = 'supabase_admin';
  return u.href;
}
