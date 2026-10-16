'use client';

/**
 * The guide's "line to add to your prompt" with a Copy button. The Clipboard API can be
 * missing (an insecure origin, an old browser) or refuse (permissions): then the text is
 * selected and a message says to copy it by hand.
 */
import { useEffect, useRef, useState } from 'react';
import { useT } from '../../lib/i18n/context';

type CopyState = 'idle' | 'copied' | 'failed';

export function CopyPrompt({ text: given }: { text?: string }) {
  const t = useT();
  const text = given ?? t.guide.prompt;
  const [state, setState] = useState<CopyState>('idle');
  const textRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (state !== 'copied') return;
    const id = setTimeout(() => {
      setState('idle');
    }, 2000);
    return () => {
      clearTimeout(id);
    };
  }, [state]);

  const selectText = () => {
    const el = textRef.current;
    const selection = typeof window.getSelection === 'function' ? window.getSelection() : null;
    if (!el || !selection) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
  };

  const copy = async () => {
    try {
      // `navigator.clipboard` is undefined outside a secure context.
      const clipboard = navigator.clipboard as Clipboard | undefined;
      if (!clipboard) throw new Error('no clipboard');
      await clipboard.writeText(text);
      setState('copied');
    } catch {
      setState('failed');
      selectText();
    }
  };

  return (
    <div className="flex flex-col gap-2" data-testid="copy-prompt">
      <div className="flex flex-col gap-3 rounded-xl border border-zinc-200 bg-white p-3 sm:flex-row sm:items-center dark:border-zinc-800 dark:bg-zinc-900">
        <p
          ref={textRef}
          className="flex-1 font-mono text-sm text-zinc-800 dark:text-zinc-200"
          data-testid="prompt-text"
        >
          {text}
        </p>
        <button
          type="button"
          data-testid="copy-prompt-button"
          onClick={() => {
            void copy();
          }}
          className="min-h-11 shrink-0 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-bold text-white hover:bg-zinc-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
        >
          {state === 'copied' ? t.guide.copied : t.guide.copy}
        </button>
      </div>
      <p role="status" className="min-h-5 text-sm" data-testid="copy-status">
        {state === 'failed' && (
          <span className="text-amber-800 dark:text-amber-300">{t.guide.copyFailed}</span>
        )}
        {state === 'copied' && <span className="sr-only">{t.guide.copied}</span>}
      </p>
    </div>
  );
}
