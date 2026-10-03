/**
 * Message schemas for the app <-> sandbox shell bridge (docs/03-sandbox.md §3.5).
 *
 * Uses `zod/mini` (functional API, tree-shakes well) because these schemas are bundled
 * into the sandbox shell, whose JS budget is ~5 KB of our own code plus validation.
 *
 * Channels:
 * - window.postMessage, shell -> app: `hello` only.
 * - window.postMessage, app -> shell: `connect` only (carries the MessagePort + nonce).
 * - MessagePort, both ways: everything else.
 */
import * as z from 'zod/mini';
import { LIMITS } from './limits';

/** Bumped on any breaking change. The shell is served from `/v{PROTOCOL_VERSION}/`. */
export const PROTOCOL_VERSION = 1;

const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/;
const URL_RE = /^https?:\/\/[^\s]+$/;

const requestId = z.optional(z.int().check(z.nonnegative()));
const boundedString = (max: number) => z.string().check(z.maxLength(max));

// ---------------------------------------------------------------------------
// Handshake
// ---------------------------------------------------------------------------

/** shell -> app (window.postMessage, targetOrigin = app origin). */
export const HelloSchema = z.object({
  type: z.literal('hello'),
  protocol: z.int().check(z.positive()),
});

/** app -> shell (window.postMessage, transfers port2 of a fresh MessageChannel). */
export const ConnectSchema = z.object({
  type: z.literal('connect'),
  protocol: z.int().check(z.positive()),
  nonce: z.string().check(z.regex(NONCE_RE)),
});

/** shell -> app, first message on the port: proves the port reached the shell that got `connect`. */
export const ConnectedSchema = z.object({
  type: z.literal('connected'),
  nonce: z.string().check(z.regex(NONCE_RE)),
});

// ---------------------------------------------------------------------------
// app -> shell (port)
// ---------------------------------------------------------------------------

const importMapEntries = z
  .record(
    boundedString(LIMITS.importMapValueMaxChars),
    z.string().check(z.maxLength(LIMITS.importMapValueMaxChars), z.regex(URL_RE)),
  )
  .check(
    z.refine(
      (r) => Object.keys(r).length <= LIMITS.importMapMaxEntries,
      'too many import map entries',
    ),
  );

export const ImportMapSchema = z.object({
  imports: importMapEntries,
  scopes: z.optional(
    z
      .record(
        z.string().check(z.maxLength(LIMITS.importMapValueMaxChars), z.regex(URL_RE)),
        importMapEntries,
      )
      .check(
        z.refine(
          (r) => Object.keys(r).length <= LIMITS.importMapMaxEntries,
          'too many import map scopes',
        ),
      ),
  ),
});

export const RunModeSchema = z.enum(['live', 'reveal', 'capture']);

export const LoadSchema = z.object({
  type: z.literal('load'),
  /** Correlates the `ready` reply with this load. */
  loadId: z.int().check(z.nonnegative()),
  js: boundedString(LIMITS.bundleJsMaxChars),
  css: boundedString(LIMITS.bundleCssMaxChars),
  importMap: ImportMapSchema,
  mode: RunModeSchema,
});

export const ResetStorageSchema = z.object({
  type: z.literal('reset-storage'),
  requestId,
});

/** Schema only in M1: the client thumbnail is not implemented yet. */
export const CaptureThumbnailSchema = z.object({
  type: z.literal('capture-thumbnail'),
  requestId,
  width: z.int().check(z.positive(), z.lte(4096)),
  height: z.int().check(z.positive(), z.lte(4096)),
});

export const PingSchema = z.object({
  type: z.literal('ping'),
  t: z.optional(z.number()),
});

export const AppToShellSchema = z.discriminatedUnion('type', [
  LoadSchema,
  ResetStorageSchema,
  CaptureThumbnailSchema,
  PingSchema,
]);

// ---------------------------------------------------------------------------
// shell -> app (port, except `hello`)
// ---------------------------------------------------------------------------

export const ReadySchema = z.object({
  type: z.literal('ready'),
  /** The `loadId` of the load that finished evaluating. */
  loadId: z.int().check(z.nonnegative()),
});

export const HeartbeatSchema = z.object({
  type: z.literal('heartbeat'),
  t: z.optional(z.number()),
});

export const ConsoleLevelSchema = z.enum(['log', 'info', 'warn', 'error', 'debug']);

export const ConsoleSchema = z.object({
  type: z.literal('console'),
  level: ConsoleLevelSchema,
  args: z.array(boundedString(LIMITS.consoleArgMaxChars)).check(z.maxLength(LIMITS.consoleMaxArgs)),
});

export const RuntimeErrorKindSchema = z.enum(['error', 'unhandledrejection', 'module-load']);

export const RuntimeErrorSchema = z.object({
  type: z.literal('runtime-error'),
  message: boundedString(LIMITS.errorMessageMaxChars),
  stack: z.optional(boundedString(LIMITS.errorStackMaxChars)),
  kind: z.optional(RuntimeErrorKindSchema),
});

/** Ack for `reset-storage`. */
export const StorageResetSchema = z.object({
  type: z.literal('storage-reset'),
  requestId,
  ok: z.boolean(),
  errors: z.optional(
    z
      .array(boundedString(LIMITS.errorMessageMaxChars))
      .check(z.maxLength(LIMITS.storageResetMaxErrors)),
  ),
});

/** Schema only in M1. */
export const ThumbnailSchema = z.object({
  type: z.literal('thumbnail'),
  requestId,
  webp: z
    .string()
    .check(z.maxLength(LIMITS.thumbnailMaxChars), z.startsWith('data:image/webp;base64,')),
});

export const ShellToAppSchema = z.discriminatedUnion('type', [
  HelloSchema,
  ConnectedSchema,
  ReadySchema,
  HeartbeatSchema,
  ConsoleSchema,
  RuntimeErrorSchema,
  StorageResetSchema,
  ThumbnailSchema,
]);

export type Hello = z.infer<typeof HelloSchema>;
export type Connect = z.infer<typeof ConnectSchema>;
export type Connected = z.infer<typeof ConnectedSchema>;
export type ImportMap = z.infer<typeof ImportMapSchema>;
export type RunMode = z.infer<typeof RunModeSchema>;
export type LoadMessage = z.infer<typeof LoadSchema>;
export type ResetStorageMessage = z.infer<typeof ResetStorageSchema>;
export type CaptureThumbnailMessage = z.infer<typeof CaptureThumbnailSchema>;
export type PingMessage = z.infer<typeof PingSchema>;
export type AppToShell = z.infer<typeof AppToShellSchema>;
export type ReadyMessage = z.infer<typeof ReadySchema>;
export type HeartbeatMessage = z.infer<typeof HeartbeatSchema>;
export type ConsoleLevel = z.infer<typeof ConsoleLevelSchema>;
export type ConsoleMessage = z.infer<typeof ConsoleSchema>;
export type RuntimeErrorKind = z.infer<typeof RuntimeErrorKindSchema>;
export type RuntimeErrorMessage = z.infer<typeof RuntimeErrorSchema>;
export type StorageResetMessage = z.infer<typeof StorageResetSchema>;
export type ThumbnailMessage = z.infer<typeof ThumbnailSchema>;
export type ShellToApp = z.infer<typeof ShellToAppSchema>;

// ---------------------------------------------------------------------------
// Parsing (never throws)
// ---------------------------------------------------------------------------

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function parseWith<T>(schema: z.ZodMiniType<T>, data: unknown): ParseResult<T> {
  try {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      return { ok: false, error: 'message must be a plain object' };
    }
    const r = schema.safeParse(data);
    if (r.success) return { ok: true, value: r.data };
    const issue = r.error.issues[0];
    const where = issue && issue.path.length > 0 ? issue.path.map(String).join('.') + ': ' : '';
    return { ok: false, error: `${where}${issue?.message ?? 'invalid message'}` };
  } catch (e) {
    // Hostile inputs (proxies, throwing getters) must never escape as exceptions.
    return { ok: false, error: `validation threw: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Validates a message received by the shell on the port. */
export function parseAppToShell(data: unknown): ParseResult<AppToShell> {
  return parseWith(AppToShellSchema, data);
}

/** Validates a message received by the app (window `hello`, or anything on the port). */
export function parseShellToApp(data: unknown): ParseResult<ShellToApp> {
  return parseWith(ShellToAppSchema, data);
}

/** Validates the window-level `connect` message received by the shell. */
export function parseConnect(data: unknown): ParseResult<Connect> {
  return parseWith(ConnectSchema, data);
}

/** Generates a nonce that satisfies the `connect` schema (uses Web Crypto). */
export function createNonce(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}
