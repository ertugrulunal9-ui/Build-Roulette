/**
 * The curated R1 package list: popular frontend packages a vibe coder is likely to import,
 * pinned to exact versions (current on the registry when the list was written).
 *
 * Each case is `src/App.tsx` of a React app (main.tsx is shared). The app must render an
 * element with `data-testid="marker"` whose text becomes exactly `expected` once the package
 * did its job. Apps use the package the way its docs (and AI assistants) do.
 */

export const REACT_VERSION = '19.3.0';

export const MAIN_TSX = `import { createRoot } from 'react-dom/client';
import { App } from './App';
createRoot(document.getElementById('root')!).render(<App />);
`;

export interface CompatCase {
  /** Unique id (usually the package name; a suffix when one package has two cases). */
  id: string;
  /** Package under test (also added to the manifest). */
  name: string;
  version: string;
  category:
    'state' | 'animation' | 'charts' | '3d-canvas-games' | 'audio' | 'utility' | 'ui' | 'misc';
  /** Other packages the app needs, pinned. */
  deps?: Record<string, string>;
  /** One line: what the app does with the package. */
  checks: string;
  app: string;
  expected: string;
  timeoutMs?: number;
  /**
   * A failure we know and accept (T-040): on every CDN (`any`) or on esm.sh only. The case
   * still runs and counts; the report lists it apart from unexpected failures.
   */
  knownFailure?: { on: 'any' | 'esm.sh'; reason: string };
}

/** The known failure of a case on a CDN, or null (`esm.sh`: the public esm.sh host). */
export function knownFailureOn(c: CompatCase, cdnUrl: string): string | null {
  const k = c.knownFailure;
  if (!k) return null;
  return k.on === 'any' || new URL(cdnUrl).hostname === 'esm.sh' ? k.reason : null;
}

const c = (x: CompatCase): CompatCase => x;

/** A tiny valid WAV (8 samples of silence) for the audio packages. */
const WAV =
  'data:audio/wav;base64,UklGRiwAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQgAAAAAAAAAAAAAAA==';

export const CASES: CompatCase[] = [
  // ---------------------------------------------------------------- state
  c({
    id: 'zustand',
    name: 'zustand',
    version: '5.0.15',
    category: 'state',
    checks: 'create() store + hook, setState',
    expected: 'ok:2',
    app: `import { useEffect } from 'react';
import { create } from 'zustand';
const useStore = create<{ n: number; inc: () => void }>((set) => ({ n: 0, inc: () => set((s) => ({ n: s.n + 1 })) }));
export function App() {
  const { n, inc } = useStore();
  useEffect(() => { inc(); inc(); }, []);
  return <div data-testid="marker">ok:{n}</div>;
}`,
  }),
  c({
    id: 'jotai',
    name: 'jotai',
    version: '3.0.1',
    category: 'state',
    checks: 'atom + derived atom + useAtom',
    expected: 'ok:6',
    app: `import { useEffect } from 'react';
import { atom, useAtom, useAtomValue } from 'jotai';
const countAtom = atom(1);
const doubleAtom = atom((get) => get(countAtom) * 2);
export function App() {
  const [, setCount] = useAtom(countAtom);
  const double = useAtomValue(doubleAtom);
  useEffect(() => { setCount(3); }, []);
  return <div data-testid="marker">ok:{double}</div>;
}`,
  }),
  c({
    id: 'valtio',
    name: 'valtio',
    version: '2.3.2',
    category: 'state',
    checks: 'proxy + useSnapshot',
    expected: 'ok:hello',
    app: `import { useEffect } from 'react';
import { proxy, useSnapshot } from 'valtio';
const state = proxy({ text: 'start' });
export function App() {
  const snap = useSnapshot(state);
  useEffect(() => { state.text = 'hello'; }, []);
  return <div data-testid="marker">ok:{snap.text}</div>;
}`,
  }),
  c({
    id: '@reduxjs/toolkit',
    name: '@reduxjs/toolkit',
    version: '2.13.0',
    category: 'state',
    checks: 'createSlice + configureStore + dispatch',
    expected: 'ok:5',
    app: `import { configureStore, createSlice } from '@reduxjs/toolkit';
const slice = createSlice({ name: 'c', initialState: { v: 0 }, reducers: { add: (s, a: { payload: number }) => { s.v += a.payload; } } });
const store = configureStore({ reducer: slice.reducer });
store.dispatch(slice.actions.add(2));
store.dispatch(slice.actions.add(3));
export function App() {
  return <div data-testid="marker">ok:{store.getState().v}</div>;
}`,
  }),
  c({
    id: 'react-redux',
    name: 'react-redux',
    version: '9.3.0',
    category: 'state',
    deps: { '@reduxjs/toolkit': '2.13.0' },
    checks: 'Provider + useSelector + useDispatch with an RTK store',
    expected: 'ok:3',
    app: `import { useEffect } from 'react';
import { configureStore, createSlice } from '@reduxjs/toolkit';
import { Provider, useDispatch, useSelector } from 'react-redux';
const slice = createSlice({ name: 'c', initialState: { v: 1 }, reducers: { inc: (s) => { s.v += 1; } } });
const store = configureStore({ reducer: slice.reducer });
function Counter() {
  const v = useSelector((s: { v: number }) => s.v);
  const dispatch = useDispatch();
  useEffect(() => { dispatch(slice.actions.inc()); dispatch(slice.actions.inc()); }, []);
  return <div data-testid="marker">ok:{v}</div>;
}
export function App() {
  return <Provider store={store}><Counter /></Provider>;
}`,
  }),
  c({
    id: 'mobx-react-lite',
    name: 'mobx-react-lite',
    version: '5.1.0',
    category: 'state',
    deps: { mobx: '7.0.6' },
    checks: 'mobx makeAutoObservable store + observer component',
    expected: 'ok:4',
    app: `import { useEffect } from 'react';
import { makeAutoObservable } from 'mobx';
import { observer } from 'mobx-react-lite';
class Counter { n = 2; constructor() { makeAutoObservable(this); } double() { this.n *= 2; } }
const counter = new Counter();
export const App = observer(function App() {
  useEffect(() => { counter.double(); }, []);
  return <div data-testid="marker">ok:{counter.n}</div>;
});`,
  }),

  // ---------------------------------------------------------------- animation
  c({
    id: 'framer-motion',
    name: 'framer-motion',
    version: '14.0.0',
    category: 'animation',
    checks: 'motion.div animate + onAnimationComplete',
    expected: 'ok:done',
    app: `import { useState } from 'react';
import { motion } from 'framer-motion';
export function App() {
  const [s, setS] = useState('running');
  return <motion.div data-testid="marker" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }} onAnimationComplete={() => setS('done')}>ok:{s}</motion.div>;
}`,
  }),
  c({
    id: 'motion',
    name: 'motion',
    version: '14.0.0',
    category: 'animation',
    checks: 'motion/react motion.div + useMotionValue',
    expected: 'ok:done:5',
    app: `import { useState } from 'react';
import { motion, useMotionValue } from 'motion/react';
export function App() {
  const x = useMotionValue(5);
  const [s, setS] = useState('running');
  return <motion.div data-testid="marker" style={{ x }} animate={{ scale: 1.2 }} transition={{ duration: 0.2 }} onAnimationComplete={() => setS('done')}>ok:{s}:{x.get()}</motion.div>;
}`,
  }),
  c({
    id: 'gsap',
    name: 'gsap',
    version: '3.15.0',
    category: 'animation',
    checks: 'gsap.to tween on a DOM node, onComplete',
    expected: 'ok:100',
    app: `import { useEffect, useRef, useState } from 'react';
import { gsap } from 'gsap';
export function App() {
  const box = useRef<HTMLDivElement>(null);
  const [x, setX] = useState('');
  useEffect(() => {
    gsap.to(box.current, { x: 100, duration: 0.2, onComplete: () => setX(String(gsap.getProperty(box.current, 'x'))) });
  }, []);
  return <div><div ref={box} style={{ width: 20, height: 20, background: 'red' }} /><div data-testid="marker">ok:{x}</div></div>;
}`,
  }),
  c({
    id: 'animejs',
    name: 'animejs',
    version: '4.5.0',
    category: 'animation',
    checks: 'animate() (v4 API) on a DOM node, onComplete',
    expected: 'ok:done',
    app: `import { useEffect, useRef, useState } from 'react';
import { animate } from 'animejs';
export function App() {
  const box = useRef<HTMLDivElement>(null);
  const [s, setS] = useState('');
  useEffect(() => {
    animate(box.current!, { translateX: 50, duration: 200, onComplete: () => setS('done') });
  }, []);
  return <div><div ref={box} style={{ width: 20, height: 20, background: 'blue' }} /><div data-testid="marker">ok:{s}</div></div>;
}`,
  }),
  c({
    id: 'canvas-confetti',
    name: 'canvas-confetti',
    version: '1.9.4',
    category: 'animation',
    checks: 'confetti.create on a canvas, fire a burst',
    expected: 'ok:function',
    app: `import { useEffect, useRef, useState } from 'react';
import confetti from 'canvas-confetti';
export function App() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [s, setS] = useState('');
  useEffect(() => {
    const fire = confetti.create(canvas.current!, { resize: true });
    fire({ particleCount: 20, spread: 60 });
    setS(typeof fire);
  }, []);
  return <div><canvas ref={canvas} width={200} height={200} /><div data-testid="marker">ok:{s}</div></div>;
}`,
  }),
  c({
    id: '@react-spring/web',
    name: '@react-spring/web',
    version: '10.1.2',
    category: 'animation',
    checks: 'useSpring + animated.div, onRest',
    expected: 'ok:rest',
    app: `import { useState } from 'react';
import { animated, useSpring } from '@react-spring/web';
export function App() {
  const [s, setS] = useState('');
  const styles = useSpring({ from: { opacity: 0 }, to: { opacity: 1 }, config: { duration: 200 }, onRest: () => setS('rest') });
  return <animated.div style={styles} data-testid="marker">ok:{s}</animated.div>;
}`,
  }),

  // ---------------------------------------------------------------- charts
  c({
    id: 'chart.js',
    name: 'chart.js',
    version: '4.5.1',
    category: 'charts',
    checks: 'chart.js/auto bar chart on a canvas',
    expected: 'ok:bar:3',
    app: `import { useEffect, useRef, useState } from 'react';
import Chart from 'chart.js/auto';
export function App() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [s, setS] = useState('');
  useEffect(() => {
    const chart = new Chart(canvas.current!, { type: 'bar', data: { labels: ['a', 'b', 'c'], datasets: [{ label: 'x', data: [1, 2, 3] }] }, options: { animation: false } });
    setS(chart.config.type + ':' + chart.data.labels!.length);
    return () => chart.destroy();
  }, []);
  return <div style={{ width: 400 }}><canvas ref={canvas} /><div data-testid="marker">ok:{s}</div></div>;
}`,
  }),
  c({
    id: 'react-chartjs-2',
    name: 'react-chartjs-2',
    version: '5.3.1',
    category: 'charts',
    deps: { 'chart.js': '4.5.1' },
    checks: '<Line> with registered chart.js components',
    expected: 'ok:line',
    app: `import { useEffect, useRef, useState } from 'react';
import { Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement } from 'chart.js';
import { Line } from 'react-chartjs-2';
ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement);
export function App() {
  const ref = useRef<ChartJS<'line'>>(null);
  const [s, setS] = useState('');
  useEffect(() => { setS(ref.current ? (ref.current.config as { type: string }).type : 'none'); }, []);
  return <div style={{ width: 400 }}><Line ref={ref} data={{ labels: ['a', 'b'], datasets: [{ data: [1, 2] }] }} options={{ animation: false }} /><div data-testid="marker">ok:{s}</div></div>;
}`,
  }),
  c({
    id: 'recharts',
    name: 'recharts',
    version: '3.10.1',
    category: 'charts',
    checks: 'LineChart with fixed size renders an SVG path',
    expected: 'ok:svg',
    app: `import { useEffect, useState } from 'react';
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts';
const data = [{ name: 'a', v: 1 }, { name: 'b', v: 3 }, { name: 'c', v: 2 }];
export function App() {
  const [s, setS] = useState('');
  useEffect(() => {
    const t = setInterval(() => { if (document.querySelector('.recharts-line path, .recharts-line-curve')) { setS('svg'); clearInterval(t); } }, 50);
    return () => clearInterval(t);
  }, []);
  return <div><LineChart width={400} height={200} data={data}><CartesianGrid /><XAxis dataKey="name" /><YAxis /><Line dataKey="v" isAnimationActive={false} /></LineChart><div data-testid="marker">ok:{s}</div></div>;
}`,
  }),
  c({
    id: 'd3',
    name: 'd3',
    version: '7.9.0',
    category: 'charts',
    checks: 'scaleLinear + select/append into an SVG',
    expected: 'ok:50:3',
    app: `import { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';
export function App() {
  const svg = useRef<SVGSVGElement>(null);
  const [s, setS] = useState('');
  useEffect(() => {
    const x = d3.scaleLinear().domain([0, 10]).range([0, 100]);
    d3.select(svg.current).selectAll('circle').data([1, 2, 3]).join('circle').attr('cx', (d) => x(d)).attr('cy', 10).attr('r', 4);
    setS(x(5) + ':' + svg.current!.querySelectorAll('circle').length);
  }, []);
  return <div><svg ref={svg} width={120} height={20} /><div data-testid="marker">ok:{s}</div></div>;
}`,
  }),

  // ---------------------------------------------------------------- 3D, canvas, games
  c({
    id: 'three',
    name: 'three',
    version: '0.186.1',
    category: '3d-canvas-games',
    checks: 'Scene + Mesh + WebGLRenderer.render',
    expected: 'ok:1:1.732',
    app: `import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
export function App() {
  const host = useRef<HTMLDivElement>(null);
  const [s, setS] = useState('');
  useEffect(() => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.z = 3;
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshNormalMaterial()));
    const renderer = new THREE.WebGLRenderer();
    renderer.setSize(100, 100);
    host.current!.appendChild(renderer.domElement);
    renderer.render(scene, camera);
    setS(scene.children.length + ':' + new THREE.Vector3(1, 1, 1).length().toFixed(3));
    return () => renderer.dispose();
  }, []);
  return <div><div ref={host} /><div data-testid="marker">ok:{s}</div></div>;
}`,
  }),
  c({
    id: 'three/examples (OrbitControls)',
    name: 'three',
    version: '0.186.1',
    category: '3d-canvas-games',
    checks: 'three/examples/jsm/controls/OrbitControls.js shares the three instance',
    expected: 'ok:true',
    app: `import { useEffect, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
export function App() {
  const [s, setS] = useState('');
  useEffect(() => {
    const camera = new THREE.PerspectiveCamera();
    const controls = new OrbitControls(camera, document.body);
    setS(String(controls.object === camera && controls.target instanceof THREE.Vector3));
    controls.dispose();
  }, []);
  return <div data-testid="marker">ok:{s}</div>;
}`,
  }),
  c({
    id: '@react-three/fiber',
    name: '@react-three/fiber',
    version: '9.8.1',
    category: '3d-canvas-games',
    deps: { three: '0.186.1' },
    checks: '<Canvas> + mesh, onCreated fires',
    expected: 'ok:created',
    app: `import { useState } from 'react';
import { Canvas } from '@react-three/fiber';
export function App() {
  const [s, setS] = useState('');
  return <div><div style={{ width: 200, height: 200 }}><Canvas onCreated={() => setS('created')}><mesh><boxGeometry /><meshBasicMaterial color="hotpink" /></mesh></Canvas></div><div data-testid="marker">ok:{s}</div></div>;
}`,
  }),
  // T-035: the app's `three` and fiber's peer `three` must be one module. @br/pkg-cdn emits the
  // peer with the request's query, which is the app's own URL; on esm.sh it depends on how it
  // resolves a peer under `?deps=`.
  c({
    id: '@react-three/fiber (one three)',
    name: '@react-three/fiber',
    version: '9.8.1',
    category: '3d-canvas-games',
    deps: { three: '0.186.1' },
    checks: "fiber's scene is an instance of the app's own THREE.Scene",
    expected: 'ok:true',
    app: `import { useEffect, useState } from 'react';
import * as THREE from 'three';
import { Canvas, useThree } from '@react-three/fiber';
function Probe({ report }: { report: (s: string) => void }) {
  const scene = useThree((s) => s.scene);
  useEffect(() => { report(String(scene instanceof THREE.Scene)); }, [scene]);
  return null;
}
export function App() {
  const [s, setS] = useState('');
  return <div><div style={{ width: 100, height: 100 }}><Canvas><Probe report={setS} /></Canvas></div><div data-testid="marker">ok:{s}</div></div>;
}`,
  }),
  c({
    id: 'pixi.js',
    name: 'pixi.js',
    version: '8.22.0',
    category: '3d-canvas-games',
    checks: 'Application.init (v8) + Graphics on stage',
    expected: 'ok:1',
    app: `import { useEffect, useRef, useState } from 'react';
import { Application, Graphics } from 'pixi.js';
export function App() {
  const host = useRef<HTMLDivElement>(null);
  const [s, setS] = useState('');
  useEffect(() => {
    const app = new Application();
    let alive = true;
    app.init({ width: 100, height: 100, background: '#123456', preference: 'webgl' }).then(() => {
      if (!alive) return;
      host.current!.appendChild(app.canvas);
      app.stage.addChild(new Graphics().rect(0, 0, 10, 10).fill(0xff0000));
      setS(String(app.stage.children.length));
    });
    return () => { alive = false; };
  }, []);
  return <div><div ref={host} /><div data-testid="marker">ok:{s}</div></div>;
}`,
  }),
  c({
    id: 'pixi.js (unsafe-eval module)',
    name: 'pixi.js',
    version: '8.22.0',
    category: '3d-canvas-games',
    checks: "same as pixi.js plus pixi's documented import 'pixi.js/unsafe-eval' for strict CSPs",
    expected: 'ok:1',
    app: `import { useEffect, useRef, useState } from 'react';
import 'pixi.js/unsafe-eval';
import { Application, Graphics } from 'pixi.js';
export function App() {
  const host = useRef<HTMLDivElement>(null);
  const [s, setS] = useState('');
  useEffect(() => {
    const app = new Application();
    let alive = true;
    app.init({ width: 100, height: 100, background: '#123456', preference: 'webgl' }).then(() => {
      if (!alive) return;
      host.current!.appendChild(app.canvas);
      app.stage.addChild(new Graphics().rect(0, 0, 10, 10).fill(0xff0000));
      setS(String(app.stage.children.length));
    });
    return () => { alive = false; };
  }, []);
  return <div><div ref={host} /><div data-testid="marker">ok:{s}</div></div>;
}`,
  }),
  c({
    id: 'matter-js',
    name: 'matter-js',
    version: '0.20.0',
    category: '3d-canvas-games',
    checks: 'Engine + Bodies + Composite, step the simulation',
    expected: 'ok:fell',
    app: `import Matter from 'matter-js';
const { Engine, Bodies, Composite } = Matter;
const engine = Engine.create();
const ball = Bodies.circle(50, 0, 10);
Composite.add(engine.world, [ball, Bodies.rectangle(50, 200, 200, 20, { isStatic: true })]);
for (let i = 0; i < 30; i++) Engine.update(engine, 1000 / 60);
export function App() {
  return <div data-testid="marker">ok:{ball.position.y > 0 ? 'fell' : 'stuck'}</div>;
}`,
  }),
  c({
    id: 'matter-js (named imports)',
    name: 'matter-js',
    version: '0.20.0',
    category: '3d-canvas-games',
    checks: 'named imports { Engine, Bodies } from the UMD build',
    expected: 'ok:fell',
    knownFailure: {
      on: 'any',
      reason:
        'matter-js ships a UMD bundle: its names are only known at run time, so there are no named exports (the default import works)',
    },
    app: `import { Engine, Bodies, Composite } from 'matter-js';
const engine = Engine.create();
const ball = Bodies.circle(50, 0, 10);
Composite.add(engine.world, [ball]);
for (let i = 0; i < 30; i++) Engine.update(engine, 1000 / 60);
export function App() {
  return <div data-testid="marker">ok:{ball.position.y > 0 ? 'fell' : 'stuck'}</div>;
}`,
  }),
  c({
    id: 'p5',
    name: 'p5',
    version: '2.3.4',
    category: '3d-canvas-games',
    checks: 'instance mode sketch: createCanvas + draw',
    expected: 'ok:120x80',
    // esm.sh resolves p5's dependency @davepagurek/bezier-path@0.0.7 with its `browser` export
    // condition, a minified global script (`var BezierPath=…`) with no exports, ahead of
    // `import` (build/index.js, the ES module), which comes first in the package's `exports`.
    // @br/pkg-cdn follows the `exports` order (esbuild), so the case passes there. Not fixable
    // from our side without overriding esm.sh's resolution for one package (T-040).
    knownFailure: {
      on: 'esm.sh',
      reason:
        "esm.sh builds @davepagurek/bezier-path from its `browser` export (a global script without exports), so p5's `createFromCommands` import fails",
    },
    app: `import { useEffect, useRef, useState } from 'react';
import p5 from 'p5';
export function App() {
  const host = useRef<HTMLDivElement>(null);
  const [s, setS] = useState('');
  useEffect(() => {
    const inst = new p5((p: p5) => {
      p.setup = () => { p.createCanvas(120, 80); };
      p.draw = () => { p.background(200); p.circle(60, 40, 20); setS(p.width + 'x' + p.height); p.noLoop(); };
    }, host.current!);
    return () => inst.remove();
  }, []);
  return <div><div ref={host} /><div data-testid="marker">ok:{s}</div></div>;
}`,
  }),
  c({
    id: 'kaplay',
    name: 'kaplay',
    version: '3001.0.19',
    category: '3d-canvas-games',
    checks: 'kaplay({ global: false }) + add a game object',
    expected: 'ok:1',
    app: `import { useEffect, useRef, useState } from 'react';
import kaplay from 'kaplay';
export function App() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [s, setS] = useState('');
  useEffect(() => {
    const k = kaplay({ global: false, canvas: canvas.current!, width: 160, height: 120, background: [20, 20, 40] });
    k.add([k.rect(20, 20), k.pos(10, 10), k.color(255, 0, 0)]);
    setS(String(k.get('*').length));
    return () => k.quit();
  }, []);
  return <div><canvas ref={canvas} /><div data-testid="marker">ok:{s}</div></div>;
}`,
  }),
  c({
    id: 'phaser',
    name: 'phaser',
    version: '4.2.1',
    category: '3d-canvas-games',
    checks: 'Phaser.Game with a scene; create() runs',
    expected: 'ok:created',
    timeoutMs: 20_000,
    app: `import { useEffect, useRef, useState } from 'react';
import Phaser from 'phaser';
export function App() {
  const host = useRef<HTMLDivElement>(null);
  const [s, setS] = useState('');
  useEffect(() => {
    const game = new Phaser.Game({
      type: Phaser.AUTO, width: 160, height: 120, parent: host.current!, banner: false,
      scene: { create(this: Phaser.Scene) { this.add.rectangle(80, 60, 40, 40, 0xff0000); setS('created'); } },
    });
    return () => game.destroy(true);
  }, []);
  return <div><div ref={host} /><div data-testid="marker">ok:{s}</div></div>;
}`,
  }),
  c({
    id: 'konva',
    name: 'konva',
    version: '10.7.0',
    category: '3d-canvas-games',
    checks: 'Stage + Layer + Rect, draw',
    expected: 'ok:1',
    app: `import { useEffect, useRef, useState } from 'react';
import Konva from 'konva';
export function App() {
  const host = useRef<HTMLDivElement>(null);
  const [s, setS] = useState('');
  useEffect(() => {
    const stage = new Konva.Stage({ container: host.current!, width: 100, height: 100 });
    const layer = new Konva.Layer();
    layer.add(new Konva.Rect({ x: 10, y: 10, width: 20, height: 20, fill: 'green' }));
    stage.add(layer);
    layer.draw();
    setS(String(layer.getChildren().length));
    return () => stage.destroy();
  }, []);
  return <div><div ref={host} /><div data-testid="marker">ok:{s}</div></div>;
}`,
  }),
  c({
    id: 'react-konva',
    name: 'react-konva',
    version: '19.3.0',
    category: '3d-canvas-games',
    deps: { konva: '10.7.0' },
    checks: '<Stage><Layer><Rect/> renders a canvas',
    expected: 'ok:canvas',
    app: `import { useEffect, useState } from 'react';
import { Layer, Rect, Stage } from 'react-konva';
export function App() {
  const [s, setS] = useState('');
  useEffect(() => { setS(document.querySelector('.konvajs-content canvas') ? 'canvas' : 'none'); }, []);
  return <div><Stage width={100} height={100}><Layer><Rect x={10} y={10} width={20} height={20} fill="red" /></Layer></Stage><div data-testid="marker">ok:{s}</div></div>;
}`,
  }),

  // ---------------------------------------------------------------- audio
  c({
    id: 'tone',
    name: 'tone',
    version: '15.1.22',
    category: 'audio',
    checks: 'Synth.toDestination + Frequency conversion (no playback)',
    expected: 'ok:440:Synth',
    app: `import { useEffect, useState } from 'react';
import * as Tone from 'tone';
export function App() {
  const [s, setS] = useState('');
  useEffect(() => {
    const synth = new Tone.Synth().toDestination();
    setS(Math.round(Tone.Frequency('A4').toFrequency()) + ':' + synth.name);
    return () => { synth.dispose(); };
  }, []);
  return <div data-testid="marker">ok:{s}</div>;
}`,
  }),
  c({
    id: 'howler',
    name: 'howler',
    version: '2.2.4',
    category: 'audio',
    checks: 'Howl from a data: WAV + Howler.volume',
    expected: 'ok:0.5',
    app: `import { useEffect, useState } from 'react';
import { Howl, Howler } from 'howler';
export function App() {
  const [s, setS] = useState('');
  useEffect(() => {
    const sound = new Howl({ src: ['${WAV}'], format: ['wav'] });
    Howler.volume(0.5);
    setS(String(Howler.volume()));
    return () => { sound.unload(); };
  }, []);
  return <div data-testid="marker">ok:{s}</div>;
}`,
  }),
  c({
    id: 'use-sound',
    name: 'use-sound',
    version: '5.0.0',
    category: 'audio',
    checks: 'useSound hook returns a play function',
    expected: 'ok:function',
    app: `import useSound from 'use-sound';
export function App() {
  const [play] = useSound('${WAV}');
  return <div data-testid="marker">ok:{typeof play}</div>;
}`,
  }),

  // ---------------------------------------------------------------- utility
  c({
    id: 'date-fns',
    name: 'date-fns',
    version: '4.4.0',
    category: 'utility',
    checks: 'format + addDays',
    expected: 'ok:2024-01-03',
    app: `import { addDays, format } from 'date-fns';
export function App() {
  return <div data-testid="marker">ok:{format(addDays(new Date(2024, 0, 2), 1), 'yyyy-MM-dd')}</div>;
}`,
  }),
  c({
    id: 'dayjs',
    name: 'dayjs',
    version: '1.11.23',
    category: 'utility',
    checks: 'dayjs() + plugin subpath dayjs/plugin/relativeTime',
    expected: 'ok:2024-01-03:a day ago',
    app: `import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
dayjs.extend(relativeTime);
const d = dayjs('2024-01-02').add(1, 'day');
export function App() {
  return <div data-testid="marker">ok:{d.format('YYYY-MM-DD')}:{d.from(d.add(1, 'day'))}</div>;
}`,
  }),
  c({
    id: 'lodash-es',
    name: 'lodash-es',
    version: '4.18.1',
    category: 'utility',
    checks: 'chunk + sortBy + debounce',
    expected: 'ok:2:3',
    app: `import { chunk, debounce, sortBy } from 'lodash-es';
const parts = chunk([1, 2, 3, 4], 2);
const sorted = sortBy([3, 1, 2]);
debounce(() => {}, 10)();
export function App() {
  return <div data-testid="marker">ok:{parts.length}:{sorted[2]}</div>;
}`,
  }),
  c({
    id: 'nanoid',
    name: 'nanoid',
    version: '6.0.1',
    category: 'utility',
    checks: 'nanoid() + customAlphabet',
    expected: 'ok:21:8',
    app: `import { customAlphabet, nanoid } from 'nanoid';
export function App() {
  return <div data-testid="marker">ok:{nanoid().length}:{customAlphabet('abc', 8)().length}</div>;
}`,
  }),
  c({
    id: 'clsx',
    name: 'clsx',
    version: '2.1.1',
    category: 'utility',
    checks: 'clsx with strings and objects',
    expected: 'ok:a c',
    app: `import clsx from 'clsx';
export function App() {
  return <div data-testid="marker">ok:{clsx('a', { b: false, c: true })}</div>;
}`,
  }),
  c({
    id: 'immer',
    name: 'immer',
    version: '11.1.21',
    category: 'utility',
    checks: 'produce on a frozen object',
    expected: 'ok:1:2',
    app: `import { produce } from 'immer';
const base = { n: 1 };
const next = produce(base, (d) => { d.n = 2; });
export function App() {
  return <div data-testid="marker">ok:{base.n}:{next.n}</div>;
}`,
  }),
  c({
    id: 'zod',
    name: 'zod',
    version: '4.6.5',
    category: 'utility',
    checks: 'z.object().safeParse success and failure',
    expected: 'ok:true:false',
    app: `import { z } from 'zod';
const User = z.object({ name: z.string(), age: z.number().int().min(0) });
export function App() {
  const a = User.safeParse({ name: 'a', age: 3 }).success;
  const b = User.safeParse({ name: 'a', age: -1 }).success;
  return <div data-testid="marker">ok:{String(a)}:{String(b)}</div>;
}`,
  }),
  c({
    id: 'uuid',
    name: 'uuid',
    version: '14.0.2',
    category: 'utility',
    checks: 'v4() + validate()',
    expected: 'ok:true',
    app: `import { v4 as uuidv4, validate } from 'uuid';
export function App() {
  return <div data-testid="marker">ok:{String(validate(uuidv4()))}</div>;
}`,
  }),
  c({
    id: 'axios',
    name: 'axios',
    version: '1.20.0',
    category: 'utility',
    checks: 'axios.create + interceptor + custom adapter (no network)',
    expected: 'ok:hi:intercepted',
    app: `import { useEffect, useState } from 'react';
import axios from 'axios';
const api = axios.create({ baseURL: 'https://example.invalid' });
api.interceptors.request.use((cfg) => { cfg.headers.set('x-test', 'intercepted'); return cfg; });
export function App() {
  const [s, setS] = useState('');
  useEffect(() => {
    api.get('/hello', {
      adapter: async (config) => ({ data: 'hi:' + config.headers.get('x-test'), status: 200, statusText: 'OK', headers: {}, config }),
    }).then((r) => setS(String(r.data)));
  }, []);
  return <div data-testid="marker">ok:{s}</div>;
}`,
  }),

  // ---------------------------------------------------------------- UI
  c({
    id: 'lucide-react',
    name: 'lucide-react',
    version: '1.51.0',
    category: 'ui',
    checks: 'icon components render SVGs',
    expected: 'ok:2',
    app: `import { useEffect, useState } from 'react';
import { Camera, Heart } from 'lucide-react';
export function App() {
  const [s, setS] = useState('');
  useEffect(() => { setS(String(document.querySelectorAll('#icons svg').length)); }, []);
  return <div><div id="icons"><Camera size={24} /><Heart color="red" /></div><div data-testid="marker">ok:{s}</div></div>;
}`,
  }),
  c({
    id: 'react-icons',
    name: 'react-icons',
    version: '5.7.0',
    category: 'ui',
    checks: 'react-icons/fa + react-icons/md subpaths render SVGs',
    expected: 'ok:2',
    app: `import { useEffect, useState } from 'react';
import { FaGithub } from 'react-icons/fa';
import { MdHome } from 'react-icons/md';
export function App() {
  const [s, setS] = useState('');
  useEffect(() => { setS(String(document.querySelectorAll('#icons svg').length)); }, []);
  return <div><div id="icons"><FaGithub /><MdHome /></div><div data-testid="marker">ok:{s}</div></div>;
}`,
  }),
  c({
    id: '@headlessui/react',
    name: '@headlessui/react',
    version: '2.2.10',
    category: 'ui',
    checks: 'Disclosure opens on click (programmatic)',
    expected: 'ok:open',
    app: `import { useEffect, useState } from 'react';
import { Disclosure, DisclosureButton, DisclosurePanel } from '@headlessui/react';
export function App() {
  const [s, setS] = useState('');
  useEffect(() => {
    document.querySelector<HTMLButtonElement>('#btn')!.click();
    const t = setInterval(() => { if (document.querySelector('#panel')) { setS('open'); clearInterval(t); } }, 50);
    return () => clearInterval(t);
  }, []);
  return <div><Disclosure><DisclosureButton id="btn">More</DisclosureButton><DisclosurePanel id="panel">Details</DisclosurePanel></Disclosure><div data-testid="marker">ok:{s}</div></div>;
}`,
  }),
  c({
    id: 'react-hot-toast',
    name: 'react-hot-toast',
    version: '2.6.1',
    category: 'ui',
    checks: '<Toaster/> shows toast.success()',
    expected: 'ok:shown',
    app: `import { useEffect, useState } from 'react';
import toast, { Toaster } from 'react-hot-toast';
export function App() {
  const [s, setS] = useState('');
  useEffect(() => {
    toast.success('Saved!');
    const t = setInterval(() => { if (document.body.textContent?.includes('Saved!')) { setS('shown'); clearInterval(t); } }, 50);
    return () => clearInterval(t);
  }, []);
  return <div><Toaster /><div data-testid="marker">ok:{s}</div></div>;
}`,
  }),
  c({
    id: 'sonner',
    name: 'sonner',
    version: '2.0.8',
    category: 'ui',
    checks: '<Toaster/> shows toast()',
    expected: 'ok:shown',
    app: `import { useEffect, useState } from 'react';
import { Toaster, toast } from 'sonner';
export function App() {
  const [s, setS] = useState('');
  useEffect(() => {
    setTimeout(() => toast('Hello sonner'), 50);
    const t = setInterval(() => { if (document.querySelector('[data-sonner-toast]')) { setS('shown'); clearInterval(t); } }, 50);
    return () => clearInterval(t);
  }, []);
  return <div><Toaster /><div data-testid="marker">ok:{s}</div></div>;
}`,
  }),
  c({
    id: 'styled-components',
    name: 'styled-components',
    version: '6.5.3',
    category: 'ui',
    checks: 'styled.div applies a computed style',
    expected: 'ok:rgb(255, 0, 0)',
    app: `import { useEffect, useRef, useState } from 'react';
import styled from 'styled-components';
const Box = styled.div\`color: red; padding: 4px;\`;
export function App() {
  const ref = useRef<HTMLDivElement>(null);
  const [s, setS] = useState('');
  useEffect(() => { setS(getComputedStyle(ref.current!).color); }, []);
  return <div><Box ref={ref}>styled</Box><div data-testid="marker">ok:{s}</div></div>;
}`,
  }),
  c({
    id: '@emotion/react',
    name: '@emotion/react',
    version: '11.14.0',
    category: 'ui',
    checks: 'css prop via @jsxImportSource @emotion/react',
    expected: 'ok:rgb(0, 128, 0)',
    app: `/** @jsxImportSource @emotion/react */
import { useEffect, useRef, useState } from 'react';
import { css } from '@emotion/react';
export function App() {
  const ref = useRef<HTMLDivElement>(null);
  const [s, setS] = useState('');
  useEffect(() => { setS(getComputedStyle(ref.current!).color); }, []);
  return <div><div ref={ref} css={css\`color: green;\`}>emotion</div><div data-testid="marker">ok:{s}</div></div>;
}`,
  }),

  // ---------------------------------------------------------------- misc
  c({
    id: 'marked',
    name: 'marked',
    version: '18.0.14',
    category: 'misc',
    checks: 'marked.parse markdown to HTML',
    expected: 'ok:<h1>Hi</h1>',
    app: `import { marked } from 'marked';
const html = String(marked.parse('# Hi')).trim();
export function App() {
  return <div data-testid="marker">ok:{html}</div>;
}`,
  }),
  c({
    id: 'highlight.js',
    name: 'highlight.js',
    version: '11.12.0',
    category: 'misc',
    checks: 'core + javascript language subpaths + theme CSS',
    expected: 'ok:true',
    app: `import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import 'highlight.js/styles/github.css';
hljs.registerLanguage('javascript', javascript);
const out = hljs.highlight('const x = 1;', { language: 'javascript' }).value;
export function App() {
  return <div data-testid="marker">ok:{String(out.includes('hljs-keyword'))}</div>;
}`,
  }),
  c({
    id: 'roughjs',
    name: 'roughjs',
    version: '4.6.6',
    category: 'misc',
    checks: 'rough.svg().rectangle appended to an SVG',
    expected: 'ok:g',
    app: `import { useEffect, useRef, useState } from 'react';
import rough from 'roughjs';
export function App() {
  const svg = useRef<SVGSVGElement>(null);
  const [s, setS] = useState('');
  useEffect(() => {
    const node = rough.svg(svg.current!).rectangle(10, 10, 80, 40, { roughness: 1.5 });
    svg.current!.appendChild(node);
    setS(node.tagName);
  }, []);
  return <div><svg ref={svg} width={100} height={60} /><div data-testid="marker">ok:{s}</div></div>;
}`,
  }),
  c({
    id: 'leaflet',
    name: 'leaflet',
    version: '1.9.4',
    category: 'misc',
    checks: 'L.map + marker, with leaflet/dist/leaflet.css',
    expected: 'ok:13:absolute',
    app: `import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
export function App() {
  const host = useRef<HTMLDivElement>(null);
  const [s, setS] = useState('');
  useEffect(() => {
    const map = L.map(host.current!).setView([51.5, -0.09], 13);
    L.circleMarker([51.5, -0.09]).addTo(map);
    const pane = host.current!.querySelector('.leaflet-pane');
    setS(map.getZoom() + ':' + (pane ? getComputedStyle(pane).position : 'none'));
    return () => { map.remove(); };
  }, []);
  return <div><div ref={host} style={{ width: 200, height: 150 }} /><div data-testid="marker">ok:{s}</div></div>;
}`,
  }),
  c({
    id: 'react-leaflet',
    name: 'react-leaflet',
    version: '5.0.0',
    category: 'misc',
    deps: { leaflet: '1.9.4' },
    checks: '<MapContainer> + <CircleMarker>, useMap inside',
    expected: 'ok:10',
    app: `import { useEffect, useState } from 'react';
import { CircleMarker, MapContainer, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
function Zoom({ onZoom }: { onZoom: (z: number) => void }) {
  const map = useMap();
  useEffect(() => { onZoom(map.getZoom()); }, [map]);
  return null;
}
export function App() {
  const [s, setS] = useState('');
  return <div><MapContainer center={[48.85, 2.35]} zoom={10} style={{ width: 200, height: 150 }}><CircleMarker center={[48.85, 2.35]} radius={5} /><Zoom onZoom={(z) => setS(String(z))} /></MapContainer><div data-testid="marker">ok:{s}</div></div>;
}`,
  }),
  c({
    id: '@tanstack/react-query',
    name: '@tanstack/react-query',
    version: '5.104.1',
    category: 'misc',
    checks: 'QueryClientProvider + useQuery with a local queryFn',
    expected: 'ok:data',
    app: `import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
const client = new QueryClient();
function Q() {
  const q = useQuery({ queryKey: ['x'], queryFn: async () => 'data' });
  return <div data-testid="marker">ok:{q.data ?? ''}</div>;
}
export function App() {
  return <QueryClientProvider client={client}><Q /></QueryClientProvider>;
}`,
  }),
  c({
    id: 'swr',
    name: 'swr',
    version: '2.5.1',
    category: 'misc',
    checks: 'useSWR with a local fetcher',
    expected: 'ok:fetched:k',
    app: `import useSWR from 'swr';
export function App() {
  const { data } = useSWR('k', async (key: string) => 'fetched:' + key);
  return <div data-testid="marker">ok:{data ?? ''}</div>;
}`,
  }),
  c({
    id: 'react-router-dom',
    name: 'react-router-dom',
    version: '7.18.4',
    category: 'misc',
    checks: 'MemoryRouter + Routes + useNavigate',
    expected: 'ok:about',
    app: `import { useEffect } from 'react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
function Home() {
  const nav = useNavigate();
  useEffect(() => { nav('/about'); }, []);
  return <div data-testid="marker">ok:home</div>;
}
export function App() {
  return <MemoryRouter><Routes><Route path="/" element={<Home />} /><Route path="/about" element={<div data-testid="marker">ok:about</div>} /></Routes></MemoryRouter>;
}`,
  }),
  // T-035: one react-dom instance across the import map. react-dom/client registers its
  // renderer on the internals of the `react-dom` it imports; `flushSync` from the app's
  // `react-dom` only flushes when that is the same module (a second copy flushes nothing).
  // On esm.sh this depends on how it resolves react-dom/client's own `react-dom` import.
  c({
    id: 'react-dom (flushSync, one instance)',
    name: 'react-dom',
    version: REACT_VERSION,
    category: 'misc',
    checks: "flushSync from 'react-dom' commits a render started by react-dom/client",
    expected: 'ok:sync',
    app: `import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
export function App() {
  const [n, setN] = useState(0);
  const [result, setResult] = useState('');
  const span = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    // Outside React's own work (an effect would defer the flush).
    const t = setTimeout(() => {
      flushSync(() => setN(1));
      setResult(span.current?.textContent === '1' ? 'sync' : 'not-sync');
    }, 0);
    return () => clearTimeout(t);
  }, []);
  return <div><span ref={span}>{n}</span><div data-testid="marker">ok:{result}</div></div>;
}`,
  }),
];
