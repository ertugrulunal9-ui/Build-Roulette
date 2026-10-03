import type { FileMap, Manifest } from '../src/types';

/** Versions served by the mock CDN (devDependencies of @br/runtime). */
export const SAMPLE_MANIFEST: Manifest = {
  template: 'react-ts',
  entry: 'src/main.tsx',
  dependencies: {
    react: '19.3.0',
    'react-dom': '19.3.0',
    zustand: '5.0.15',
    'animate.css': '4.1.1',
  },
};

export const SAMPLE_FILES: FileMap = {
  'src/main.tsx': `import { createRoot } from 'react-dom/client';
import 'animate.css/animate.min.css';
import './styles.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(<App />);
`,
  'src/App.tsx': `import { useCounter } from './store';

const visits = Number(localStorage.getItem('visits') ?? '0') + 1;
localStorage.setItem('visits', String(visits));

export function App() {
  const { count, increment } = useCounter();
  return (
    <main className="app">
      <h1 className="title animate__animated animate__fadeIn" data-testid="title">Hello Build Roulette</h1>
      <button data-testid="inc" onClick={increment}>count is {count}</button>
      <p data-testid="visits">visits: {visits}</p>
    </main>
  );
}
`,
  'src/store.ts': `import { create } from 'zustand';

interface CounterState {
  count: number;
  increment: () => void;
}

export const useCounter = create<CounterState>((set) => ({
  count: 0,
  increment: () => set((s) => ({ count: s.count + 1 })),
}));
`,
  'src/styles.css': `.app {
  font-family: system-ui, sans-serif;
  padding: 16px;
}
.title {
  color: rgb(255, 0, 128);
}
`,
};
