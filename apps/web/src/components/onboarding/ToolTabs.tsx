'use client';

/**
 * The guide's tool guides as tabs (WAI-ARIA tabs pattern): one tab per kind of tool, arrow
 * keys / Home / End move between them (automatic activation), only the selected tab is in the
 * Tab order. Every panel is in the page's HTML (the others `hidden`), so the guide reads
 * fully without JavaScript.
 */
import { useRef, useState, type KeyboardEvent } from 'react';
import { CodeText } from '../site/CodeText';
import type { ToolId } from './copy';

/** One kind of tool: its tab, the tools, the steps and an optional note. */
export interface ToolGuide {
  id: ToolId;
  tab: string;
  tools: string;
  steps: readonly string[];
  note?: string | undefined;
}

export function ToolTabs({ guides, label }: { guides: readonly ToolGuide[]; label: string }) {
  const [selected, setSelected] = useState(0);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);

  const select = (i: number) => {
    const n = guides.length;
    const next = ((i % n) + n) % n;
    setSelected(next);
    tabs.current[next]?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const keys: Record<string, () => void> = {
      ArrowRight: () => {
        select(selected + 1);
      },
      ArrowLeft: () => {
        select(selected - 1);
      },
      Home: () => {
        select(0);
      },
      End: () => {
        select(guides.length - 1);
      },
    };
    const action = keys[e.key];
    if (!action) return;
    e.preventDefault();
    action();
  };

  return (
    <div className="flex flex-col gap-3" data-testid="tool-tabs">
      <div
        role="tablist"
        aria-label={label}
        onKeyDown={onKeyDown}
        className="grid grid-cols-2 gap-1 rounded-xl bg-zinc-200/70 p-1 sm:grid-cols-4 dark:bg-zinc-800/70"
      >
        {guides.map((g, i) => {
          const active = i === selected;
          return (
            <button
              key={g.id}
              ref={(el) => {
                tabs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`tool-tab-${g.id}`}
              aria-selected={active}
              aria-controls={`tool-panel-${g.id}`}
              tabIndex={active ? 0 : -1}
              data-testid={`tool-tab-${g.id}`}
              onClick={() => {
                select(i);
              }}
              className={`min-h-11 rounded-lg px-3 py-2 text-sm font-bold focus-visible:outline-2 focus-visible:outline-sky-500 ${
                active
                  ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-950 dark:text-zinc-100'
                  : 'text-zinc-600 hover:bg-white/60 dark:text-zinc-400 dark:hover:bg-zinc-900/60'
              }`}
            >
              {g.tab}
            </button>
          );
        })}
      </div>
      {guides.map((g, i) => (
        <div
          key={g.id}
          role="tabpanel"
          id={`tool-panel-${g.id}`}
          aria-labelledby={`tool-tab-${g.id}`}
          hidden={i !== selected}
          tabIndex={0}
          data-testid={`tool-panel-${g.id}`}
          className="rounded-2xl border border-zinc-200 bg-white p-4 focus-visible:outline-2 focus-visible:outline-sky-500 sm:p-5 dark:border-zinc-800 dark:bg-zinc-900"
        >
          <p className="text-sm font-semibold text-zinc-500">{g.tools}</p>
          <ol className="mt-3 flex flex-col gap-2">
            {g.steps.map((s, n) => (
              <li key={n} className="flex gap-3">
                <span className="grid size-6 shrink-0 place-items-center rounded-full bg-zinc-900 text-xs font-black text-white dark:bg-zinc-100 dark:text-zinc-900">
                  {n + 1}
                </span>
                <span className="pt-0.5">
                  <CodeText text={s} />
                </span>
              </li>
            ))}
          </ol>
          {g.note && (
            <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:bg-amber-950/50 dark:text-amber-100">
              {g.note}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}
