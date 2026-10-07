/**
 * Drift tests between `@br/game` and the SQL migrations (supabase/migrations/*.sql):
 *
 * - `BATTLE_PHASES` must match the Postgres enum `public.battle_phase`, value for value, in
 *   order. The migrations are replayed in filename order (the order the Supabase CLI applies
 *   them): `create type ... as enum (...)` sets the list,
 *   `alter type ... add value [if not exists] 'x' [before|after 'y']` and
 *   `alter type ... rename value 'a' to 'b'` modify it.
 * - `BUILD_TIME_LIMITS_MINUTES` must match `private.build_time_limits_seconds()` and
 *   `DEFAULT_PHASE_DURATIONS` the `<phase>_s` keys of `private.default_battle_settings()`,
 *   taking the last definition of each function across the migrations.
 *
 * - The room enums (`room_status`, `member_role`, `build_status`, `capture_status`), the
 *   room limits (`private.room_limits()`), the Realtime event names and change kinds
 *   (`private.battle_broadcast`, `private.room_broadcast`) and the RPC error codes (every
 *   `message = '...'` the migrations raise) must match `rooms.ts` and `errors.ts` (T-017).
 *
 * - REVEAL and VOTING (T-019): `VOTE_CATEGORIES` must match the `public.vote_categories` seed,
 *   the REVEAL_* / VOTING_* constants `private.reveal_vote_limits()`, and `revealSlotSeconds`
 *   (which rounds) the reference table that `supabase/tests/15_reveal_vote.test.sql` checks
 *   `private.reveal_slot_seconds(n)` against, so the two implementations cannot drift apart.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BUILD_TIME_LIMITS_MINUTES, DEFAULT_PHASE_DURATIONS } from './durations';
import {
  CAST_VOTE_ERRORS,
  JOIN_ROOM_ERRORS,
  RPC_ERROR_CODES,
  SERVICE_ERROR_CODES,
} from './errors';
import { BATTLE_PHASES, isBattlePhase } from './phases';
import {
  REVEAL_SLOT_MAX_SECONDS,
  REVEAL_SLOT_MIN_SECONDS,
  REVEAL_TOTAL_SECONDS,
  revealSlotSeconds,
} from './reveal';
import {
  BATTLE_EVENT_TYPES,
  BUILD_STATUSES,
  CAPTURE_STATUSES,
  MEMBER_CHANGES,
  MEMBER_ROLES,
  ROOM_CHANGES,
  ROOM_EVENT_TYPES,
  ROOM_LIMITS,
  ROOM_STATUSES,
} from './rooms';
import { VOTE_CATEGORIES, VOTING_MAX_SECONDS, VOTING_MIN_SECONDS } from './votes';

const MIGRATIONS_DIR = resolve(import.meta.dirname, '../../../supabase/migrations');
const REVEAL_VOTE_TEST = resolve(
  import.meta.dirname,
  '../../../supabase/tests/15_reveal_vote.test.sql',
);
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
function statementPatterns(enumName: string) {
  const typeName = String.raw`(?:"?public"?\s*\.\s*)?"?${enumName}"?`;
  return {
    create: new RegExp(String.raw`\bcreate\s+type\s+${typeName}\s+as\s+enum\s*\(([^)]*)\)`, 'gi'),
    addValue: new RegExp(
      String.raw`\balter\s+type\s+${typeName}\s+add\s+value\s+(?:if\s+not\s+exists\s+)?(${LITERAL})(?:\s+(before|after)\s+(${LITERAL}))?`,
      'gi',
    ),
    renameValue: new RegExp(
      String.raw`\balter\s+type\s+${typeName}\s+rename\s+value\s+(${LITERAL})\s+to\s+(${LITERAL})`,
      'gi',
    ),
    drop: new RegExp(String.raw`\bdrop\s+type\s+(?:if\s+exists\s+)?${typeName}(?![\w$])`, 'gi'),
  } as const;
}

type StatementKind = keyof ReturnType<typeof statementPatterns>;

interface Statement {
  kind: StatementKind;
  index: number;
  match: RegExpExecArray;
}

function failFor(file: string, message: string, enumName: string): never {
  throw new Error(`${file}: ${message} (enum public.${enumName})`);
}

/** Replays every migration and returns the final enum values, or null if never created. */
function enumFromMigrations(
  files: readonly { name: string; sql: string }[],
  enumName: string,
): string[] | null {
  let values: string[] | null = null;
  const patterns = statementPatterns(enumName);
  const fail: (file: string, message: string) => never = (file, message) =>
    failFor(file, message, enumName);

  for (const { name, sql } of files) {
    const text = stripSqlComments(sql);
    const statements: Statement[] = [];
    for (const kind of Object.keys(patterns) as StatementKind[]) {
      for (const match of text.matchAll(patterns[kind])) {
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

/** Replays every migration and returns the final `battle_phase` values, or null. */
function battlePhaseEnumFromMigrations(
  files: readonly { name: string; sql: string }[],
): string[] | null {
  return enumFromMigrations(files, ENUM_NAME);
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

/**
 * Body of the last `create [or replace] function private.<name>()` (no arguments) across the
 * migrations, or null. The body is the dollar-quoted string after `as`.
 */
function lastPrivateFunctionBody(
  files: readonly { name: string; sql: string }[],
  functionName: string,
  { anyArgs = false, schema = 'private' }: { anyArgs?: boolean; schema?: string } = {},
): string | null {
  const args = anyArgs ? String.raw`\([^)]*\)` : String.raw`\(\s*\)`;
  const pattern = new RegExp(
    String.raw`\bcreate\s+(?:or\s+replace\s+)?function\s+"?${schema}"?\s*\.\s*"?${functionName}"?\s*${args}` +
      String.raw`[\s\S]*?\bas\s+(\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$)([\s\S]*?)\1`,
    'gi',
  );
  let body: string | null = null;
  for (const { sql } of files) {
    for (const match of stripSqlComments(sql).matchAll(pattern)) body = match[2] ?? null;
  }
  return body;
}

/** `private.build_time_limits_seconds()`: the integers of its `array[...]` literal. */
function timeLimitsSecondsFromMigrations(files: readonly { name: string; sql: string }[]) {
  const body = lastPrivateFunctionBody(files, 'build_time_limits_seconds');
  const list = body === null ? undefined : /\barray\s*\[([\d\s,]*)\]/i.exec(body)?.[1];
  if (list === undefined) return null;
  return list
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v !== '')
    .map(Number);
}

/** `private.default_battle_settings()`: every `'<key>_s', <integer>` pair. */
function defaultSettingsFromMigrations(files: readonly { name: string; sql: string }[]) {
  const body = lastPrivateFunctionBody(files, 'default_battle_settings');
  if (body === null) return null;
  const settings: Record<string, number> = {};
  for (const match of body.matchAll(/'([a-z_]+)_s'\s*,\s*(\d+)/g)) {
    settings[match[1] ?? ''] = Number(match[2]);
  }
  return settings;
}

describe('schema drift: durations vs SQL constants', () => {
  it('BUILD_TIME_LIMITS_MINUTES matches private.build_time_limits_seconds()', () => {
    const seconds = timeLimitsSecondsFromMigrations(readMigrations());
    expect(
      seconds,
      'private.build_time_limits_seconds() not found or not a flat array',
    ).not.toBeNull();
    expect(seconds).toEqual(BUILD_TIME_LIMITS_MINUTES.map((minutes) => minutes * 60));
  });

  it('DEFAULT_PHASE_DURATIONS matches private.default_battle_settings()', () => {
    const settings = defaultSettingsFromMigrations(readMigrations());
    expect(settings, 'private.default_battle_settings() not found').not.toBeNull();
    // Every phase duration in SQL is known to @br/game, and every one @br/game has is in SQL.
    const sqlPhases = Object.fromEntries(
      Object.entries(settings ?? {}).filter(([key]) => isBattlePhase(key)),
    );
    expect(sqlPhases).toEqual({ ...DEFAULT_PHASE_DURATIONS });
  });

  it('parses the last definition and ignores comments', () => {
    const files = [
      {
        name: '1.sql',
        sql: `create function private.build_time_limits_seconds() returns int[] language sql
              as $$ select array[1, 2] $$;
              create function private.default_battle_settings() returns jsonb language sql
              as $$ select jsonb_build_object('spinning_s', 1) $$;`,
      },
      {
        name: '2.sql',
        sql: `-- create function private.build_time_limits_seconds() as $$ select array[9] $$;
              create or replace function "private".build_time_limits_seconds()
              returns int[] language sql immutable as $fn$
                select array[180, 300] -- comment
              $fn$;
              create or replace function private.default_battle_settings() returns jsonb
              language sql as $$ select jsonb_build_object('spinning_s', 6, 'other_s', 1) $$;`,
      },
    ];
    expect(timeLimitsSecondsFromMigrations(files)).toEqual([180, 300]);
    expect(defaultSettingsFromMigrations(files)).toEqual({ spinning: 6, other: 1 });
    expect(timeLimitsSecondsFromMigrations([{ name: '1.sql', sql: 'select 1;' }])).toBeNull();
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

// ─── Rooms and multiplayer (T-017) ────────────────────────────────────────────────────

describe('schema drift: room enums', () => {
  it.each([
    ['room_status', ROOM_STATUSES],
    ['member_role', MEMBER_ROLES],
    ['build_status', BUILD_STATUSES],
    ['capture_status', CAPTURE_STATUSES],
  ] as const)('public.%s matches @br/game', (enumName, expected) => {
    expect(enumFromMigrations(readMigrations(), enumName)).toEqual([...expected]);
  });
});

/** `private.room_limits()`: every `'<key>', <integer>` pair of its jsonb_build_object. */
function roomLimitsFromMigrations(files: readonly { name: string; sql: string }[]) {
  const body = lastPrivateFunctionBody(files, 'room_limits');
  if (body === null) return null;
  const limits: Record<string, number> = {};
  for (const match of body.matchAll(/'([a-z_]+)'\s*,\s*(\d+)/g)) {
    limits[match[1] ?? ''] = Number(match[2]);
  }
  return limits;
}

/** The quoted words of the `in (...)` list that follows `marker` in a function body. */
function inList(body: string, marker: RegExp): string[] {
  const at = marker.exec(body);
  if (!at) return [];
  const list = /\bin\s*\(([^)]*)\)/i.exec(body.slice(at.index))?.[1] ?? '';
  return [...list.matchAll(new RegExp(LITERAL, 'g'))].map((m) => unquote(m[0]));
}

/** Every `v_type := '<name>'` assignment in a function body, in order, deduplicated. */
function assignedTypes(body: string): string[] {
  const names = [...body.matchAll(/\bv_type\s*:=\s*'([a-z_]+)'/g)].map((m) => m[1] ?? '');
  return [...new Set(names)];
}

describe('schema drift: rooms and Realtime', () => {
  it('ROOM_LIMITS matches private.room_limits()', () => {
    expect(roomLimitsFromMigrations(readMigrations())).toEqual({ ...ROOM_LIMITS });
  });

  it('BATTLE_EVENT_TYPES (what the client applies) matches private.battle_broadcast()', () => {
    const body = lastPrivateFunctionBody(readMigrations(), 'battle_broadcast', { anyArgs: true });
    expect(body, 'private.battle_broadcast not found').not.toBeNull();
    expect(assignedTypes(body ?? '').sort()).toEqual([...BATTLE_EVENT_TYPES].sort());
  });

  it('ROOM_EVENT_TYPES, MEMBER_CHANGES and ROOM_CHANGES match private.room_broadcast()', () => {
    const body = lastPrivateFunctionBody(readMigrations(), 'room_broadcast', { anyArgs: true });
    expect(body, 'private.room_broadcast not found').not.toBeNull();
    expect(assignedTypes(body ?? '').sort()).toEqual([...ROOM_EVENT_TYPES].sort());
    expect(inList(body ?? '', /\bif\s+p_event\.type\b/i)).toEqual([...MEMBER_CHANGES]);
    expect(inList(body ?? '', /\belsif\s+p_event\.type\b/i)).toEqual([...ROOM_CHANGES]);
  });

  it('the error codes are exactly the codes the migrations raise', () => {
    const raised = new Set<string>();
    for (const { sql } of readMigrations()) {
      for (const m of stripSqlComments(sql).matchAll(/\bmessage\s*=\s*'([a-z_]+)'/g)) {
        raised.add(m[1] ?? '');
      }
    }
    const known = [...RPC_ERROR_CODES, ...SERVICE_ERROR_CODES];
    expect(new Set(known).size, 'a code is listed twice').toBe(known.length);
    expect([...raised].sort()).toEqual([...known].sort());
  });

  it('CAST_VOTE_ERRORS lists what public.cast_vote raises (besides not_authenticated)', () => {
    const body = lastPrivateFunctionBody(readMigrations(), 'cast_vote', {
      anyArgs: true,
      schema: 'public',
    });
    expect(body, 'public.cast_vote not found').not.toBeNull();
    const raised = new Set(
      [...(body ?? '').matchAll(/\bmessage\s*=\s*'([a-z_]+)'/g)].map((m) => m[1] ?? ''),
    );
    expect(body).toMatch(/private\.require_auth\(\)/);
    expect([...raised].sort()).toEqual([...CAST_VOTE_ERRORS].sort());
  });

  it('JOIN_ROOM_ERRORS lists what public.join_room raises (plus the display name check)', () => {
    const body = lastPrivateFunctionBody(readMigrations(), 'join_room', {
      anyArgs: true,
      schema: 'public',
    });
    expect(body, 'public.join_room not found').not.toBeNull();
    const raised = new Set(
      [...(body ?? '').matchAll(/\bmessage\s*=\s*'([a-z_]+)'/g)].map((m) => m[1] ?? ''),
    );
    expect(body).toMatch(/private\.check_display_name\(/);
    raised.add('invalid_display_name');
    expect([...raised].sort()).toEqual([...JOIN_ROOM_ERRORS].sort());
  });

  it('parses room_limits, in-lists and v_type assignments', () => {
    const files = [
      {
        name: '1.sql',
        sql: `create function private.room_limits() returns jsonb language sql as $$
                select jsonb_build_object('max_players', 8, 'present_s', 30) $$;
              create function private.room_broadcast(p_event public.room_events) returns jsonb
              language plpgsql as $$ begin
                if p_event.type in ('a', 'b') then v_type := 'member';
                elsif p_event.type in ('c') then v_type := 'room';
                else v_type := 'sync'; end if; end $$;`,
      },
    ];
    expect(roomLimitsFromMigrations(files)).toEqual({ max_players: 8, present_s: 30 });
    const body = lastPrivateFunctionBody(files, 'room_broadcast', { anyArgs: true }) ?? '';
    expect(assignedTypes(body)).toEqual(['member', 'room', 'sync']);
    expect(inList(body, /\bif\s+p_event\.type\b/i)).toEqual(['a', 'b']);
    expect(inList(body, /\belsif\s+p_event\.type\b/i)).toEqual(['c']);
  });
});

// ─── REVEAL and VOTING (T-019) ────────────────────────────────────────────────────────

/**
 * The rows of the last `insert into public.vote_categories (...) values ...` across the
 * migrations, as objects keyed by the column list.
 */
function voteCategorySeed(files: readonly { name: string; sql: string }[]) {
  const pattern =
    /\binsert\s+into\s+(?:public\.)?vote_categories\s*\(([^)]*)\)\s*values\s*([\s\S]*?)(?:\bon\s+conflict\b|;)/gi;
  const item = String.raw`(?:${LITERAL}|\d+)`;
  const tuple = new RegExp(String.raw`\(\s*(${item}(?:\s*,\s*${item})*)\s*\)`, 'g');
  const value = new RegExp(item, 'g');
  let rows: Record<string, string | number>[] | null = null;
  for (const { sql } of files) {
    for (const match of stripSqlComments(sql).matchAll(pattern)) {
      const columns = (match[1] ?? '').split(',').map((c) => c.trim());
      rows = [...(match[2] ?? '').matchAll(tuple)].map((t) => {
        const values = [...(t[1] ?? '').matchAll(value)].map((v) =>
          v[0].startsWith("'") ? unquote(v[0]) : Number(v[0]),
        );
        return Object.fromEntries(columns.map((c, i) => [c, values[i] ?? '']));
      });
    }
  }
  return rows;
}

/** `private.reveal_vote_limits()`: every `'<key>', <integer>` pair. */
function revealVoteLimitsFromMigrations(files: readonly { name: string; sql: string }[]) {
  const body = lastPrivateFunctionBody(files, 'reveal_vote_limits');
  if (body === null) return null;
  const limits: Record<string, number> = {};
  for (const match of body.matchAll(/'([a-z_]+)'\s*,\s*(\d+)/g)) {
    limits[match[1] ?? ''] = Number(match[2]);
  }
  return limits;
}

/**
 * The `(n, seconds)` pairs of the reference table in the pgTAP test: the first
 * `$$ values (...) $$` after the marker comment `-- reveal-slot reference table`.
 */
function revealSlotTable(sql: string): [number, number][] {
  const at = sql.indexOf('-- reveal-slot reference table');
  if (at === -1) return [];
  const values = /\$\$\s*values\s*([^$]*)\$\$/i.exec(sql.slice(at))?.[1] ?? '';
  return [...values.matchAll(/\(\s*(\d+)\s*,\s*(\d+)\s*\)/g)].map((m) => [
    Number(m[1]),
    Number(m[2]),
  ]);
}

describe('schema drift: reveal and voting', () => {
  it('VOTE_CATEGORIES matches the public.vote_categories seed', () => {
    const seed = voteCategorySeed(readMigrations());
    expect(seed, 'no insert into public.vote_categories found').not.toBeNull();
    expect(seed).toEqual(
      VOTE_CATEGORIES.map((c) => ({
        slug: c.slug,
        label: c.label,
        description: c.description,
        sort_order: c.sortOrder,
      })),
    );
  });

  it('the REVEAL and VOTING limits match private.reveal_vote_limits()', () => {
    expect(revealVoteLimitsFromMigrations(readMigrations())).toEqual({
      reveal_total_s: REVEAL_TOTAL_SECONDS,
      reveal_slot_min_s: REVEAL_SLOT_MIN_SECONDS,
      reveal_slot_max_s: REVEAL_SLOT_MAX_SECONDS,
      voting_min_s: VOTING_MIN_SECONDS,
      voting_max_s: VOTING_MAX_SECONDS,
    });
  });

  it('revealSlotSeconds matches the table private.reveal_slot_seconds is tested against', () => {
    const table = revealSlotTable(readFileSync(REVEAL_VOTE_TEST, 'utf8'));
    expect(table.length, `no reveal-slot reference table in ${REVEAL_VOTE_TEST}`).toBeGreaterThan(
      8,
    );
    for (const [n, seconds] of table) expect(revealSlotSeconds(n), `n = ${n}`).toBe(seconds);
  });

  it('private.reveal_slot_seconds rounds (and neither floors nor truncates)', () => {
    const body = lastPrivateFunctionBody(readMigrations(), 'reveal_slot_seconds', {
      anyArgs: true,
    });
    expect(body, 'private.reveal_slot_seconds not found').not.toBeNull();
    expect(body).toMatch(/\bround\s*\(/i);
    expect(body).not.toMatch(/\b(floor|ceil|ceiling|trunc)\s*\(/i);
  });

  it('parses the category seed and the slot table', () => {
    const files = [
      {
        name: '1.sql',
        sql: `insert into public.vote_categories (slug, label, sort_order) values
                ('a', 'It''s A', 10), -- first
                ('b', 'B', 20)
              on conflict (slug) do nothing;`,
      },
    ];
    expect(voteCategorySeed(files)).toEqual([
      { slug: 'a', label: "It's A", sort_order: 10 },
      { slug: 'b', label: 'B', sort_order: 20 },
    ]);
    expect(
      revealSlotTable(`-- reveal-slot reference table
        select results_eq($$ select 1 $$, $$ values (0, 60), (7, 43) $$, 'x');`),
    ).toEqual([
      [0, 60],
      [7, 43],
    ]);
  });
});
