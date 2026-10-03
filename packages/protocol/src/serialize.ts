/**
 * Serialization helpers used by the sandbox shell before it posts to the app.
 * They turn arbitrary user values into bounded strings and never throw.
 */
import { LIMITS, truncate } from './limits';

const MAX_DEPTH = 3;
const MAX_KEYS = 30;

function describeNode(v: { nodeName?: unknown; id?: unknown; className?: unknown }): string {
  const name = typeof v.nodeName === 'string' ? v.nodeName.toLowerCase() : 'node';
  const id = typeof v.id === 'string' && v.id ? `#${v.id}` : '';
  const cls =
    typeof v.className === 'string' && v.className
      ? `.${v.className.trim().split(/\s+/).join('.')}`
      : '';
  return `<${name}${id}${cls}>`;
}

function formatError(e: Error): string {
  const head = `${e.name || 'Error'}: ${e.message}`;
  return typeof e.stack === 'string' && e.stack.includes(e.message)
    ? e.stack
    : `${head}${e.stack ? `\n${e.stack}` : ''}`;
}

function formatValue(
  v: unknown,
  depth: number,
  seen: WeakSet<object>,
  budget: { left: number },
): string {
  if (budget.left <= 0) return '…';
  switch (typeof v) {
    case 'string':
      return depth === 0 ? v : JSON.stringify(v);
    case 'number':
    case 'boolean':
    case 'undefined':
      return String(v);
    case 'bigint':
      return `${v}n`;
    case 'symbol':
      return v.toString();
    case 'function':
      return `[Function ${v.name || 'anonymous'}]`;
    default:
      break;
  }
  if (v === null) return 'null';
  const obj = v as object;
  if (seen.has(obj)) return '[Circular]';
  if (obj instanceof Error) return formatError(obj);
  if (typeof (obj as { nodeType?: unknown }).nodeType === 'number' && 'nodeName' in obj) {
    return describeNode(obj);
  }
  if (depth >= MAX_DEPTH) return Array.isArray(obj) ? '[Array]' : '[Object]';
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      const parts: string[] = [];
      for (let i = 0; i < obj.length && i < MAX_KEYS; i++) {
        const s = formatValue(obj[i], depth + 1, seen, budget);
        budget.left -= s.length;
        parts.push(s);
      }
      if (obj.length > MAX_KEYS) parts.push(`… ${obj.length - MAX_KEYS} more`);
      return `[${parts.join(', ')}]`;
    }
    if (obj instanceof Map) return `Map(${obj.size})`;
    if (obj instanceof Set) return `Set(${obj.size})`;
    if (obj instanceof Date)
      return Number.isNaN(obj.getTime()) ? 'Invalid Date' : obj.toISOString();
    if (obj instanceof RegExp) return String(obj);
    if (obj instanceof Promise) return 'Promise';
    const keys = Object.keys(obj);
    const parts: string[] = [];
    for (const k of keys.slice(0, MAX_KEYS)) {
      let val: string;
      try {
        val = formatValue((obj as Record<string, unknown>)[k], depth + 1, seen, budget);
      } catch {
        val = '[Throws]';
      }
      const entry = `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${val}`;
      budget.left -= entry.length;
      parts.push(entry);
    }
    if (keys.length > MAX_KEYS) parts.push(`… ${keys.length - MAX_KEYS} more`);
    const ctor = (obj as { constructor?: { name?: unknown } }).constructor;
    const prefix =
      ctor && typeof ctor.name === 'string' && ctor.name !== 'Object' ? `${ctor.name} ` : '';
    return `${prefix}{${parts.join(', ')}}`;
  } finally {
    seen.delete(obj);
  }
}

/** Serializes one value to a bounded string. Never throws. */
export function serializeValue(v: unknown, maxChars: number = LIMITS.consoleArgMaxChars): string {
  try {
    return truncate(formatValue(v, 0, new WeakSet(), { left: maxChars * 2 }), maxChars);
  } catch (e) {
    try {
      return truncate(`[Unserializable: ${e instanceof Error ? e.message : String(e)}]`, maxChars);
    } catch {
      return '[Unserializable]';
    }
  }
}

/** Serializes console arguments within LIMITS. Never throws. */
export function serializeConsoleArgs(args: readonly unknown[]): string[] {
  const max = LIMITS.consoleMaxArgs;
  const out: string[] = [];
  const n = Math.min(args.length, args.length > max ? max - 1 : max);
  for (let i = 0; i < n; i++) out.push(serializeValue(args[i]));
  if (args.length > n) out.push(`… ${args.length - n} more arguments`);
  return out;
}

/** Extracts a bounded `{message, stack}` from any thrown value. Never throws. */
export function describeThrown(reason: unknown): { message: string; stack?: string } {
  try {
    if (
      reason instanceof Error ||
      (typeof reason === 'object' && reason !== null && 'message' in reason)
    ) {
      const r = reason as { name?: unknown; message?: unknown; stack?: unknown };
      const name = typeof r.name === 'string' && r.name ? r.name : 'Error';
      const message = truncate(`${name}: ${String(r.message)}`, LIMITS.errorMessageMaxChars);
      const stack =
        typeof r.stack === 'string' ? truncate(r.stack, LIMITS.errorStackMaxChars) : undefined;
      return stack === undefined ? { message } : { message, stack };
    }
    return { message: serializeValue(reason, LIMITS.errorMessageMaxChars) };
  } catch {
    return { message: '[Unserializable error]' };
  }
}
