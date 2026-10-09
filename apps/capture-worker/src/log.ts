/**
 * Structured logs: one JSON object per line on stdout (`{"t", "level", "msg", ...fields}`),
 * so a log drain can index the fields. Never log secrets or signed URLs (they carry tokens).
 *
 * `onError` sees every `error` line (with the child loggers' fields): main.ts sends those to
 * Sentry when a DSN is configured (reporting.ts, T-030).
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** A logger that adds `fields` to every line. */
  child(fields: LogFields): Logger;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function isLogLevel(s: string): s is LogLevel {
  return s in ORDER;
}

export function createLogger(
  opts: {
    level?: LogLevel;
    write?: (line: string) => void;
    now?: () => Date;
    base?: LogFields;
    /** Called for every `error` line (after it is written). Must not throw. */
    onError?: (msg: string, fields: LogFields) => void;
  } = {},
): Logger {
  const min = ORDER[opts.level ?? 'info'];
  const write =
    opts.write ??
    ((line: string) => {
      // Node: stdout. Elsewhere (the Edge Function passes its own `write`): the console.
      if (typeof process === 'undefined') console.log(line);
      else process.stdout.write(`${line}\n`);
    });
  const now = opts.now ?? (() => new Date());
  const base = opts.base ?? {};
  const emit = (level: LogLevel, msg: string, fields?: LogFields) => {
    if (ORDER[level] < min) return;
    let line: string;
    try {
      line = JSON.stringify({ t: now().toISOString(), level, msg, ...base, ...fields });
    } catch {
      line = JSON.stringify({ t: now().toISOString(), level, msg, ...base, unserializable: true });
    }
    write(line);
    if (level === 'error' && opts.onError) {
      try {
        opts.onError(msg, { ...base, ...fields });
      } catch {
        // Reporting never breaks the worker.
      }
    }
  };
  return {
    debug: (m, f) => {
      emit('debug', m, f);
    },
    info: (m, f) => {
      emit('info', m, f);
    },
    warn: (m, f) => {
      emit('warn', m, f);
    },
    error: (m, f) => {
      emit('error', m, f);
    },
    child: (fields) => createLogger({ ...opts, base: { ...base, ...fields } }),
  };
}

/** A logger that drops everything (tests). */
export const silentLogger: Logger = createLogger({
  write: () => undefined,
});

/** Short error text for logs and `fail_job` (no stack). */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
