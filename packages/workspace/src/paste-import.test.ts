import { describe, expect, it } from 'vitest';
import {
  describePasteWarning,
  filenameFromProseLine,
  looksLikeFilePath,
  parsePasteImport,
  type PasteWarning,
} from './paste-import';
import { createWorkspace } from './templates';

const F = '```';

/** A typical multi-file answer from a chat assistant: bold file names above fences. */
const CHAT_BOLD = `Sure! Here's a small todo app split into three files.

**src/App.tsx**

${F}tsx
import { useState } from 'react';
import { TodoList } from './TodoList';

export function App() {
  const [todos, setTodos] = useState<string[]>([]);
  return <TodoList todos={todos} onAdd={(t) => setTodos([...todos, t])} />;
}
${F}

**src/TodoList.tsx**

${F}tsx
export function TodoList({ todos, onAdd }: { todos: string[]; onAdd: (t: string) => void }) {
  return (
    <ul>
      {todos.map((t) => <li key={t}>{t}</li>)}
      <button onClick={() => onAdd('new')}>Add</button>
    </ul>
  );
}
${F}

**src/styles.css**

${F}css
ul {
  list-style: none;
}
${F}

Let me know if you want me to add persistence with \`localStorage\`!
`;

describe('parsePasteImport: chat answers with file names above fences', () => {
  it('parses bold file names', () => {
    const r = parsePasteImport(CHAT_BOLD);
    expect(Object.keys(r.files)).toEqual(['src/App.tsx', 'src/TodoList.tsx', 'src/styles.css']);
    expect(r.files['src/styles.css']).toBe('ul {\n  list-style: none;\n}\n');
    expect(r.files['src/App.tsx']).toMatch(/^import \{ useState \} from 'react';\n/);
    expect(r.files['src/App.tsx']).toMatch(/\}\n$/);
    expect(r.parsed.map((p) => [p.path, p.source, p.line])).toEqual([
      ['src/App.tsx', 'heading', 5],
      ['src/TodoList.tsx', 'heading', 17],
      ['src/styles.css', 'heading', 30],
    ]);
    expect(r.parsed[2]).toMatchObject({ lines: 3, bytes: 27 });
    expect(r.warnings).toEqual([]);
  });

  it('parses markdown headings, backticks, labels and list items', () => {
    const blob = [
      '### `src/main.tsx`',
      `${F}tsx`,
      "import './a';",
      F,
      '#### File: src/a.ts',
      `${F}ts`,
      'export const a = 1;',
      F,
      'Now create `src/b.ts`:',
      '',
      `${F}ts`,
      'export const b = 2;',
      F,
      '1. **`src/c.ts`**',
      `${F}ts`,
      'export const c = 3;',
      F,
      '- src/d.json',
      `${F}json`,
      '{ "d": 4 }',
      F,
      '__src/e.css__',
      `${F}css`,
      'body {}',
      F,
    ].join('\n');
    const r = parsePasteImport(blob);
    expect(r.files).toEqual({
      'src/main.tsx': "import './a';\n",
      'src/a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 2;\n',
      'src/c.ts': 'export const c = 3;\n',
      'src/d.json': '{ "d": 4 }\n',
      'src/e.css': 'body {}\n',
    });
    expect(r.warnings).toEqual([]);
  });

  it('dedents fences nested in list items', () => {
    const blob = [
      '1. **src/App.tsx**',
      '',
      `   ${F}tsx`,
      '   export function App() {',
      '     return <h1>Hi</h1>;',
      '   }',
      `   ${F}`,
      '2. **src/main.tsx**',
      `   ${F}tsx`,
      "   import { App } from './App';",
      `   ${F}`,
    ].join('\n');
    const r = parsePasteImport(blob);
    expect(r.files['src/App.tsx']).toBe('export function App() {\n  return <h1>Hi</h1>;\n}\n');
    expect(r.files['src/main.tsx']).toBe("import { App } from './App';\n");
  });

  it('reads the file name from the fence info string', () => {
    const blob = [
      `${F}tsx title="src/App.tsx"`,
      'export const A = 1;',
      F,
      `${F}src/util.ts`,
      'export const u = 1;',
      F,
      `${F}css:src/x.css`,
      'a {}',
      F,
      `${F}ts filename=src/y.ts`,
      'export {};',
      F,
    ].join('\n');
    const r = parsePasteImport(blob);
    expect(Object.keys(r.files)).toEqual(['src/App.tsx', 'src/util.ts', 'src/x.css', 'src/y.ts']);
    expect(r.parsed.every((p) => p.source === 'fence-info')).toBe(true);
  });

  it('uses a leading path comment inside an unnamed fence', () => {
    const blob = [
      'Here you go:',
      `${F}tsx`,
      '// src/components/Button.tsx',
      'export function Button() {',
      '  return <button>ok</button>;',
      '}',
      F,
      `${F}css`,
      '/* src/components/button.css */',
      '.btn { color: red; }',
      F,
      `${F}html`,
      '<!-- index.html -->',
      '<div id="root"></div>',
      F,
    ].join('\n');
    const r = parsePasteImport(blob);
    expect(r.files).toEqual({
      'src/components/Button.tsx': 'export function Button() {\n  return <button>ok</button>;\n}\n',
      'src/components/button.css': '.btn { color: red; }\n',
      'index.html': '<div id="root"></div>\n',
    });
    expect(r.parsed.map((p) => p.source)).toEqual([
      'fence-comment',
      'fence-comment',
      'fence-comment',
    ]);
  });

  it('drops a path comment that repeats the heading name', () => {
    const blob = ['**src/data.json**', `${F}json`, '// src/data.json', '{"a":1}', F].join('\n');
    expect(parsePasteImport(blob).files).toEqual({ 'src/data.json': '{"a":1}\n' });
  });

  it('keeps a first-line comment that is not the file name', () => {
    const blob = ['**src/a.ts**', `${F}ts`, '// src/b.ts', 'export {};', F].join('\n');
    expect(parsePasteImport(blob).files).toEqual({ 'src/a.ts': '// src/b.ts\nexport {};\n' });
  });

  it('skips code blocks without a file name and reports them', () => {
    const blob = [
      'Install the dependency first:',
      '',
      `${F}bash`,
      'npm install zustand',
      F,
      '**src/store.ts**',
      `${F}ts`,
      "import { create } from 'zustand';",
      F,
      'The heading `src/x.ts` is followed by prose, so this block is unnamed:',
      'some prose',
      `${F}ts`,
      'const orphan = 1;',
      F,
    ].join('\n');
    const r = parsePasteImport(blob);
    expect(Object.keys(r.files)).toEqual(['src/store.ts']);
    expect(r.warnings).toEqual([
      { code: 'unlabeled-block', line: 3, language: 'bash' },
      { code: 'unlabeled-block', line: 12, language: 'ts' },
    ]);
  });

  it('does not take a name from a line that mentions two files', () => {
    const blob = ['Replace `src/a.ts` and delete `src/b.ts`:', `${F}ts`, 'x', F].join('\n');
    const r = parsePasteImport(blob);
    expect(r.files).toEqual({});
    expect(r.warnings).toEqual([{ code: 'unlabeled-block', line: 2, language: 'ts' }]);
  });

  it('handles longer fences that contain shorter ones (a README with code)', () => {
    const blob = [
      '**README.md**',
      '````md',
      '# Demo',
      `${F}sh`,
      'npm start',
      F,
      '````',
      '**src/a.ts**',
      `${F}ts`,
      'export {};',
      F,
    ].join('\n');
    const r = parsePasteImport(blob);
    expect(r.files['README.md']).toBe(`# Demo\n${F}sh\nnpm start\n${F}\n`);
    expect(r.files['src/a.ts']).toBe('export {};\n');
  });

  it('supports tilde fences', () => {
    const blob = ['`src/a.ts`', '~~~ts', 'export {};', '~~~'].join('\n');
    expect(parsePasteImport(blob).files).toEqual({ 'src/a.ts': 'export {};\n' });
  });
});

describe('parsePasteImport: file markers', () => {
  it('splits a raw blob on // file: markers', () => {
    const blob = `// file: src/main.tsx
import { createRoot } from 'react-dom/client';
import { App } from './App';
createRoot(document.getElementById('root')!).render(<App />);

// file: src/App.tsx
export function App() {
  // a normal comment stays
  return <h1>Hello</h1>;
}

/* file: src/styles.css */
h1 { color: tomato; }

<!-- file: public/notes.html -->
<p>notes</p>
`;
    const r = parsePasteImport(blob);
    expect(r.files).toEqual({
      'src/main.tsx':
        "import { createRoot } from 'react-dom/client';\nimport { App } from './App';\ncreateRoot(document.getElementById('root')!).render(<App />);\n",
      'src/App.tsx':
        'export function App() {\n  // a normal comment stays\n  return <h1>Hello</h1>;\n}\n',
      'src/styles.css': 'h1 { color: tomato; }\n',
      'public/notes.html': '<p>notes</p>\n',
    });
    expect(r.parsed.map((p) => [p.source, p.line])).toEqual([
      ['marker', 1],
      ['marker', 6],
      ['marker', 12],
      ['marker', 15],
    ]);
    expect(r.warnings).toEqual([]);
  });

  it('accepts marker variations (case, filename:, path:, quotes, backticks)', () => {
    const blob = [
      '// File: `src/a.ts`',
      'a',
      '//filename: "src/b.ts"',
      'b',
      '/** path: src/c.css **/',
      'c',
      '<!--file:src/d.html-->',
      'd',
    ].join('\n');
    expect(Object.keys(parsePasteImport(blob).files)).toEqual([
      'src/a.ts',
      'src/b.ts',
      'src/c.css',
      'src/d.html',
    ]);
  });

  it('splits several files inside one fence', () => {
    const blob = [
      "Here's everything in one block:",
      `${F}tsx`,
      '// file: src/App.tsx',
      'export const App = () => <p>a</p>;',
      '',
      '// file: src/main.tsx',
      "import { App } from './App';",
      F,
      'Done!',
    ].join('\n');
    const r = parsePasteImport(blob);
    expect(r.files).toEqual({
      'src/App.tsx': 'export const App = () => <p>a</p>;\n',
      'src/main.tsx': "import { App } from './App';\n",
    });
    expect(r.warnings).toEqual([]);
  });

  it('uses the fence after a standalone marker as that file', () => {
    const blob = [
      '// file: src/App.tsx',
      `${F}tsx`,
      'export const App = 1;',
      F,
      'Some explanation between files.',
      '// file: src/b.ts',
      '',
      `${F}ts`,
      'export const b = 2;',
      F,
    ].join('\n');
    const r = parsePasteImport(blob);
    expect(r.files).toEqual({
      'src/App.tsx': 'export const App = 1;\n',
      'src/b.ts': 'export const b = 2;\n',
    });
  });

  it('does not treat a comment mentioning "file:" mid-line as a marker', () => {
    const blob = ['// file: src/a.ts', 'const x = 1; // file: not-a-marker.ts', ''].join('\n');
    expect(parsePasteImport(blob).files).toEqual({
      'src/a.ts': 'const x = 1; // file: not-a-marker.ts\n',
    });
  });
});

describe('parsePasteImport: paths and edge cases', () => {
  it('normalizes paths', () => {
    const blob = ['// file: ./src//App.tsx', 'a', '// file: src\\b.ts', 'b'].join('\n');
    expect(Object.keys(parsePasteImport(blob).files)).toEqual(['src/App.tsx', 'src/b.ts']);
  });

  it('rejects .. and absolute paths and reports them', () => {
    const blob = [
      '**/src/App.tsx**',
      `${F}tsx`,
      'abs',
      F,
      '// file: ../../etc/passwd.txt',
      'nope',
      '// file: src/ok.ts',
      'ok',
    ].join('\n');
    const r = parsePasteImport(blob);
    expect(r.files).toEqual({ 'src/ok.ts': 'ok\n' });
    expect(r.warnings).toEqual([
      { code: 'invalid-path', raw: '/src/App.tsx', reason: 'absolute', line: 2 },
      { code: 'invalid-path', raw: '../../etc/passwd.txt', reason: 'parent-segment', line: 5 },
    ]);
  });

  it('keeps the last copy of a duplicated file and warns', () => {
    const blob = [
      '**src/App.tsx**',
      `${F}tsx`,
      'first',
      F,
      'Oops, here is the fixed version:',
      '**src/App.tsx**',
      `${F}tsx`,
      'second',
      F,
    ].join('\n');
    const r = parsePasteImport(blob);
    expect(r.files).toEqual({ 'src/App.tsx': 'second\n' });
    expect(r.parsed).toHaveLength(1);
    expect(r.warnings).toEqual([{ code: 'duplicate-path', path: 'src/App.tsx', line: 7 }]);
  });

  it('maps bare names onto existing src/ files', () => {
    const existing = createWorkspace().files;
    const blob = ['**App.tsx**', `${F}tsx`, 'x', F, '**Other.tsx**', `${F}tsx`, 'y', F].join('\n');
    const r = parsePasteImport(blob, { existingFiles: existing });
    expect(Object.keys(r.files)).toEqual(['src/App.tsx', 'Other.tsx']);
    expect(r.parsed[0]).toMatchObject({ path: 'src/App.tsx', remappedFrom: 'App.tsx' });
    expect(r.parsed[1]).not.toHaveProperty('remappedFrom');
  });

  it('handles CRLF line endings and a BOM', () => {
    const blob = '\uFEFF**src/a.ts**\r\n```ts\r\nexport {};\r\n```\r\n';
    expect(parsePasteImport(blob).files).toEqual({ 'src/a.ts': 'export {};\n' });
  });

  it('reports an unclosed fence and keeps its content', () => {
    const blob = ['**src/a.ts**', `${F}ts`, 'export const a = 1;'].join('\n');
    const r = parsePasteImport(blob);
    expect(r.files).toEqual({ 'src/a.ts': 'export const a = 1;\n' });
    expect(r.warnings).toEqual([{ code: 'unclosed-fence', line: 2 }]);
  });

  it('keeps empty files but warns', () => {
    const r = parsePasteImport(['**src/empty.css**', `${F}css`, F].join('\n'));
    expect(r.files).toEqual({ 'src/empty.css': '' });
    expect(r.warnings).toEqual([{ code: 'empty-file', path: 'src/empty.css', line: 2 }]);
  });

  it('returns nothing for text without files', () => {
    expect(parsePasteImport('')).toEqual({ files: {}, parsed: [], warnings: [] });
    expect(parsePasteImport('just some prose about App.tsx and nothing else')).toEqual({
      files: {},
      parsed: [],
      warnings: [],
    });
  });

  it('describes every warning', () => {
    const warnings: PasteWarning[] = [
      { code: 'invalid-path', raw: '../x', reason: 'parent-segment', line: 1 },
      { code: 'invalid-path', raw: '/x', reason: 'absolute', line: 1 },
      { code: 'invalid-path', raw: 'a?', reason: 'invalid-character', line: 1 },
      { code: 'duplicate-path', path: 'a', line: 2 },
      { code: 'unlabeled-block', line: 3, language: 'bash' },
      { code: 'unlabeled-block', line: 3, language: '' },
      { code: 'empty-file', path: 'a', line: 4 },
      { code: 'unclosed-fence', line: 5 },
    ];
    expect(warnings.map(describePasteWarning)).toEqual([
      'Line 1: skipped "../x" (path contains "..").',
      'Line 1: skipped "/x" (absolute path).',
      'Line 1: skipped "a?" (invalid path: invalid-character).',
      'Line 2: "a" appears more than once; the last one is used.',
      'Line 3: a bash code block has no file name and was skipped.',
      'Line 3: a code block has no file name and was skipped.',
      'Line 4: "a" is empty.',
      'Line 5: a code block is never closed; it runs to the end of the paste.',
    ]);
  });
});

describe('file name heuristics', () => {
  it.each([
    ['src/App.tsx', true],
    ['App.tsx', true],
    ['./src/a.ts', true],
    ['/src/a.ts', true],
    ['../a.css', true],
    ['package.json', true],
    ['.eslintrc', false],
    ['e.g.', false],
    ['v1.2', false],
    ['tsx', false],
    ['src/App', false],
    ['hello world.ts', false],
  ])('looksLikeFilePath(%j) = %s', (token, expected) => {
    expect(looksLikeFilePath(token)).toBe(expected);
  });

  it.each([
    ['**src/App.tsx**', 'src/App.tsx'],
    ['`src/App.tsx`', 'src/App.tsx'],
    ['### src/App.tsx', 'src/App.tsx'],
    ['## 2. `src/App.tsx` (updated)', 'src/App.tsx'],
    ['File: src/App.tsx', 'src/App.tsx'],
    ['**File: `src/App.tsx`**', 'src/App.tsx'],
    ['`File: src/App.tsx`', 'src/App.tsx'],
    ['Create a file called App.tsx.', 'App.tsx'],
    ['src/App.tsx:', 'src/App.tsx'],
    ['- **src/App.tsx**:', 'src/App.tsx'],
    ['Here is the code:', null],
    ['Use `useState` from `react`:', null],
    ['Copy `a.ts` into `b.ts`', null],
  ])('filenameFromProseLine(%j) = %j', (line, expected) => {
    expect(filenameFromProseLine(line)).toBe(expected);
  });
});
