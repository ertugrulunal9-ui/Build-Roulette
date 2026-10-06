'use client';

import { indentWithTab } from '@codemirror/commands';
import { css } from '@codemirror/lang-css';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView, keymap } from '@codemirror/view';
import { extname } from '@br/workspace';
import { basicSetup } from 'codemirror';
import { useEffect, useRef } from 'react';

export interface RevealRequest {
  path: string;
  line: number;
  column: number;
  /** Changes for every request, so revealing the same spot twice works. */
  key: number;
}

interface CodeEditorProps {
  path: string;
  value: string;
  dark: boolean;
  onChange: (path: string, value: string) => void;
  reveal: RevealRequest | null;
  /** No edits (after the deadline or once shipped). */
  readOnly?: boolean;
}

function languageFor(path: string): Extension {
  switch (extname(path)) {
    case '.ts':
    case '.mts':
    case '.cts':
      return javascript({ typescript: true });
    case '.tsx':
      return javascript({ typescript: true, jsx: true });
    case '.js':
    case '.mjs':
    case '.cjs':
      return javascript();
    case '.jsx':
      return javascript({ jsx: true });
    case '.css':
      return css();
    case '.json':
      return json();
    default:
      return [];
  }
}

const baseTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '13px' },
  '.cm-scroller': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
  },
});

const lightTheme = EditorView.theme(
  {
    '&': { backgroundColor: '#ffffff', color: '#18181b' },
    '.cm-gutters': {
      backgroundColor: '#fafafa',
      color: '#a1a1aa',
      borderRight: '1px solid #e4e4e7',
    },
  },
  { dark: false },
);

/**
 * CodeMirror 6 editor. One EditorView; each file keeps its own EditorState (undo history,
 * selection) while it is unchanged from outside.
 */
function readOnlyExtension(readOnly: boolean): Extension {
  return readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [];
}

export function CodeEditor({
  path,
  value,
  dark,
  onChange,
  reveal,
  readOnly = false,
}: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const statesRef = useRef(new Map<string, EditorState>());
  const pathRef = useRef(path);
  const onChangeRef = useRef(onChange);
  const darkRef = useRef(dark);
  const themeRef = useRef(new Compartment());
  const readOnlyRef = useRef(readOnly);
  const readOnlyCompartment = useRef(new Compartment());

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const createState = (filePath: string, doc: string): EditorState =>
    EditorState.create({
      doc,
      extensions: [
        basicSetup,
        keymap.of([indentWithTab]),
        languageFor(filePath),
        baseTheme,
        themeRef.current.of(darkRef.current ? oneDark : lightTheme),
        readOnlyCompartment.current.of(readOnlyExtension(readOnlyRef.current)),
        EditorView.contentAttributes.of({ 'aria-label': `Code editor: ${filePath}` }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(pathRef.current, update.state.doc.toString());
          }
        }),
      ],
    });

  // Mount once.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const states = statesRef.current;
    const view = new EditorView({ parent: host, state: createState(pathRef.current, value) });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
      states.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the view is created once; later props are applied by the effects below
  }, []);

  // Switch files / apply outside changes (paste-import, reset, rejected edits).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (path !== pathRef.current) {
      statesRef.current.set(pathRef.current, view.state);
      pathRef.current = path;
      const cached = statesRef.current.get(path);
      view.setState(cached?.doc.toString() === value ? cached : createState(path, value));
      view.dispatch({
        effects: themeRef.current.reconfigure(darkRef.current ? oneDark : lightTheme),
      });
      return;
    }
    if (view.state.doc.toString() !== value) {
      // Changed outside the editor: start a fresh state, so undo cannot resurrect content
      // that the workspace no longer has (or refused, e.g. over the size limit).
      view.setState(createState(path, value));
    }
  }, [path, value]);

  useEffect(() => {
    darkRef.current = dark;
    viewRef.current?.dispatch({
      effects: themeRef.current.reconfigure(dark ? oneDark : lightTheme),
    });
  }, [dark]);

  useEffect(() => {
    readOnlyRef.current = readOnly;
    viewRef.current?.dispatch({
      effects: readOnlyCompartment.current.reconfigure(readOnlyExtension(readOnly)),
    });
  }, [readOnly]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || reveal?.path !== pathRef.current) return;
    const doc = view.state.doc;
    const line = doc.line(Math.min(Math.max(1, reveal.line), doc.lines));
    const pos = Math.min(line.from + Math.max(0, reveal.column), line.to);
    view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
    view.focus();
  }, [reveal]);

  return (
    <div
      ref={hostRef}
      className="h-full min-h-0 overflow-hidden"
      data-testid="code-editor"
      data-readonly={readOnly ? 'true' : undefined}
    />
  );
}
