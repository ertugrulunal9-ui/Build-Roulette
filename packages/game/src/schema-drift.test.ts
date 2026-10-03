/**
 * Drift test: `BATTLE_PHASES` must match the Postgres enum `public.battle_phase` as
 * defined by the SQL migrations (supabase/migrations/*.sql), value for value, in order.
 *
 * The migrations are replayed in filename order (the order the Supabase CLI and
 * supabase/scripts/test.sh apply them): `create type ... as enum (...)` sets the list,
 * `alter type ... add value [if not exists] 'x' [before|after 'y']` and
 * `alter type ... rename value 'a' to 'b'` modify it.
 *
 * Vote categories are not checked here: `@br/game` does not expose them (yet).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BATTLE_PHASES } from './phases';

const MIGRATIONS_DIR = resolve(import.meta.dirname, '../../../supabase/migrations');
const ENUM_NAME = 'battle_phase';
const DOLLAR_TAG = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/;

/**
 * Removes `-- line` and `/* block *\/` comments. String literals and dollar-quoted bodies
 * (`$$ ... $$`, `$fn$ ... $fn$`) are copied verbatim.
 */
function stripSqlComments(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql.charAt(i);
    const next = sql.charAt(i + 1);
    const dollarTag = ch === '$' ? DOLLAR_TAG.exec(sql.slice(i, i + 64))?.[0] : undefined;
    if (ch === "'") {
      // String literal; '' is an escaped quote and simply re-enters the loop.
      const end = sql.indexOf("'", i + 1);
      const stop = end === -1 ? sql.length : end + 1;
      out += sql.slice(i, stop);
      i = stop;
    } else if (dollarTag !== undefined) {
      const end = sql.indexOf(dollarTag, i + dollarTag.length);
      const stop = end === -1 ? sql.length : end + dollarTag.length;
      out += sql.slice(i, stop);
      i = stop;
    } else if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
    } else if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += ' ';
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

/** Parses a SQL string literal body: `'it''s'` → `it's`. */
function unquote(literal: string): string {
  return literal.slice(1, -1).replaceAll("''", "'");
}

const LITERAL = String.raw`'(?:[^']|'')*'`;
// Optional `public.` schema and optional double quotes around the type name.
const TYPE_NAME = String.raw`(?:"?public"?\s*\.\s*)?"?${ENUM_NAME}"?`;

const STATEMENT_PATTERNS = {
  create: new RegExp(String.raw`\bcreate\s+type\s+${TYPE_NAME}\s+as\s+enum\s*\(([^)]*)\)`, 'gi'),
  addValue: new RegExp(
    String.raw`\balter\s+type\s+${TYPE_NAME}\s+add\s+value\s+(?:if\s+not\s+exists\s+)?(${LITERAL})(?:\s+(before|after)\s+(${LITERAL}))?`,
    'gi',
  ),
  renameValue: new RegExp(
    String.raw`\balter\s+type\s+${TYPE_NAME}\s+rename\s+value\s+(${LITERAL})\s+to\s+(${LITERAL})`,
    'gi',
  ),
  drop: new RegExp(String.raw`\bdrop\s+type\s+(?:if\s+exists\s+)?${TYPE_NAME}(?![\w$])`, 'gi'),
} as const;

type StatementKind = keyof typeof STATEMENT_PATTERNS;

interface Statement {
  kind: StatementKind;
  index: number;
  match: RegExpExecArray;
}

function fail(file: string, message: string): never {
  throw new Error(`${file}: ${message} (enum public.${ENUM_NAME})`);
}

/** Replays every migration and returns the final enum values, or null if never created. */
function battlePhaseEnumFromMigrations(
  files: readonly { name: string; sql: string }[],
): string[] | null {
  let values: string[] | null = null;

  for (const { name, sql } of files) {
    const text = stripSqlComments(sql);
    const statements: Statement[] = [];
    for (const kind of Object.keys(STATEMENT_PATTERNS) as StatementKind[]) {
      for (const match of text.matchAll(STATEMENT_PATTERNS[kind])) {
        statements.push({ kind, index: match.index, match });
      }
    }
    statements.sort((a, b) => a.index - b.index);

    for (const { kind, match } of statements) {
      switch (kind) {
        case 'create': {
          if (values !== null) fail(name, 'created twice without a drop in between');
          const body = match[1] ?? '';
          const literals = body.match(new RegExp(LITERAL, 'g')) ?? [];
          const leftover = body.replace(new RegExp(LITERAL, 'g'), '').replace(/[\s,]/g, '');
          if (literals.length === 0 || leftover !== '') {
            fail(name, `cannot parse the value list "(${body.trim()})"`);
          }
          values = literals.map(unquote);
          break;
        }
        case 'addValue': {
          if (values === null) fail(name, 'ADD VALUE before CREATE TYPE');
          const value = unquote(match[1] ?? "''");
          if (values.includes(value)) {
            if (/if\s+not\s+exists/i.test(match[0])) break;
            fail(name, `ADD VALUE '${value}' already exists`);
          }
          const position = match[2]?.toLowerCase();
          if (position === undefined) {
            values.push(value);
          } else {
            const anchor = unquote(match[3] ?? "''");
            const at = values.indexOf(anchor);
            if (at === -1) fail(name, `ADD VALUE ${position} unknown value '${anchor}'`);
            values.splice(position === 'before' ? at : at + 1, 0, value);
          }
          break;
        }
        case 'renameValue': {
          if (values === null) fail(name, 'RENAME VALUE before CREATE TYPE');
          const from = unquote(match[1] ?? "''");
          const at = values.indexOf(from);
          if (at === -1) fail(name, `RENAME VALUE of unknown value '${from}'`);
          values[at] = unquote(match[2] ?? "''");
          break;
        }
        case 'drop':
          values = null;
          break;
      }
    }
  }

  return values;
}

function readMigrations(): { name: string; sql: string }[] {
  const names = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    // Byte order, like the harness (LC_COLLATE=C) and the Supabase CLI.
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return names.map((name) => ({ name, sql: readFileSync(join(MIGRATIONS_DIR, name), 'utf8') }));
}

describe('schema drift: BATTLE_PHASES vs SQL enum public.battle_phase', () => {
  it('finds the SQL migrations', () => {
    expect(readMigrations().length, `no *.sql files in ${MIGRATIONS_DIR}`).toBeGreaterThan(0);
  });

  it('matches the enum defined by the migrations, in order', () => {
    const values = battlePhaseEnumFromMigrations(readMigrations());
    if (values === null) {
      throw new Error(
        `no "create type public.${ENUM_NAME} as enum (...)" found in ${MIGRATIONS_DIR}/*.sql ` +
          '(or it was dropped and not re-created); update this test if the enum was renamed',
      );
    }
    expect(values).toEqual([...BATTLE_PHASES]);
  });
});

describe('battlePhaseEnumFromMigrations (parser)', () => {
  const file = (name: string, sql: string) => ({ name, sql });

  it('handles schema-less, quoted and multi-line definitions and ignores comments', () => {
    const sql = `
      -- create type public.battle_phase as enum ('commented-out');
      /* create type battle_phase as enum ('also commented'); */
      create type "public"."battle_phase" as enum (
        'a', -- first
        'b' /* second */
      );
      create type public.battle_phase_other as enum ('x');
      insert into t values ('-- not a comment');
      create function f() returns int language sql as $fn$ select 1 -- it's fine
      $fn$;
    `;
    expect(battlePhaseEnumFromMigrations([file('1.sql', sql)])).toEqual(['a', 'b']);
  });

  it('applies ADD VALUE (plain, BEFORE, AFTER, IF NOT EXISTS) and RENAME VALUE across files', () => {
    const files = [
      file('1.sql', "create type battle_phase as enum ('a', 'c');"),
      file(
        '2.sql',
        `alter type public.battle_phase add value 'd';
         alter type public.battle_phase add value 'b' before 'c';
         alter type public.battle_phase add value if not exists 'a';
         alter type public.battle_phase add value 'a2' after 'a';
         alter type public.battle_phase rename value 'd' to 'z';`,
      ),
    ];
    expect(battlePhaseEnumFromMigrations(files)).toEqual(['a', 'a2', 'b', 'c', 'z']);
  });

  it('returns null when the enum is never created', () => {
    expect(battlePhaseEnumFromMigrations([file('1.sql', 'create table x (id int);')])).toBeNull();
  });

  it('fails clearly on statements it cannot reconcile', () => {
    expect(() =>
      battlePhaseEnumFromMigrations([file('1.sql', "alter type battle_phase add value 'x';")]),
    ).toThrow(/1\.sql: ADD VALUE before CREATE TYPE/);
    expect(() =>
      battlePhaseEnumFromMigrations([
        file('1.sql', "create type battle_phase as enum ('a');"),
        file('2.sql', "alter type battle_phase add value 'b' after 'nope';"),
      ]),
    ).toThrow(/2\.sql: ADD VALUE after unknown value 'nope'/);
  });
});
