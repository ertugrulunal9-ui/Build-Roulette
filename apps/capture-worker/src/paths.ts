/**
 * Object names (docs/05 §5.5, docs/09 §9.4, supabase/migrations/20261016120000_import_mode.sql).
 *
 *   ephemeral-builds/{battle}/{uid}/site.bin | thumb.webp      (SHIP)
 *   ephemeral-builds/{battle}/{uid}/autosave/site.bin          (every import during BUILD)
 *   screenshots/{battle}/{build}.webp
 *
 * Every id is checked to be a canonical UUID before it goes into a path, so a bad row can
 * never turn into a prefix like `/` or `..`.
 */
import { isUuid, type BuildRow } from './backend';

export interface BuildSources {
  /** Where the frozen site lives: `shipped` uses the final pack, `auto_shipped` the autosave. */
  kind: 'shipped' | 'autosave';
  /** The site pack (`@br/site`), one object. */
  site: string;
  /** The client thumbnail (fallback), if the client uploaded one. */
  thumb: string;
}

function assertUuid(what: string, id: string): void {
  if (!isUuid(id)) throw new Error(`${what} is not a canonical UUID`);
}

export function buildSources(
  build: Pick<BuildRow, 'battle_id' | 'builder_id' | 'status'>,
): BuildSources {
  assertUuid('battle_id', build.battle_id);
  assertUuid('builder_id', build.builder_id);
  const base = `${build.battle_id}/${build.builder_id}/`;
  if (build.status === 'shipped') {
    return { kind: 'shipped', site: `${base}site.bin`, thumb: `${base}thumb.webp` };
  }
  if (build.status === 'auto_shipped') {
    return { kind: 'autosave', site: `${base}autosave/site.bin`, thumb: `${base}thumb.webp` };
  }
  throw new Error(`a ${build.status} build has nothing to capture`);
}

/** `{battle}/{build}.webp` in the `screenshots` bucket (what `complete_capture` expects). */
export function screenshotPath(build: Pick<BuildRow, 'id' | 'battle_id'>): string {
  assertUuid('battle_id', build.battle_id);
  assertUuid('build id', build.id);
  return `${build.battle_id}/${build.id}.webp`;
}

/** The battle's folder in `screenshots`, with the trailing slash. */
export function screenshotPrefix(battleId: string): string {
  assertUuid('battle id', battleId);
  return `${battleId}/`;
}

/**
 * True for an entry name (relative to {@link screenshotPrefix}) that is a screenshot of the
 * build: `{build}.webp`, `{build}.png`, or any other `{build}.<ext>` the worker or an
 * operator may have left.
 */
export function isScreenshotOf(buildId: string, name: string): boolean {
  assertUuid('build id', buildId);
  return name.startsWith(`${buildId}.`) && !name.includes('/');
}

/** The battle's folder in `ephemeral-builds`, with the trailing slash. */
export function battlePrefix(battleId: string): string {
  assertUuid('battle id', battleId);
  return `${battleId}/`;
}
