// Opt-in: every SQL statement of scripts/deploy/sql.mjs against a real database (T-042), the
// local Supabase stack (Postgres 17 with Vault, pg_cron, Storage, Auth and our migrations):
//
//   DEPLOY_TEST_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
//     node --test scripts/deploy/sql.pg.test.mjs
//
// Skipped without DEPLOY_TEST_DB_URL (CI's `check` job has no stack). Each case runs in one
// psql session inside BEGIN … ROLLBACK, so it leaves the database as it was.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import {
  VAULT,
  addAdminSql,
  countAdminsSql,
  countUsersSql,
  createVaultSecretSql,
  evaluateSchema,
  quoteValue,
  readVaultSql,
  resultOf,
  schemaChecksSql,
  updateVaultSecretSql,
} from './sql.mjs';

const DB = process.env.DEPLOY_TEST_DB_URL;
const skip = DB ? false : 'set DEPLOY_TEST_DB_URL to the local stack (supabase start) to run';
const hex = () => randomBytes(32).toString('hex');
const REF = 'abcdefghijklmnopqrst';
const OURS = Object.values(VAULT)
  .map((n) => `'${n}'`)
  .join(', ');

/** Runs the statements in one rolled-back transaction; each answers one json line. */
function session(statements) {
  const args = [DB, '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', 'begin'];
  // Start from no deploy secrets in Vault (the local e2e may have set some; rolled back).
  args.push('-c', `delete from vault.secrets where name in (${OURS})`);
  for (const s of statements) args.push('-c', s);
  args.push('-c', 'rollback');
  const r = spawnSync('psql', args, { encoding: 'utf8' });
  const lines = r.stdout.split('\n').filter((l) => l.trim() !== '');
  return { code: r.status, results: lines.map((l) => resultOf([{ result: l }])), stderr: r.stderr };
}

describe('the deploy SQL on Postgres', { skip }, () => {
  it('Vault: read, create, update, and update of a missing name', () => {
    const cron = hex();
    const url1 = `https://${REF}.supabase.co/functions/v1/jobs`;
    const url2 = 'https://zyxwvutsrqponmlkjihg.supabase.co/functions/v1/jobs';
    const r = session([
      readVaultSql(),
      createVaultSecretSql(VAULT.cronSecret, cron, 'hex'),
      createVaultSecretSql(VAULT.functionUrl, url1, 'functionUrl'),
      readVaultSql(),
      updateVaultSecretSql(VAULT.functionUrl, url2, 'functionUrl'),
      updateVaultSecretSql(VAULT.captureSecret, hex(), 'hex'),
      readVaultSql(),
    ]);
    assert.equal(r.code, 0, r.stderr);
    const [empty, created1, created2, read1, updated, missing, read2] = r.results;
    assert.deepEqual(empty, {});
    assert.match(created1.id, /^[0-9a-f-]{36}$/);
    assert.match(created2.id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(read1, { [VAULT.cronSecret]: cron, [VAULT.functionUrl]: url1 });
    assert.deepEqual(updated, { updated: 1 });
    assert.deepEqual(missing, { updated: 0 });
    assert.deepEqual(read2, { [VAULT.cronSecret]: cron, [VAULT.functionUrl]: url2 });
  });

  it('vault.create_secret refuses a name that exists (hence update_secret)', () => {
    const r = session([
      createVaultSecretSql(VAULT.captureSecret, hex(), 'hex'),
      createVaultSecretSql(VAULT.captureSecret, hex(), 'hex'),
    ]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /duplicate key value/);
  });

  it('the checks after db push pass on the migrated database (DEPLOY.md §3.3)', () => {
    const r = session([schemaChecksSql()]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(evaluateSchema(r.results[0]), { problems: [], warnings: [] });
  });

  it('the moderator: unknown, then listed, then already listed (case-insensitive email)', () => {
    const id = '0b7e1c2a-1111-4222-8333-0000000000aa';
    const r = session([
      countUsersSql('Mod.Test+1@Example.com'),
      addAdminSql('Mod.Test+1@Example.com'),
      'insert into auth.users (id, email, aud, role, is_anonymous) values ' +
        `('${id}', 'mod.test+1@example.com', 'authenticated', 'authenticated', false) ` +
        "returning json_build_object('id', id) as result",
      countUsersSql('Mod.Test+1@Example.com'),
      countAdminsSql(),
      addAdminSql('Mod.Test+1@Example.com'),
      addAdminSql('mod.test+1@example.com'),
      countAdminsSql(),
    ]);
    assert.equal(r.code, 0, r.stderr);
    const [none, notListed, , one, before, listed, again, after] = r.results;
    assert.deepEqual(none, { users: 0 });
    assert.deepEqual(notListed, { users: 0, inserted: 0 });
    assert.deepEqual(one, { users: 1 });
    assert.deepEqual(listed, { users: 1, inserted: 1 });
    assert.deepEqual(again, { users: 1, inserted: 0 });
    assert.equal(after.admins, before.admins + 1);
  });

  it('dollar-quoted values reach Postgres unchanged', () => {
    const values = [
      ['a.b_c-d+e@sub-1.example.co.uk', 'email'],
      [hex(), 'hex'],
      [`https://${REF}.supabase.co/functions/v1/jobs`, 'functionUrl'],
    ];
    const r = session(
      values.map(([v, kind]) => `select json_build_object('v', ${quoteValue(v, kind)}) as result`),
    );
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(
      r.results.map((x) => x.v),
      values.map(([v]) => v),
    );
  });
});
