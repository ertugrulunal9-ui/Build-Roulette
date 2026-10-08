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
 *
 * Trust model (docs/03 §3.9, packages/runtime/README.md "Trust model"): the build runs
 * same-origin with the shell, so it can run code in the shell's realm, use its port and
 * forge any shell -> app message. Every shell -> app message is therefore UNTRUSTED DISPLAY
 * DATA. The app validates it, rate-limits it and may show it, but never takes an action that
 * matters because of it. `ready`, `heartbeat`, `pong` and `storage-reset` are hints only and
 * must never gate capture (decided server-side by the capture worker) or destroy.
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

/**
 * shell -> app (window.postMessage, targetOrigin = app origin). Untrusted: the app accepts
 * exactly one `hello` per iframe navigation it started itself (attach, mode switch, reset,
 * `restart()`); a later one is ignored and counted, never answered with a new port.
 */
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

/**
 * shell -> app, first message on the port: shows the port reached the window that got
 * `connect`. Accepted once per handshake (the nonce is single use).
 */
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
  /**
   * Optional (T-032): the package CDN URLs the bundle imports directly (CDN module URLs, and
   * the import map URLs of the entry points it imports). The shell never loads anything
   * because of this list; it only checks these URLs (then the rest of the import map) to name
   * the package that could not load when the module graph fails or stalls ("Package server
   * unreachable: zustand@5.0.15"). Older shells ignore it.
   */
  packages: z.optional(
    z
      .array(z.string().check(z.maxLength(LIMITS.importMapValueMaxChars), z.regex(URL_RE)))
      .check(z.maxLength(LIMITS.loadPackagesMax)),
  ),
});

export const ResetStorageSchema = z.object({
  type: z.literal('reset-storage'),
  requestId,
});

/** Best-effort client thumbnail of the running build (T-014); the shell may not answer. */
export const CaptureThumbnailSchema = z.object({
  type: z.literal('capture-thumbnail'),
  requestId,
  width: z.int().check(z.positive(), z.lte(4096)),
  height: z.int().check(z.positive(), z.lte(4096)),
});

/**
 * Liveness probe. The shell answers `pong {seq}` from a main-thread task (`setTimeout(0)`),
 * not synchronously in the port listener, so a pong shows that the shell's event loop runs
 * tasks. `seq` is chosen by the app; a pong is only accepted for a `seq` still outstanding.
 */
export const PingSchema = z.object({
  type: z.literal('ping'),
  seq: z.int().check(z.nonnegative()),
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

/**
 * Hint only: the module of load `loadId` finished evaluating. Untrusted (a build can send it
 * early, late or never), so it may update UI state but must never gate capture: capture
 * readiness is decided by the capture worker with a fixed wait and a cap. The app accepts
 * it only for the latest load it sent, once, within a per-second budget.
 */
export const ReadySchema = z.object({
  type: z.literal('ready'),
  /** The `loadId` of the load that finished evaluating. */
  loadId: z.int().check(z.nonnegative()),
});

/**
 * Hint only, informational. Not used for liveness any more (anything holding the port can
 * send it); the watchdog uses `ping`/`pong` round trips. Kept for compatibility.
 */
export const HeartbeatSchema = z.object({
  type: z.literal('heartbeat'),
  t: z.optional(z.number()),
});

/**
 * Hint only: answer to `ping {seq}`, sent from a main-thread task. Best-effort liveness (a
 * build that takes over the shell's realm could answer pongs from elsewhere); the app stays
 * responsive regardless thanks to site isolation.
 */
export const PongSchema = z.object({
  type: z.literal('pong'),
  seq: z.int().check(z.nonnegative()),
});

export const ConsoleLevelSchema = z.enum(['log', 'info', 'warn', 'error', 'debug']);

/** Untrusted display data: shown in the console panel, rate-limited and size-capped by the app. */
export const ConsoleSchema = z.object({
  type: z.literal('console'),
  level: ConsoleLevelSchema,
  args: z.array(boundedString(LIMITS.consoleArgMaxChars)).check(z.maxLength(LIMITS.consoleMaxArgs)),
});

export const RuntimeErrorKindSchema = z.enum(['error', 'unhandledrejection', 'module-load']);

/** Untrusted display data: shown in the error overlay, rate-limited by the app. */
export const RuntimeErrorSchema = z.object({
  type: z.literal('runtime-error'),
  message: boundedString(LIMITS.errorMessageMaxChars),
  stack: z.optional(boundedString(LIMITS.errorStackMaxChars)),
  kind: z.optional(RuntimeErrorKindSchema),
});

/**
 * Hint only: ack for `reset-storage`. A build can forge or suppress it, so destroy never
 * waits for it and nothing that matters depends on `ok`. The real isolation comes from the
 * app recreating the preview iframe and from per-build origins.
 */
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

/** Answer to `capture-thumbnail`. Untrusted display data, like everything else from the shell. */
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
  PongSchema,
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
export type PongMessage = z.infer<typeof PongSchema>;
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
