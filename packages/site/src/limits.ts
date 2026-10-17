/**
 * Limits of an imported site (docs/09 §9.2). The pack is stored as one object in the
 * `ephemeral-builds` bucket, whose file size limit is 5 MiB (supabase/migrations, storage),
 * so a pack must fit in it, header included.
 */
export const SITE_LIMITS = {
  /** Largest site pack (header + files), in bytes: the bucket's file size limit. */
  maxPackBytes: 5 * 1024 * 1024,
  /** Most files in one site. */
  maxFiles: 300,
  /** Longest path of a file inside the site, in characters. */
  maxPathChars: 200,
  /** Largest pack header (the JSON file list), in bytes. */
  maxHeaderBytes: 256 * 1024,
  /**
   * Most entries a folder may list while it is read (node_modules and .git are skipped
   * without being listed). Stops a drop of a whole disk from hanging the page.
   */
  maxListedEntries: 20_000,
} as const;
