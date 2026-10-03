import type { FileMap, Manifest } from '../src/types';
import { SAMPLE_FILES, SAMPLE_MANIFEST } from '../playground/sample-project';

export const REACT_MANIFEST: Manifest = {
  entry: 'src/main.tsx',
  dependencies: { react: '19.3.0', 'react-dom': '19.3.0', zustand: '5.0.15' },
};

const MAIN = `import { createRoot } from 'react-dom/client';
import { App } from './App';
createRoot(document.getElementById('root')!).render(<App />);
`;

/** Single-component React app; `body` is the JSX returned by App, `prelude` runs at module top. */
export function reactApp(body: string, prelude = ''): FileMap {
  return {
    'src/main.tsx': MAIN,
    'src/App.tsx': `${prelude}\nexport function App() {\n  return (${body});\n}\n`,
  };
}

/** The playground sample (4 files) plus 6 components: the 10-file project of the §3.8 budget. */
export function tenFileProject(label: string): { files: FileMap; manifest: Manifest } {
  const files: FileMap = { ...SAMPLE_FILES };
  const names = ['Header', 'Footer', 'Card', 'List', 'Badge', 'Panel'];
  for (const n of names) {
    files[`src/components/${n}.tsx`] = `import { useState } from 'react';
export function ${n}({ title }: { title: string }) {
  const [open, setOpen] = useState(true);
  const items = Array.from({ length: 20 }, (_, i) => \`${n} item \${i}\`);
  return (
    <section className="${n.toLowerCase()}" onClick={() => setOpen(!open)}>
      <h2>{title}</h2>
      {open && <ul>{items.map((it) => <li key={it}>{it}</li>)}</ul>}
    </section>
  );
}
`;
  }
  files['src/App.tsx'] = `import { useCounter } from './store';
${names.map((n) => `import { ${n} } from './components/${n}';`).join('\n')}

export function App() {
  const { count, increment } = useCounter();
  return (
    <main className="app">
      <h1 className="title" data-testid="title">${label}</h1>
      <button data-testid="inc" onClick={increment}>count is {count}</button>
      ${names.map((n) => `<${n} title="${n}" />`).join('\n      ')}
    </main>
  );
}
`;
  return { files, manifest: SAMPLE_MANIFEST };
}
