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
 *
 * - One winner per vote category (T-022): the `order by` of the ranks and of the category
 *   awards in `private.finalize_votes` must be the count, then `VOTE_TIE_BREAKS`; ranks use
 *   `row_number()` (never shared), awards `distinct on` the category with a count above 0;
 *   and `public.sweep_deadlines` re-checks the early end of VOTING.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BUILD_TIME_LIMITS_MINUTES, DEFAULT_PHASE_DURATIONS } from './durations';
import {
  ADMIN_ERROR_CODES,
  CAST_VOTE_ERRORS,
  JOIN_ROOM_ERRORS,
  REPORT_BUILD_ERRORS,
  RPC_ERROR_CODES,
  SERVICE_ERROR_CODES,
} from './errors';
import { RATE_LIMITS, RATE_LIMIT_ACTIONS, REPORT_DETAILS_MAX, REPORT_REASONS } from './moderation';
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
import {
  RANKING_CATEGORY,
  VOTE_CATEGORIES,
  VOTE_TIE_BREAKS,
  VOTING_MAX_SECONDS,
  VOTING_MIN_SECONDS,
} from './votes';

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
    const known = [...RPC_ERROR_CODES, ...SERVICE_ERROR_CODES, ...ADMIN_ERROR_CODES];
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

  it('JOIN_ROOM_ERRORS lists what join_room answers (plus the display name check and the limit)', () => {
    const files = readMigrations();
    // Since T-024 the body is private.join_room_as; public.join_room wraps it, returns the
    // two "code leads nowhere" failures instead of raising them, and counts them.
    const inner = lastPrivateFunctionBody(files, 'join_room_as', { anyArgs: true });
    const outer = lastPrivateFunctionBody(files, 'join_room', { anyArgs: true, schema: 'public' });
    expect(inner, 'private.join_room_as not found').not.toBeNull();
    expect(outer, 'public.join_room not found').not.toBeNull();
    const raised = new Set(
      [...`${inner ?? ''}\n${outer ?? ''}`.matchAll(/\bmessage\s*=\s*'([a-z_]+)'/g)].map(
        (m) => m[1] ?? '',
      ),
    );
    expect(inner).toMatch(/private\.check_display_name\(/);
    raised.add('invalid_display_name').add('name_not_allowed');
    expect(outer).toMatch(/private\.rate_limit_check\('join_room_failed'/);
    expect(outer).toMatch(/private\.rate_limit_record\('join_room_failed'/);
    raised.add('rate_limited');
    expect(inList(outer ?? '', /\bif\s+v_msg\s+not\b/i)).toEqual(['room_not_found', 'room_closed']);
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

// ─── One winner per vote category, early end in the sweep (T-022) ────────────────────

/** Splits a SQL list on its top-level commas (not those inside parentheses). */
function splitTopLevel(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of list) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p !== '');
}

/**
 * One `order by` term as a key: a category count (`count:overall` for the ranking category,
 * `count:category` for the award's own category), `total_votes`, `shipped_at` or `build_id`,
 * plus ` desc` when descending. Table aliases are dropped; any other expression is kept.
 */
function orderKey(term: string): string {
  const t = term.replace(/\s+/g, ' ').trim().toLowerCase();
  const desc = /\sdesc$/.test(t) ? ' desc' : '';
  const expr = t.replace(/\s(asc|desc)$/, '').replace(/\b[a-z_]+\./g, '');
  const count = /vote_counts ->> (?:'([a-z_]+)'|slug)/.exec(expr);
  if (count) return `count:${count[1] ?? 'category'}${desc}`;
  if (expr === 'total_votes') return `total_votes${desc}`;
  if (expr === 'shipped_at') return `shipped_at${desc}`;
  if (expr === 'id') return `build_id${desc}`;
  return `${expr}${desc}`;
}

/** The ranks' and the awards' `order by` keys in the last `private.finalize_votes`. */
function finalizeVotesOrders(files: readonly { name: string; sql: string }[]) {
  const body = lastPrivateFunctionBody(files, 'finalize_votes', { anyArgs: true });
  if (body === null) return null;
  const rank =
    /\b(row_number|rank|dense_rank)\s*\(\s*\)\s*over\s*\(\s*order\s+by\s+([\s\S]*?)\)\s+as\s+rank\b/i.exec(
      body,
    );
  const awards = /\binsert\s+into\s+public\.awards\b([\s\S]*?);/i.exec(body)?.[1] ?? '';
  const awardOrder = /\border\s+by\s+([\s\S]*)$/i.exec(awards)?.[1] ?? '';
  return {
    rankFunction: rank?.[1]?.toLowerCase() ?? null,
    rank: splitTopLevel(rank?.[2] ?? '').map(orderKey),
    distinctOn: /\bdistinct\s+on\s*\(\s*(?:[a-z_]+\.)?slug\s*\)/i.test(awards),
    positiveOnly: /vote_counts\s*->>\s*(?:[a-z_]+\.)?slug\s*\)\s*::\s*int\s*>\s*0/i.test(awards),
    awards: splitTopLevel(awardOrder).map(orderKey),
  };
}

const TIE_BREAK_KEYS = VOTE_TIE_BREAKS.map((k) => (k === 'total_votes' ? 'total_votes desc' : k));

describe('schema drift: vote ranks and awards (T-022)', () => {
  it('private.finalize_votes ranks by Best Build, then VOTE_TIE_BREAKS, with no shared ranks', () => {
    const orders = finalizeVotesOrders(readMigrations());
    expect(orders, 'private.finalize_votes not found').not.toBeNull();
    expect(orders?.rankFunction).toBe('row_number');
    expect(orders?.rank).toEqual([`count:${RANKING_CATEGORY} desc`, ...TIE_BREAK_KEYS]);
  });

  it('private.finalize_votes gives one award per category (count > 0), then VOTE_TIE_BREAKS', () => {
    const orders = finalizeVotesOrders(readMigrations());
    expect(orders?.distinctOn, 'distinct on the category').toBe(true);
    expect(orders?.positiveOnly, 'no award for a category nobody voted in').toBe(true);
    // The category itself first (distinct on), then its count, then the tie-breaks.
    expect(orders?.awards).toEqual(['slug', 'count:category desc', ...TIE_BREAK_KEYS]);
  });

  it('public.sweep_deadlines re-checks the early end of VOTING', () => {
    const body = lastPrivateFunctionBody(readMigrations(), 'sweep_deadlines', { schema: 'public' });
    expect(body, 'public.sweep_deadlines not found').not.toBeNull();
    expect(body).toMatch(/phase\s*=\s*'voting'\s+and\s+private\.all_present_voted\s*\(/i);
  });

  it('parses the order by clauses', () => {
    const files = [
      {
        name: '1.sql',
        sql: `create or replace function private.finalize_votes(p uuid) returns void language plpgsql
              as $$ begin
                update public.builds bu set final_rank = r.rank from (
                  select id, rank() over (order by coalesce((vote_counts ->> 'overall')::int, 0) desc,
                                                   total_votes desc, shipped_at) as rank from public.builds) r;
                insert into public.awards (battle_id) select distinct on (c.slug) 1
                  from public.builds bu, public.vote_categories c
                  where (bu.vote_counts ->> c.slug)::int > 0
                  order by c.slug, (bu.vote_counts ->> c.slug)::int desc, bu.id;
              end $$;`,
      },
    ];
    expect(finalizeVotesOrders(files)).toEqual({
      rankFunction: 'rank',
      rank: ['count:overall desc', 'total_votes desc', 'shipped_at'],
      distinctOn: true,
      positiveOnly: true,
      awards: ['slug', 'count:category desc', 'build_id'],
    });
  });
});

// ─── Moderation (T-024) ───────────────────────────────────────────────────────────────

/** The rows of the last `insert into private.rate_limits (...) values ...`. */
function rateLimitSeed(files: readonly { name: string; sql: string }[]) {
  const pattern =
    /\binsert\s+into\s+private\.rate_limits\s*\(([^)]*)\)\s*values\s*([\s\S]*?)(?:\bon\s+conflict\b|;)/gi;
  let rows: Record<string, { max: number; windowSeconds: number }> | null = null;
  for (const { sql } of files) {
    for (const match of stripSqlComments(sql).matchAll(pattern)) {
      const columns = (match[1] ?? '').split(',').map((c) => c.trim());
      const ia = columns.indexOf('action');
      const im = columns.indexOf('max_count');
      const iw = columns.indexOf('window_s');
      rows = {};
      for (const t of (match[2] ?? '').matchAll(new RegExp(String.raw`\(([^()]*)\)`, 'g'))) {
        const values = [...(t[1] ?? '').matchAll(new RegExp(String.raw`${LITERAL}|\d+`, 'g'))].map(
          (v) => v[0],
        );
        const action = unquote(values[ia] ?? "''");
        rows[action] = { max: Number(values[im]), windowSeconds: Number(values[iw]) };
      }
    }
  }
  return rows;
}

/** The quoted values of the `reason in (...)` check in `create table public.reports`. */
function reportReasonCheck(files: readonly { name: string; sql: string }[]): string[] {
  for (const { sql } of files) {
    const at = /\bcreate\s+table\s+public\.reports\b/i.exec(stripSqlComments(sql));
    if (!at) continue;
    const table = stripSqlComments(sql).slice(at.index);
    return inList(table, /\breason\b[^,]*\bcheck\s*\(\s*reason\b/i);
  }
  return [];
}

describe('schema drift: moderation (T-024)', () => {
  it('REPORT_REASONS matches the reports check constraint and report_build', () => {
    const files = readMigrations();
    expect(reportReasonCheck(files)).toEqual([...REPORT_REASONS]);
    const body = lastPrivateFunctionBody(files, 'report_build', {
      anyArgs: true,
      schema: 'public',
    });
    expect(body, 'public.report_build not found').not.toBeNull();
    expect(inList(body ?? '', /\bp_reason\s+not\b/i)).toEqual([...REPORT_REASONS]);
    expect(body).toContain(`char_length(v_details) > ${String(REPORT_DETAILS_MAX)}`);
  });

  it('REPORT_BUILD_ERRORS lists what public.report_build raises (besides not_authenticated)', () => {
    const body = lastPrivateFunctionBody(readMigrations(), 'report_build', {
      anyArgs: true,
      schema: 'public',
    });
    const raised = new Set(
      [...(body ?? '').matchAll(/\bmessage\s*=\s*'([a-z_]+)'/g)].map((m) => m[1] ?? ''),
    );
    expect(body).toMatch(/private\.require_auth\(\)/);
    expect(body).toMatch(/private\.rate_limit\('report_build'/);
    raised.add('rate_limited');
    expect([...raised].sort()).toEqual([...REPORT_BUILD_ERRORS].sort());
  });

  it('RATE_LIMITS matches the private.rate_limits seed', () => {
    const seed = rateLimitSeed(readMigrations());
    expect(seed, 'no insert into private.rate_limits found').not.toBeNull();
    expect(Object.keys(seed ?? {}).sort()).toEqual([...RATE_LIMIT_ACTIONS].sort());
    expect(seed).toEqual(RATE_LIMITS);
  });

  it('each limited RPC applies its limit, and the names go through the filter', () => {
    const files = readMigrations();
    const pub = (name: string) =>
      lastPrivateFunctionBody(files, name, { anyArgs: true, schema: 'public' }) ?? '';
    expect(pub('create_room')).toMatch(/private\.rate_limit\('create_room'/);
    expect(pub('start_solo_battle')).toMatch(/private\.rate_limit\('start_solo_battle'/);
    expect(pub('cast_vote')).toMatch(/private\.rate_limit\('cast_vote'/);
    expect(pub('report_build')).toMatch(/private\.rate_limit\('report_build'/);
    expect(pub('create_room')).toMatch(/private\.check_display_name\(/);
    expect(pub('start_solo_battle')).toMatch(/private\.check_display_name\(/);
    expect(pub('ship_build')).toMatch(/private\.check_name_allowed\(v_name, 'build'\)/);
    const check = lastPrivateFunctionBody(files, 'check_display_name', { anyArgs: true }) ?? '';
    expect(check).toMatch(/private\.check_name_allowed\(v_name, 'display'\)/);
  });

  it('parses the rate limit seed and the reason check', () => {
    const files = [
      {
        name: '1.sql',
        sql: `create table public.reports (
                reason text not null check (reason in ('a', 'b')), -- the reasons
                status text not null check (status in ('x')));
              insert into private.rate_limits (action, max_count, window_s, label) values
                ('one', 10, 3600, 'ones'), -- first
                ('two', 2, 60, 'it''s')
              on conflict (action) do nothing;`,
      },
    ];
    expect(reportReasonCheck(files)).toEqual(['a', 'b']);
    expect(rateLimitSeed(files)).toEqual({
      one: { max: 10, windowSeconds: 3600 },
      two: { max: 2, windowSeconds: 60 },
    });
  });
});
