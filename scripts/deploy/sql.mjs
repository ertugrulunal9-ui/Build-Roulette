// Every SQL statement the deploy sends (T-042), through the Supabase Management API's
// `POST /v1/projects/{ref}/database/query` (body {"query": "..."}). That endpoint takes one
// statement and answers its rows as JSON; we do not rely on bind parameters, so a value goes
// into the text only after strict validation (`quoteValue`) and inside a dollar quote with a
// random tag. Every statement answers one row with one json column `result`, so the same
// text runs unchanged through psql (scripts/deploy/sql.pg.test.mjs, against the local stack).
//
// The statements never carry a secret we did not generate: the Vault reads return values;
// only freshly generated hex secrets and fixed-shape URLs are written.

import { randomBytes } from 'node:crypto';

/** Vault names. `br_jobs_cron_secret` and `br_jobs_function_url` are read by
 * private.run_jobs_function() (supabase/migrations/20261009120000_jobs_function.sql). */
export const VAULT = {
  cronSecret: 'br_jobs_cron_secret',
  captureSecret: 'br_capture_hmac_secret',
  functionUrl: 'br_jobs_function_url',
};

const VAULT_NAMES = new Set(Object.values(VAULT));

/** The strict shapes a value must have before it goes into SQL text. */
export const VALUE_SHAPES = {
  /** A generated secret: 32 random bytes as lower-case hex. */
  hex: /^[0-9a-f]{64}$/,
  /** The jobs function's URL (built from a validated project ref). */
  functionUrl: /^https:\/\/[a-z]{20}\.supabase\.co\/functions\/v1\/jobs$/,
  /** A moderator's email: letters, digits and . _ + - before the @; a dotted domain. */
  email: /^[A-Za-z0-9._+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})+$/,
};

/** Is this a moderator email we accept (VALUE_SHAPES.email, at most 254 characters)? */
export function isValidEmail(value) {
  return typeof value === 'string' && value.length <= 254 && VALUE_SHAPES.email.test(value);
}

/**
 * `value` as a dollar-quoted SQL literal with a random tag (`$q_1a2b…$value$q_1a2b…$`),
 * after checking it against VALUE_SHAPES[kind]. Throws (without echoing the value) when it
 * does not match, so nothing unexpected ever reaches the SQL text.
 */
export function quoteValue(value, kind, random = randomBytes) {
  const shape = VALUE_SHAPES[kind];
  if (!shape) throw new Error(`quoteValue: unknown kind ${JSON.stringify(kind)}`);
  const ok =
    kind === 'email' ? isValidEmail(value) : typeof value === 'string' && shape.test(value);
  if (!ok) throw new Error(`quoteValue: the ${kind} value does not have the expected shape`);
  const tag = `q_${random(8).toString('hex')}`;
  // Cannot happen with the shapes above (none allows `$`), but the quote must never close early.
  if (value.includes('$')) throw new Error('quoteValue: a value must not contain $');
  return `$${tag}$${value}$${tag}$`;
}

function vaultName(name) {
  if (!VAULT_NAMES.has(name)) throw new Error(`unknown Vault name ${JSON.stringify(name)}`);
  return `'${name}'`;
}

/** {name: decrypted value} for our Vault secrets that exist. */
export function readVaultSql() {
  const names = [...VAULT_NAMES].map(vaultName).join(', ');
  return (
    "select coalesce(json_object_agg(name, decrypted_secret), '{}'::json) as result " +
    `from vault.decrypted_secrets where name in (${names})`
  );
}

/** Creates a Vault secret (the name must be new: vault.create_secret fails on a taken name). */
export function createVaultSecretSql(name, value, kind, random = randomBytes) {
  return (
    `select json_build_object('id', vault.create_secret(${quoteValue(value, kind, random)}, ` +
    `${vaultName(name)}, 'Build Roulette (scripts/deploy)')) as result`
  );
}

/** Replaces the value of an existing Vault secret; `updated` is 0 when the name is missing. */
export function updateVaultSecretSql(name, value, kind, random = randomBytes) {
  return (
    "select json_build_object('updated', count(*)) as result from (" +
    `select vault.update_secret(s.id, ${quoteValue(value, kind, random)}) ` +
    `from vault.secrets s where s.name = ${vaultName(name)}) u`
  );
}

/** What DEPLOY.md §3.3 checks after `db push`: the cron jobs, the buckets, the card deck. */
export function schemaChecksSql() {
  return (
    "select json_build_object('jobs', (select coalesce(json_object_agg(jobname, schedule), '{}'::json) from cron.job), " +
    "'buckets', (select coalesce(json_object_agg(id, public), '{}'::json) from storage.buckets), " +
    "'cards', (select count(*) from public.prompt_cards)) as result"
  );
}

/** Expected by schemaChecksSql (DEPLOY.md §3.3). */
export const EXPECTED_SCHEMA = {
  jobs: {
    'br-cron-history-cleanup': null,
    'br-event-logs-prune': null,
    'br-jobs-run': null,
    'br-rate-events-prune': null,
    'br-sweep-deadlines': '5 seconds',
    'br-sweep-ttl': null,
  },
  buckets: { 'ephemeral-builds': false, screenshots: true },
  cards: 130,
};

/**
 * Reads schemaChecksSql's result against EXPECTED_SCHEMA: `problems` fail the deploy,
 * `warnings` are reported (an extra cron job, another deck size).
 */
export function evaluateSchema(result) {
  const problems = [];
  const warnings = [];
  const jobs = result?.jobs ?? {};
  for (const [name, schedule] of Object.entries(EXPECTED_SCHEMA.jobs)) {
    if (!(name in jobs)) problems.push(`cron job ${name} is missing`);
    else if (schedule !== null && jobs[name] !== schedule)
      problems.push(`cron job ${name} runs every "${jobs[name]}", not "${schedule}"`);
  }
  const extra = Object.keys(jobs).filter((j) => !(j in EXPECTED_SCHEMA.jobs));
  if (extra.length) warnings.push(`cron jobs that are not the game's: ${extra.join(', ')}`);
  const buckets = result?.buckets ?? {};
  for (const [id, isPublic] of Object.entries(EXPECTED_SCHEMA.buckets)) {
    if (!(id in buckets)) problems.push(`storage bucket ${id} is missing`);
    else if (buckets[id] !== isPublic)
      problems.push(`storage bucket ${id} is ${buckets[id] ? 'public' : 'private'}`);
  }
  const cards = Number(result?.cards ?? 0);
  if (cards === 0) problems.push('public.prompt_cards is empty (the deck migration did not run)');
  else if (cards !== EXPECTED_SCHEMA.cards)
    warnings.push(
      `${String(cards)} prompt cards (DEPLOY.md §3.3 expects ${String(EXPECTED_SCHEMA.cards)})`,
    );
  return { problems, warnings };
}

/**
 * Lists the user with this email as a moderator (DEPLOY.md §3.5), idempotently:
 * `users` = matching users, `inserted` = 1 when it was not an admin yet.
 */
export function addAdminSql(email, random = randomBytes) {
  const literal = quoteValue(email, 'email', random);
  return (
    `with u as (select id from auth.users where lower(email) = lower(${literal})), ` +
    "ins as (insert into private.admins (user_id, note) select id, 'moderator' from u " +
    'on conflict (user_id) do nothing returning user_id) ' +
    "select json_build_object('users', (select count(*) from u), 'inserted', (select count(*) from ins)) as result"
  );
}

/** A statement that reads nothing: does the token allow SQL at all? (the preflight) */
export function probeSql() {
  return "select json_build_object('ok', true) as result";
}

/** How many users have this email (read-only; the preflight's check before any change). */
export function countUsersSql(email, random = randomBytes) {
  return (
    "select json_build_object('users', count(*)) as result from auth.users " +
    `where lower(email) = lower(${quoteValue(email, 'email', random)})`
  );
}

/** How many moderators there are (for the summary's next steps). */
export function countAdminsSql() {
  return "select json_build_object('admins', (select count(*) from private.admins)) as result";
}

/** The `result` of the single row a statement above answers (json or its text). */
export function resultOf(rows) {
  const row = Array.isArray(rows) ? rows[0] : undefined;
  if (!row || !('result' in row)) throw new Error('the query answered no result row');
  const r = row.result;
  return typeof r === 'string' ? JSON.parse(r) : r;
}
