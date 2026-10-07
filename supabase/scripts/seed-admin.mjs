#!/usr/bin/env node
// Creates (or resets) an email/password ADMIN on the LOCAL stack, for /admin and the tests
// (T-024). Dependency-free: the Auth admin API (service role key) and psql.
//
//   node supabase/scripts/seed-admin.mjs                      admin@buildroulette.local / local-admin-pw
//   node supabase/scripts/seed-admin.mjs mod@example.test s3cret-pw
//   ADMIN_EMAIL=… ADMIN_PASSWORD=… node supabase/scripts/seed-admin.mjs
//
// Idempotent: an existing user keeps its id, gets the given password and is (re)listed in
// private.admins. Prints `{"id": …, "email": …}` on success.
//
// Local only: it refuses any API_URL that is not localhost / 127.0.0.1. Production admins
// are created in the dashboard (Authentication → Add user) and listed with SQL; see
// supabase/README.md "Abuse controls".

import { execFileSync } from 'node:child_process';

const KEYS = ['API_URL', 'SERVICE_ROLE_KEY', 'DB_URL'];

function loadEnv() {
  const env = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  if (KEYS.every((k) => env[k])) return env;
  const out = execFileSync('npx', ['-y', 'supabase@2.119.0', 'status', '-o', 'env'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  for (const line of out.split('\n')) {
    const m = /^([A-Z_]+)="?(.*?)"?$/.exec(line.trim());
    if (m && KEYS.includes(m[1]) && !env[m[1]]) env[m[1]] = m[2];
  }
  for (const k of KEYS) if (!env[k]) throw new Error(`missing ${k} (is the local stack running?)`);
  return env;
}

function sql(env, query) {
  return execFileSync(
    'psql',
    [env.DB_URL, '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', query],
    {
      encoding: 'utf8',
    },
  ).trim();
}

const quote = (s) => `'${String(s).replaceAll("'", "''")}'`;

export async function seedAdmin({
  email = process.env.ADMIN_EMAIL ?? 'admin@buildroulette.local',
  password = process.env.ADMIN_PASSWORD ?? 'local-admin-pw',
} = {}) {
  const env = loadEnv();
  const host = new URL(env.API_URL).hostname;
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error(
      `refusing to seed an admin on ${env.API_URL}: local stack only (production admins are created with SQL)`,
    );
  }
  if (password.length < 6) throw new Error('the password must be at least 6 characters');
  const headers = {
    apikey: env.SERVICE_ROLE_KEY,
    'content-type': 'application/json',
    ...(env.SERVICE_ROLE_KEY.startsWith('eyJ')
      ? { authorization: `Bearer ${env.SERVICE_ROLE_KEY}` }
      : {}),
  };

  let id =
    sql(env, `select id from auth.users where email = ${quote(email.toLowerCase())}`) || null;
  if (id) {
    const res = await fetch(`${env.API_URL}/auth/v1/admin/users/${id}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ password, email_confirm: true }),
    });
    if (!res.ok) throw new Error(`password reset failed: HTTP ${res.status} ${await res.text()}`);
  } else {
    const res = await fetch(`${env.API_URL}/auth/v1/admin/users`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ email, password, email_confirm: true }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.id)
      throw new Error(`user creation failed: HTTP ${res.status} ${JSON.stringify(body)}`);
    id = body.id;
  }
  sql(
    env,
    `insert into private.admins (user_id, note) values (${quote(id)}, 'seed-admin.mjs')
     on conflict (user_id) do nothing`,
  );
  return { id, email };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [email, password] = process.argv.slice(2);
  seedAdmin({ ...(email ? { email } : {}), ...(password ? { password } : {}) }).then(
    (admin) => console.log(JSON.stringify(admin)),
    (e) => {
      console.error(`seed-admin: ${e.message}`);
      process.exitCode = 1;
    },
  );
}
