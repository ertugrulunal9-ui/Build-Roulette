/**
 * Object names (docs/05 §5.5, supabase/migrations/20261004120200_storage.sql).
 *
 *   ephemeral-builds/{battle}/{uid}/source.json | bundle.js | bundle.css | thumb.webp
 *   ephemeral-builds/{battle}/{uid}/autosave/source.json | autosave/bundle.js | autosave/bundle.css
 *   screenshots/{battle}/{build}.webp
 *
 * Every id is checked to be a canonical UUID before it goes into a path, so a bad row can
 * never turn into a prefix like `/` or `..`.
 */
import { isUuid, type BuildRow } from './backend';

export interface BuildSources {
  /** Where the frozen bundle lives: `shipped` uses the final files, `auto_shipped` the autosave. */
  kind: 'shipped' | 'autosave';
  js: string;
  /**
   * The CSS file. Optional in both cases: a build without CSS has none, and autosaves made
   * before the `autosave/bundle.css` slot existed (T-014) have none either.
   */
  css: string;
  source: string;
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
    return {
      kind: 'shipped',
      js: `${base}bundle.js`,
      css: `${base}bundle.css`,
      source: `${base}source.json`,
      thumb: `${base}thumb.webp`,
    };
  }
  if (build.status === 'auto_shipped') {
    return {
      kind: 'autosave',
      js: `${base}autosave/bundle.js`,
      css: `${base}autosave/bundle.css`,
      source: `${base}autosave/source.json`,
      thumb: `${base}thumb.webp`,
    };
  }
  throw new Error(`a ${build.status} build has nothing to capture`);
}

/** `{battle}/{build}.webp` in the `screenshots` bucket (what `complete_capture` expects). */
export function screenshotPath(build: Pick<BuildRow, 'id' | 'battle_id'>): string {
  assertUuid('battle_id', build.battle_id);
  assertUuid('build id', build.id);
  return `${build.battle_id}/${build.id}.webp`;
}

/** The battle's folder in `ephemeral-builds`, with the trailing slash. */
export function battlePrefix(battleId: string): string {
  assertUuid('battle id', battleId);
  return `${battleId}/`;
}
