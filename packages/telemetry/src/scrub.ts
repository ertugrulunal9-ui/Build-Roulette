/**
 * The privacy rules for everything Build Roulette sends to Sentry and PostHog (T-030).
 *
 * What may leave: pseudonymous ids (the hashed anonymous user id, see hash.ts), the random
 * UUIDs of rooms, battles and builds as tags, the phase, the release, route templates, error
 * types and scrubbed error messages, and our own stack frames.
 *
 * What never leaves: display names, build names, room codes, editor contents or any other
 * build code, request bodies, cookies and headers (besides the user agent), query strings,
 * fragments, emails, tokens, and raw user ids. Free text (error messages, log fields) is
 * scrubbed by `scrubText`: URLs lose their query string and fragment and their path becomes
 * a route template (`/r/K7QXM` → `/r/[code]`), UUIDs become `<id>` (a storage path holds the
 * builder's user id; the ids that are allowed travel as tags instead), emails `<email>`,
 * tokens `<token>`, the values of query parameters in partial paths `<value>`, and the text
 * is cut at 500 characters.
 *
 * Plain functions without dependencies, so the browser, Next on Node and on Workers, the
 * capture worker and the package CDN all apply the same rules.
 */
import type { ClientOptions, Event, Exception, StackFrame } from '@sentry/core';

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const UUID_EXACT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g;
const BEARER_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const SUPABASE_KEY_RE = /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]+/g;
const POSTHOG_KEY_RE = /\bph[cx]_[A-Za-z0-9]{8,}/g;
// URLs: up to whitespace, quotes or brackets. Trailing punctuation is put back afterwards.
const URL_RE = /\b(?:https?|wss?|blob|file):\/\/[^\s"'`<>()[\]{}]+/gi;
const DATA_URL_RE = /\bdata:[a-z]+\/[a-z0-9.+-]+[;,][^\s"'`<>()[\]{}]*/gi;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
// A query parameter in text that is not a whole URL (a storage path with `?token=…`).
const QUERY_PARAM_RE = /([?&][A-Za-z0-9_.[\]-]{1,40}=)[^&\s"'`<>#]+/g;
// Long opaque strings (hex secrets, signatures, base64 blobs).
const TOKEN_RE = /\b[A-Za-z0-9_-]{40,}\b/g;

/** Free text (a message, a log field) is cut here. */
export const MAX_TEXT = 500;
/** Sentry's limit for a tag value. */
export const MAX_TAG = 200;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_EXACT.test(value);
}

/**
 * A path as a route template: the room code, user ids and battle ids of the app's dynamic
 * routes become their parameter names, any other UUID `[id]`, any very long segment `[…]`.
 */
export function routeTemplate(pathname: string): string {
  const segs = pathname.split('/');
  const first = segs[1];
  if (segs.length > 2 && segs[2] !== '') {
    if (first === 'r') segs[2] = '[code]';
    else if (first === 'u' || first === 'battles') segs[2] = '[id]';
  }
  return segs.map((s) => (UUID_EXACT.test(s) ? '[id]' : s.length > 64 ? '[…]' : s)).join('/');
}

/**
 * A URL without its query string and fragment, and with a route-template path. A relative
 * path keeps no query either; `blob:` and `data:` URLs (they can hold anything) become a
 * placeholder.
 */
export function scrubUrl(input: string): string {
  const raw = input.trim();
  if (/^blob:/i.test(raw)) return '<blob-url>';
  if (/^data:/i.test(raw)) return '<data-url>';
  if (raw.startsWith('/') && !raw.startsWith('//')) {
    return routeTemplate(raw.split(/[?#]/, 1)[0] ?? '');
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return scrubText(raw.split(/[?#]/, 1)[0] ?? '');
  }
  // Credentials in the authority (user:password@host) are dropped with the rest.
  const origin = u.origin === 'null' ? `${u.protocol}//${u.host}` : u.origin;
  return origin + routeTemplate(u.pathname);
}

function replaceUrls(text: string): string {
  return text.replace(URL_RE, (match) => {
    const trail = /[.,;:!?]+$/.exec(match)?.[0] ?? '';
    const url = trail ? match.slice(0, -trail.length) : match;
    return scrubUrl(url) + trail;
  });
}

/** Free text with the rules above applied (see the file comment), at most `max` characters. */
export function scrubText(text: string, max: number = MAX_TEXT): string {
  let out = text
    .replace(JWT_RE, '<token>')
    .replace(BEARER_RE, '$1 <token>')
    .replace(SUPABASE_KEY_RE, '<key>')
    .replace(POSTHOG_KEY_RE, '<key>')
    .replace(DATA_URL_RE, '<data-url>');
  out = replaceUrls(out)
    .replace(QUERY_PARAM_RE, '$1<value>')
    .replace(EMAIL_RE, '<email>')
    .replace(UUID_RE, '<id>')
    .replace(TOKEN_RE, '<token>');
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

// ─── Sentry events ────────────────────────────────────────────────────────────────────

/**
 * Sentry's `dataCollection` with every category off (it replaces the deprecated
 * `sendDefaultPii: false`): no user info, cookies, headers, bodies, query strings, GraphQL or
 * AI payloads, database data, local variables or source lines. `scrubSentryEvent` drops all
 * of these again in case an integration ignores the setting.
 */
export const NO_DATA_COLLECTION = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [],
  urlQueryParams: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
  databaseQueryData: false,
  stackFrameVariables: false,
  frameContextLines: 0,
} satisfies NonNullable<ClientOptions['dataCollection']>;

/** Tags that may be sent. The `*_id` ones must be UUIDs (random ids, never user ids). */
export const ALLOWED_TAGS: readonly string[] = [
  'service',
  'runtime',
  'route',
  'route_type',
  'render_source',
  'phase',
  'mode',
  'room_id',
  'battle_id',
  'build_id',
  'job_id',
  'job_kind',
  'attempt',
  'digest',
  'code',
  'status',
  'source',
  'surface',
  'handled',
  'mechanism',
  'level',
];
const ID_TAGS = new Set(['room_id', 'battle_id', 'build_id']);

/** The hashed user id (hash.ts): 32 lowercase hex characters. */
export const USER_HASH_RE = /^[0-9a-f]{32}$/;

/** Contexts that may be sent (runtime and platform facts); every string in them is scrubbed. */
const ALLOWED_CONTEXTS = new Set(['runtime', 'os', 'browser', 'device', 'app', 'trace']);

function scrubTags(
  tags: Event['tags'],
  allowed: readonly string[],
): Record<string, string | number | boolean> | undefined {
  if (!tags) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(tags)) {
    if (!allowed.includes(key) || value === null || value === undefined) continue;
    if (ID_TAGS.has(key)) {
      if (isUuid(value)) out[key] = value.toLowerCase();
      continue;
    }
    if (typeof value === 'number' || typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'string') out[key] = scrubText(value, MAX_TAG);
  }
  return out;
}

function scrubContextValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return scrubText(value, MAX_TAG);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (depth < 2 && typeof value === 'object' && !Array.isArray(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scrubContextValue(v, depth + 1);
    }
    return out;
  }
  return undefined;
}

function scrubFrame(frame: StackFrame): StackFrame {
  const out: StackFrame = {};
  if (frame.filename !== undefined) out.filename = scrubUrl(frame.filename);
  if (frame.abs_path !== undefined) out.abs_path = scrubUrl(frame.abs_path);
  if (frame.function !== undefined) out.function = frame.function.slice(0, 200);
  if (frame.module !== undefined) out.module = frame.module.slice(0, 200);
  if (frame.lineno !== undefined) out.lineno = frame.lineno;
  if (frame.colno !== undefined) out.colno = frame.colno;
  if (frame.in_app !== undefined) out.in_app = frame.in_app;
  if (frame.platform !== undefined) out.platform = frame.platform;
  if (frame.debug_id !== undefined) out.debug_id = frame.debug_id;
  // No vars and no source context lines.
  return out;
}

/** A frame whose code came from a blob: or data: URL: built (user) code, never ours. */
function isForeignFrame(frame: StackFrame): boolean {
  const file = frame.abs_path ?? frame.filename ?? '';
  return /^(blob|data):/i.test(file);
}

function scrubException(ex: Exception): Exception {
  const out: Exception = {};
  if (ex.type !== undefined) out.type = ex.type.slice(0, 100);
  if (ex.value !== undefined) out.value = scrubText(ex.value);
  const m = ex.mechanism;
  if (m !== undefined) {
    const mechanism: NonNullable<Exception['mechanism']> = { type: m.type };
    if (m.handled !== undefined) mechanism.handled = m.handled;
    if (m.synthetic !== undefined) mechanism.synthetic = m.synthetic;
    if (m.exception_id !== undefined) mechanism.exception_id = m.exception_id;
    if (m.parent_id !== undefined) mechanism.parent_id = m.parent_id;
    if (m.source !== undefined) mechanism.source = m.source;
    out.mechanism = mechanism;
  }
  if (ex.stacktrace?.frames) out.stacktrace = { frames: ex.stacktrace.frames.map(scrubFrame) };
  return out;
}

export interface ScrubEventOptions {
  /** Tag keys that may be sent (default ALLOWED_TAGS). */
  allowedTags?: readonly string[];
}

/**
 * The event as it may be sent, or null to drop it. A new object: unknown fields are left
 * out rather than scrubbed (an allowlist), so a field a future SDK adds cannot leak.
 * Dropped: events whose stack runs through a blob:/data: URL (build code), breadcrumbs,
 * `extra`, request bodies, cookies, headers (but the user agent) and query strings, the
 * server name, the module list, and any user field but a hashed id.
 */
export function scrubSentryEvent<E extends Event>(
  event: E,
  opts: ScrubEventOptions = {},
): E | null {
  const values = event.exception?.values ?? [];
  if (values.some((v) => v.stacktrace?.frames?.some(isForeignFrame))) return null;

  const out: Event = {};
  const keep = [
    'event_id',
    'timestamp',
    'level',
    'platform',
    'release',
    'dist',
    'environment',
    'sdk',
    'type',
    'fingerprint',
    'debug_meta',
  ] as const;
  for (const k of keep) {
    if (event[k] !== undefined) (out as Record<string, unknown>)[k] = event[k];
  }
  if (event.message !== undefined) out.message = scrubText(event.message);
  if (event.logentry?.message !== undefined) {
    out.logentry = { message: scrubText(event.logentry.message) };
  }
  if (event.transaction !== undefined) {
    out.transaction = event.transaction.startsWith('/')
      ? routeTemplate(event.transaction)
      : scrubText(event.transaction, MAX_TAG);
  }
  if (values.length > 0) out.exception = { values: values.map(scrubException) };

  const req = event.request;
  if (req) {
    const request: NonNullable<Event['request']> = {};
    if (req.url !== undefined) request.url = scrubUrl(req.url);
    if (req.method !== undefined) request.method = req.method;
    const ua = req.headers?.['User-Agent'] ?? req.headers?.['user-agent'];
    if (typeof ua === 'string') request.headers = { 'User-Agent': ua.slice(0, 300) };
    out.request = request;
  }

  const userId = event.user?.id;
  if (typeof userId === 'string' && USER_HASH_RE.test(userId)) out.user = { id: userId };

  const tags = scrubTags(event.tags, opts.allowedTags ?? ALLOWED_TAGS);
  if (tags && Object.keys(tags).length > 0) out.tags = tags;

  if (event.contexts) {
    const contexts: NonNullable<Event['contexts']> = {};
    for (const [name, ctx] of Object.entries(event.contexts)) {
      if (!ALLOWED_CONTEXTS.has(name) || ctx === undefined) continue;
      contexts[name] = scrubContextValue(ctx) as Record<string, unknown>;
    }
    if (Object.keys(contexts).length > 0) out.contexts = contexts;
  }
  // Same kind of event as the input (`type` is copied above).
  return out as E;
}
