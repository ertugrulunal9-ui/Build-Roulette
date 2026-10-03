/**
 * Paste-import (docs/03 §3.3): turns one big pasted blob, usually a multi-file answer from
 * an AI chat, into workspace files.
 *
 * Recognized shapes, which can be mixed in one blob:
 *
 * 1. Marker lines, inside or outside code fences:
 *      // file: src/App.tsx      /* file: src/styles.css *\/      <!-- file: index.html -->
 *    (`filename:` and `path:` work too). A file runs until the next marker, or until the
 *    end of the fence the marker is in.
 * 2. A fenced code block preceded by a line naming the file (blank lines in between are
 *    fine):  **src/App.tsx**  /  `src/App.tsx`  /  ### src/App.tsx  /  File: src/App.tsx
 *    /  1. **`src/App.tsx`**  /  "Create `src/App.tsx`:".
 * 3. A file name in the fence info string: ```tsx title="src/App.tsx"  /  ```src/App.tsx
 *    /  ```tsx:src/App.tsx
 * 4. An otherwise unnamed fence whose first line is a comment holding just a path:
 *      // src/App.tsx
 *
 * Paths are normalized (`./src/App.tsx` -> `src/App.tsx`); `..` and absolute paths are
 * rejected and reported. Nothing here touches the workspace; see `importFiles`.
 */
import { normalizeWorkspacePath, type PathErrorReason } from './paths';
import { byteLength } from './limits';
import type { FileMap } from './types';

export type PasteFileSource = 'marker' | 'heading' | 'fence-info' | 'fence-comment';

export interface PastedFile {
  path: string;
  contents: string;
  bytes: number;
  lines: number;
  source: PasteFileSource;
  /** 1-based line of the blob where the file was named. */
  line: number;
  /** Set when a bare file name was mapped onto an existing `src/` file. */
  remappedFrom?: string;
}

export type PasteWarning =
  | { code: 'invalid-path'; raw: string; reason: PathErrorReason; line: number }
  | { code: 'duplicate-path'; path: string; line: number }
  | { code: 'unlabeled-block'; line: number; language: string }
  | { code: 'empty-file'; path: string; line: number }
  | { code: 'unclosed-fence'; line: number };

export interface PasteImportResult {
  /** Parsed files, normalized paths. A later duplicate replaces an earlier one. */
  files: FileMap;
  /** One entry per file in `files`, in blob order. */
  parsed: PastedFile[];
  warnings: PasteWarning[];
}

export interface PasteImportOptions {
  /**
   * Current workspace files. A pasted bare name (`App.tsx`) is mapped to `src/App.tsx` when
   * that file exists and `App.tsx` does not (AI answers often drop the folder).
   */
  existingFiles?: FileMap;
}

export function describePasteWarning(w: PasteWarning): string {
  switch (w.code) {
    case 'invalid-path':
      return `Line ${w.line}: skipped "${w.raw}" (${w.reason === 'absolute' ? 'absolute path' : w.reason === 'parent-segment' ? 'path contains ".."' : `invalid path: ${w.reason}`}).`;
    case 'duplicate-path':
      return `Line ${w.line}: "${w.path}" appears more than once; the last one is used.`;
    case 'unlabeled-block':
      return `Line ${w.line}: a ${w.language ? `${w.language} ` : ''}code block has no file name and was skipped.`;
    case 'empty-file':
      return `Line ${w.line}: "${w.path}" is empty.`;
    case 'unclosed-fence':
      return `Line ${w.line}: a code block is never closed; it runs to the end of the paste.`;
  }
}

/** Extensions that make a token look like a file name (to avoid matching prose like "e.g."). */
const FILE_EXTENSIONS = new Set(
  'ts tsx mts cts js jsx mjs cjs css scss json html htm md mdx txt svg xml csv yml yaml glsl vert frag wgsl png jpg jpeg gif webp avif ico bmp'.split(
    ' ',
  ),
);
const PATH_LIKE = /^\/?(?:[\w@.+-]+\/)*[\w@.+-]*[\w@+-]\.([A-Za-z0-9]+)$/;

/** Does `token` look like a file path with a known extension? (`src/App.tsx`, `/x.ts`, `../a.css`) */
export function looksLikeFilePath(token: string): boolean {
  const m = PATH_LIKE.exec(token);
  return m !== null && FILE_EXTENSIONS.has((m[1] ?? '').toLowerCase());
}

const MARKERS = [
  /^\s*\/\/\s*(?:file(?:name)?|path)\s*:\s*(.+?)\s*$/i,
  /^\s*\/\*+\s*(?:file(?:name)?|path)\s*:\s*(.+?)\s*\*+\/\s*$/i,
  /^\s*<!--\s*(?:file(?:name)?|path)\s*:\s*(.+?)\s*-->\s*$/i,
];
const COMMENT_PATHS = [
  /^\s*\/\/\s*(\S+)\s*$/,
  /^\s*\/\*+\s*(\S+)\s*\*+\/\s*$/,
  /^\s*<!--\s*(\S+)\s*-->\s*$/,
];

function unwrap(raw: string): string {
  return raw.trim().replace(/^[`'"*_]+|[`'"*_]+$/g, '');
}

/** `// file: x` style marker -> raw path, or null. */
function matchMarker(line: string): string | null {
  for (const re of MARKERS) {
    const m = re.exec(line);
    if (m?.[1] !== undefined) {
      const p = unwrap(m[1]);
      if (p !== '' && !/\s/.test(p)) return p;
    }
  }
  return null;
}

/** `// src/App.tsx` (a comment holding only a path) -> raw path, or null. */
function matchCommentPath(line: string): string | null {
  for (const re of COMMENT_PATHS) {
    const m = re.exec(line);
    if (m?.[1] !== undefined) {
      const p = unwrap(m[1]);
      if (looksLikeFilePath(p)) return p;
    }
  }
  return null;
}

function filenameFromInfo(info: string): string | null {
  for (const token of info.trim().split(/\s+/)) {
    if (token === '') continue;
    const attr = /^(?:title|file(?:name)?|path)=["']?([^"']+)["']?$/i.exec(token);
    let candidate = attr?.[1] ?? token;
    if (attr === null && candidate.includes(':'))
      candidate = candidate.slice(candidate.indexOf(':') + 1);
    candidate = unwrap(candidate);
    if (looksLikeFilePath(candidate)) return candidate;
  }
  return null;
}

/**
 * A prose line that names exactly one file (`**src/App.tsx**`, `### File: \`a.ts\``,
 * `Create src/App.tsx:`). Returns the raw path or null.
 */
export function filenameFromProseLine(line: string): string | null {
  const text = line.trim();
  if (text === '' || text.length > 200) return null;
  const candidates = new Set<string>();
  for (const m of text.matchAll(/`([^`]+)`/g)) {
    const t = unwrap((m[1] ?? '').replace(/^(?:file(?:name)?|path)\s*:\s*/i, ''));
    if (looksLikeFilePath(t)) candidates.add(t);
  }
  if (candidates.size === 0) {
    const stripped = text
      .replace(/^>\s*/, '')
      .replace(/^#{1,6}\s+/, '')
      .replace(/^(?:[-*+]|\d+[.)])\s+/, '')
      .replace(/\*\*|__/g, ' ');
    for (const raw of stripped.split(/\s+/)) {
      let t = raw.replace(/^(?:file(?:name)?|path):/i, '');
      t = t.replace(/^[(["'*_]+/, '').replace(/[)\]"'*_:;,!?]+$/, '');
      if (!looksLikeFilePath(t)) t = t.replace(/\.+$/, ''); // sentence-ending period
      if (looksLikeFilePath(t)) candidates.add(t);
    }
  }
  if (candidates.size !== 1) return null;
  const [only] = candidates;
  return only ?? null;
}

interface Fence {
  char: '`' | '~';
  length: number;
  indent: number;
  language: string;
  line: number;
  /** A file was started by or inside this fence. */
  named: boolean;
  /** The first non-blank content line has been looked at (comment path rule). */
  checkedFirstLine: boolean;
  hasContent: boolean;
}

interface OpenFile {
  raw: string;
  source: PasteFileSource;
  line: number;
  lines: string[];
  /** Ends with the enclosing fence (otherwise it runs to the next marker). */
  fenceScoped: boolean;
}

const FENCE_OPEN = /^(\s*)(`{3,}|~{3,})(.*)$/;

function openFence(line: string, lineNo: number): Fence | null {
  const m = FENCE_OPEN.exec(line);
  if (!m) return null;
  const marks = m[2] ?? '';
  const info = m[3] ?? '';
  const char = marks.startsWith('~') ? '~' : '`';
  if (char === '`' && info.includes('`')) return null; // inline code, not a fence
  return {
    char,
    length: marks.length,
    indent: (m[1] ?? '').length,
    language: info.trim().split(/\s+/)[0] ?? '',
    line: lineNo,
    named: false,
    checkedFirstLine: false,
    hasContent: false,
  };
}

function closesFence(line: string, fence: Fence): boolean {
  const m = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
  const marks = m?.[1];
  return marks?.startsWith(fence.char) === true && marks.length >= fence.length;
}

function stripIndent(line: string, indent: number): string {
  let i = 0;
  while (i < indent && line[i] === ' ') i++;
  return line.slice(i);
}

function samePath(a: string, b: string): boolean {
  const na = normalizeWorkspacePath(a);
  const nb = normalizeWorkspacePath(b);
  return na.ok && nb.ok && na.path === nb.path;
}

export function parsePasteImport(text: string, opts: PasteImportOptions = {}): PasteImportResult {
  const lines = text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  const warnings: PasteWarning[] = [];
  const parsed: PastedFile[] = [];
  const existing = opts.existingFiles ?? {};

  let fence: Fence | null = null;
  let current: OpenFile | null = null;
  let pendingName: string | null = null;

  const finalize = (file: OpenFile | null) => {
    if (!file) return;
    const body = [...file.lines];
    while (body.length > 0 && (body[0] ?? '').trim() === '') body.shift();
    while (body.length > 0 && (body[body.length - 1] ?? '').trim() === '') body.pop();
    const n = normalizeWorkspacePath(file.raw);
    if (!n.ok) {
      warnings.push({ code: 'invalid-path', raw: file.raw, reason: n.reason, line: file.line });
      return;
    }
    let path = n.path;
    let remappedFrom: string | undefined;
    const has = (p: string) => Object.prototype.hasOwnProperty.call(existing, p);
    if (!path.includes('/') && !has(path) && has(`src/${path}`)) {
      remappedFrom = path;
      path = `src/${path}`;
    }
    const contents = body.length > 0 ? `${body.join('\n')}\n` : '';
    if (contents === '') warnings.push({ code: 'empty-file', path, line: file.line });
    const dup = parsed.findIndex((f) => f.path === path);
    if (dup !== -1) {
      warnings.push({ code: 'duplicate-path', path, line: file.line });
      parsed.splice(dup, 1);
    }
    parsed.push({
      path,
      contents,
      bytes: byteLength(contents),
      lines: body.length,
      source: file.source,
      line: file.line,
      ...(remappedFrom !== undefined ? { remappedFrom } : {}),
    });
  };

  lines.forEach((line, index) => {
    const lineNo = index + 1;

    if (fence) {
      if (closesFence(line, fence)) {
        if (current?.fenceScoped) {
          finalize(current);
          current = null;
        } else if (!fence.named && fence.hasContent) {
          warnings.push({ code: 'unlabeled-block', line: fence.line, language: fence.language });
        }
        fence = null;
        pendingName = null;
        return;
      }
      const marker = matchMarker(line);
      if (marker !== null) {
        finalize(current);
        current = { raw: marker, source: 'marker', line: lineNo, lines: [], fenceScoped: true };
        fence.named = true;
        return;
      }
      const content = stripIndent(line, fence.indent);
      if (!fence.checkedFirstLine && line.trim() !== '') {
        fence.checkedFirstLine = true;
        const commentPath = matchCommentPath(line);
        if (current && commentPath !== null && samePath(commentPath, current.raw)) {
          return; // `**src/App.tsx**` + ```tsx + `// src/App.tsx`: drop the repeated name
        }
        if (!current && commentPath !== null) {
          current = {
            raw: commentPath,
            source: 'fence-comment',
            line: lineNo,
            lines: [],
            fenceScoped: true,
          };
          fence.named = true;
          return;
        }
      }
      if (current) current.lines.push(content);
      else if (line.trim() !== '') fence.hasContent = true;
      return;
    }

    const opened = openFence(line, lineNo);
    if (opened) {
      fence = opened;
      const info = /^\s*(?:`{3,}|~{3,})(.*)$/.exec(line)?.[1] ?? '';
      const fromInfo = filenameFromInfo(info);
      const name = fromInfo ?? pendingName;
      pendingName = null;
      if (name !== null) {
        finalize(current);
        current = {
          raw: name,
          source: fromInfo !== null ? 'fence-info' : 'heading',
          line: lineNo,
          lines: [],
          fenceScoped: true,
        };
        fence.named = true;
      } else if (current && !current.fenceScoped && current.lines.every((l) => l.trim() === '')) {
        // `// file: x` on its own line, then a fence holding the code.
        current.fenceScoped = true;
        fence.named = true;
      } else if (current) {
        finalize(current);
        current = null;
      }
      return;
    }

    const marker = matchMarker(line);
    if (marker !== null) {
      finalize(current);
      current = { raw: marker, source: 'marker', line: lineNo, lines: [], fenceScoped: false };
      pendingName = null;
      return;
    }
    if (current && !current.fenceScoped) {
      current.lines.push(line);
      return;
    }
    if (line.trim() !== '') pendingName = filenameFromProseLine(line);
  });

  const openAtEnd = fence as Fence | null;
  if (openAtEnd) warnings.push({ code: 'unclosed-fence', line: openAtEnd.line });
  finalize(current);

  const files: FileMap = {};
  for (const f of parsed) files[f.path] = f.contents;
  return { files, parsed, warnings };
}
