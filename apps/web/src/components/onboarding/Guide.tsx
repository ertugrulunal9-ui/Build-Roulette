/**
 * `/how-it-works` (T-049, docs/09 §9.6): the full guide. The game in one minute, the rules
 * for a site, a checklist before the first battle, tool guides (tabs), a line to add to the
 * prompt, where each framework writes its build, troubleshooting and a FAQ.
 *
 * A server component (the page is static HTML); the tabs and the Copy button are client
 * islands.
 */
import Link from 'next/link';
import type { ReactNode } from 'react';
import { CodeText } from '../site/CodeText';
import { GUIDE_COPY, HOW_IT_WORKS, type Linked } from './copy';
import { CopyPrompt } from './CopyPrompt';
import { StepCards } from './Steps';
import { ToolTabs } from './ToolTabs';

const SECTIONS = [
  { id: 'one-minute', title: GUIDE_COPY.oneMinuteTitle },
  { id: 'rules', title: GUIDE_COPY.rulesTitle },
  { id: 'checklist', title: GUIDE_COPY.checklistTitle },
  { id: 'tools', title: GUIDE_COPY.toolsTitle },
  { id: 'prompt', title: GUIDE_COPY.promptTitle },
  { id: 'build-folders', title: GUIDE_COPY.foldersTitle },
  { id: 'troubleshooting', title: GUIDE_COPY.troubleTitle },
  { id: 'faq', title: GUIDE_COPY.faqTitle },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];

const titleOf = (id: SectionId): string => SECTIONS.find((s) => s.id === id)?.title ?? '';

function Section({ id, children }: { id: SectionId; children: ReactNode }) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      data-testid={`guide-${id}`}
      className="scroll-mt-6 flex flex-col gap-4"
    >
      <h2 id={`${id}-title`} className="text-2xl font-black tracking-tight sm:text-3xl">
        {titleOf(id)}
      </h2>
      {children}
    </section>
  );
}

const button =
  'inline-flex min-h-11 items-center justify-center rounded-xl px-5 py-2.5 text-sm font-bold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500';
const card =
  'rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm sm:p-5 dark:border-zinc-800 dark:bg-zinc-900';

function LinkedText({ item }: { item: Linked }) {
  return (
    <>
      <CodeText text={item.text} />
      {item.link && (
        <>
          {' '}
          {item.link.external ? (
            <a
              href={item.link.href}
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold underline underline-offset-2"
            >
              {item.link.label}
              <span aria-hidden="true"> ↗</span>
            </a>
          ) : (
            <Link href={item.link.href} className="font-semibold underline underline-offset-2">
              {item.link.label}
            </Link>
          )}
        </>
      )}
    </>
  );
}

export function Guide() {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-12 px-4 py-8 sm:px-6 sm:py-12">
      <header className="flex flex-col gap-5">
        <nav className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <Link href="/" className="font-semibold text-zinc-500 hover:underline">
            Build Roulette
          </Link>
          <Link
            href="/try"
            className="rounded-full border border-zinc-300 px-3 py-1 font-semibold hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            {GUIDE_COPY.practice}
          </Link>
        </nav>
        <p className="text-xs font-black tracking-widest text-zinc-500 uppercase">{HOW_IT_WORKS}</p>
        <h1 className="text-4xl font-black tracking-tight sm:text-5xl">{GUIDE_COPY.title}</h1>
        <p className="max-w-2xl text-lg text-zinc-600 dark:text-zinc-400">{GUIDE_COPY.intro}</p>
        <nav aria-label={GUIDE_COPY.contents} data-testid="guide-contents">
          <ul className="flex flex-wrap gap-2">
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <a
                  href={`#${s.id}`}
                  className="inline-block rounded-full bg-zinc-200/70 px-3 py-1 text-sm font-semibold text-zinc-700 hover:bg-zinc-300/70 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
                >
                  {s.title}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </header>

      <Section id="one-minute">
        <StepCards label={GUIDE_COPY.oneMinuteTitle} />
      </Section>

      <Section id="rules">
        <ul className={`${card} flex flex-col gap-2.5`}>
          {GUIDE_COPY.rules.map((r) => (
            <li key={r} className="flex gap-3">
              <span aria-hidden="true" className="text-emerald-600 dark:text-emerald-400">
                ✓
              </span>
              <span>
                <CodeText text={r} />
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="checklist">
        <ul className={`${card} flex flex-col gap-2.5`}>
          {GUIDE_COPY.checklist.map((item) => (
            <li key={item.text} className="flex gap-3">
              <span aria-hidden="true">☐</span>
              <span>
                <LinkedText item={item} />
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="tools">
        <p className="text-zinc-600 dark:text-zinc-400">{GUIDE_COPY.toolsIntro}</p>
        <ToolTabs guides={GUIDE_COPY.tools} label={GUIDE_COPY.toolsLabel} />
      </Section>

      <Section id="prompt">
        <p className="text-zinc-600 dark:text-zinc-400">{GUIDE_COPY.promptIntro}</p>
        <CopyPrompt />
      </Section>

      <Section id="build-folders">
        <div className={`${card} overflow-x-auto p-0 sm:p-0`}>
          <table className="w-full text-left text-sm">
            <thead className="border-b border-zinc-200 text-xs tracking-wide text-zinc-500 uppercase dark:border-zinc-800">
              <tr>
                <th scope="col" className="px-4 py-3 font-bold">
                  {GUIDE_COPY.foldersProject}
                </th>
                <th scope="col" className="px-4 py-3 font-bold">
                  {GUIDE_COPY.foldersDrop}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {GUIDE_COPY.folders.map((f) => (
                <tr key={f.project}>
                  <th scope="row" className="w-3/5 px-4 py-3 align-top font-normal">
                    <span className="block font-semibold">{f.project}</span>
                    <span className="text-zinc-500">
                      <CodeText text={f.how} />
                    </span>
                  </th>
                  <td className="px-4 py-3 align-top font-semibold [overflow-wrap:anywhere] sm:whitespace-nowrap">
                    <CodeText text={f.folder} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          <CodeText text={GUIDE_COPY.foldersNote} />
        </p>
      </Section>

      <Section id="troubleshooting">
        <dl className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {GUIDE_COPY.trouble.map((t) => (
            <div key={t.problem} className={card}>
              <dt className="font-bold">{t.problem}</dt>
              <dd className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                <CodeText text={t.fix} />
              </dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section id="faq">
        <div className="flex flex-col gap-2">
          {GUIDE_COPY.faq.map((f) => (
            <details
              key={f.q}
              className="group rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
            >
              <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-4 py-3 font-bold focus-visible:outline-2 focus-visible:outline-sky-500 [&::-webkit-details-marker]:hidden">
                {f.q}
                <span
                  aria-hidden="true"
                  className="text-zinc-400 transition-transform group-open:rotate-180"
                >
                  ▾
                </span>
              </summary>
              <p className="border-t border-zinc-200 px-4 py-3 text-sm text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
                {f.a}
              </p>
            </details>
          ))}
        </div>
      </Section>

      <footer className={`${card} flex flex-col items-center gap-4 text-center`}>
        <h2 className="text-2xl font-black tracking-tight">{GUIDE_COPY.ready}</h2>
        <p className="text-zinc-600 dark:text-zinc-400">{GUIDE_COPY.readyText}</p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Link
            href="/try"
            className={`${button} border border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800`}
          >
            {GUIDE_COPY.practice}
          </Link>
          <Link href="/play" className={`${button} bg-emerald-600 text-white hover:bg-emerald-700`}>
            {GUIDE_COPY.play}
          </Link>
          <Link
            href="/"
            className={`${button} bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white`}
          >
            {GUIDE_COPY.home}
          </Link>
        </div>
      </footer>
    </main>
  );
}
