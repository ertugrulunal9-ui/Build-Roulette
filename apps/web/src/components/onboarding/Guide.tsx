'use client';

/**
 * `/how-it-works` (T-049, docs/09 §9.6): the full guide. The game in one minute, the rules
 * for a site, a checklist before the first battle, tool guides (tabs), a line to add to the
 * prompt, where each framework writes its build, troubleshooting and a FAQ.
 *
 * A static page, prerendered in English; in the browser it follows the page's language
 * (T-050), so it is a client component.
 */
import Link from 'next/link';
import type { ReactNode } from 'react';
import { ArrowUpRightIcon } from '@phosphor-icons/react/dist/csr/ArrowUpRight';
import { CheckIcon } from '@phosphor-icons/react/dist/csr/Check';
import { useT } from '../../lib/i18n/context';
import type { Messages } from '../../lib/i18n/messages/en';
import { AppHeader } from '../ui/AppHeader';
import { PageTitle } from '../i18n/PageTitle';
import { CodeText } from '../site/CodeText';
import { NODE_URL, TOOL_IDS, TRY_PATH } from './copy';
import { CopyPrompt } from './CopyPrompt';
import { StepCards } from './Steps';
import { ToolTabs } from './ToolTabs';
import './onboarding.css';

const SECTION_IDS = [
  'one-minute',
  'rules',
  'checklist',
  'tools',
  'prompt',
  'build-folders',
  'troubleshooting',
  'faq',
] as const;

type SectionId = (typeof SECTION_IDS)[number];

function sectionTitle(id: SectionId, g: Messages['guide']): string {
  const titles: Record<SectionId, string> = {
    'one-minute': g.oneMinuteTitle,
    rules: g.rulesTitle,
    checklist: g.checklistTitle,
    tools: g.toolsTitle,
    prompt: g.promptTitle,
    'build-folders': g.foldersTitle,
    troubleshooting: g.troubleTitle,
    faq: g.faqTitle,
  };
  return titles[id];
}

function Section({ id, children }: { id: SectionId; children: ReactNode }) {
  const g = useT().guide;
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      data-testid={`guide-${id}`}
      className="br-guide__section scroll-mt-6 flex flex-col gap-4"
    >
      <h2
        id={`${id}-title`}
        className="br-guide__section-title text-2xl font-black tracking-tight sm:text-3xl"
      >
        {sectionTitle(id, g)}
      </h2>
      {children}
    </section>
  );
}

const button = 'br-btn';
const card =
  'rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm sm:p-5 dark:border-zinc-800 dark:bg-zinc-900';

interface Linked {
  text: string;
  link?: { label: string; href: string; external?: boolean };
}

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
  const t = useT();
  const g = t.guide;
  const checklist: Linked[] = [
    { text: g.checklist.tool },
    { text: g.checklist.folder },
    { text: g.checklist.node, link: { label: 'nodejs.org', href: NODE_URL, external: true } },
    { text: g.checklist.practice, link: { label: g.practice, href: TRY_PATH } },
  ];
  const tools = TOOL_IDS.map((id) => ({ id, ...g.tools[id] }));
  return (
    <main className="br-page br-guide flex w-full flex-col">
      <AppHeader guide={false} practice className="br-guide__header" />
      <div className="br-guide__content mx-auto flex w-full max-w-4xl flex-col gap-12 px-4 py-8 sm:px-6 sm:py-12">
        <PageTitle page="guide" />
        <header className="br-guide__hero flex flex-col gap-5">
          <p className="br-eyebrow text-xs font-black tracking-widest text-zinc-500 uppercase">
            {t.common.howItWorks}
          </p>
          <h1 className="br-display text-4xl font-black tracking-tight sm:text-5xl">{g.title}</h1>
          <p className="max-w-2xl text-lg text-zinc-600 dark:text-zinc-400">{g.intro}</p>
        </header>

        <div className="br-guide__layout">
          <aside className="br-guide__aside">
            <nav
              className="br-guide__contents"
              aria-label={g.contents}
              data-testid="guide-contents"
            >
              <p>{g.contents}</p>
              <ol>
                {SECTION_IDS.map((id, i) => (
                  <li key={id}>
                    <a href={`#${id}`} className="br-guide__contents-link">
                      <span>{String(i + 1).padStart(2, '0')}</span>
                      {sectionTitle(id, g)}
                    </a>
                  </li>
                ))}
              </ol>
            </nav>
          </aside>
          <div className="br-guide__sections">
            <Section id="one-minute">
              <StepCards label={g.oneMinuteTitle} />
            </Section>

            <Section id="rules">
              <ul className={`${card} br-guide__list flex flex-col gap-2.5`}>
                {g.rules.map((r, i) => (
                  <li key={i} className="flex gap-3">
                    <CheckIcon aria-hidden="true" className="br-guide__check" weight="bold" />
                    <span>
                      <CodeText text={r} />
                    </span>
                  </li>
                ))}
              </ul>
            </Section>

            <Section id="checklist">
              <ul className={`${card} br-guide__list flex flex-col gap-2.5`}>
                {checklist.map((item, i) => (
                  <li key={i} className="flex gap-3">
                    <span aria-hidden="true" className="br-guide__checkbox" />
                    <span>
                      <LinkedText item={item} />
                    </span>
                  </li>
                ))}
              </ul>
            </Section>

            <Section id="tools">
              <p className="text-zinc-600 dark:text-zinc-400">{g.toolsIntro}</p>
              <ToolTabs guides={tools} label={g.toolsLabel} />
            </Section>

            <Section id="prompt">
              <p className="text-zinc-600 dark:text-zinc-400">{g.promptIntro}</p>
              <CopyPrompt />
            </Section>

            <Section id="build-folders">
              <div className={`${card} overflow-x-auto p-0 sm:p-0`}>
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-zinc-200 text-xs tracking-wide text-zinc-500 uppercase dark:border-zinc-800">
                    <tr>
                      <th scope="col" className="px-4 py-3 font-bold">
                        {g.foldersProject}
                      </th>
                      <th scope="col" className="px-4 py-3 font-bold">
                        {g.foldersDrop}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                    {g.folders.map((f, i) => (
                      <tr key={i}>
                        <th scope="row" className="w-3/5 px-4 py-3 align-top font-normal">
                          <span className="block font-semibold">{f.project}</span>
                          <span className="text-zinc-600">
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
                <CodeText text={g.foldersNote} />
              </p>
            </Section>

            <Section id="troubleshooting">
              <dl className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {g.trouble.map((item, i) => (
                  <div key={i} className={card}>
                    <dt className="font-bold">{item.problem}</dt>
                    <dd className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                      <CodeText text={item.fix} />
                    </dd>
                  </div>
                ))}
              </dl>
            </Section>

            <Section id="faq">
              <div className="flex flex-col gap-2">
                {g.faq.map((f, i) => (
                  <details
                    key={i}
                    className="group rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
                  >
                    <summary className="br-guide__faq-question flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-4 py-3 font-bold focus-visible:outline-2 focus-visible:outline-sky-500 [&::-webkit-details-marker]:hidden">
                      {f.q}
                      <span
                        aria-hidden="true"
                        className="text-zinc-400 transition-transform group-open:rotate-180"
                      >
                        <ArrowUpRightIcon size={17} />
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
              <h2 className="text-2xl font-black tracking-tight">{g.ready}</h2>
              <p className="text-zinc-600 dark:text-zinc-400">{g.readyText}</p>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Link href="/try" className={`${button} br-btn--secondary`}>
                  {g.practice}
                </Link>
                <Link href="/play" className={`${button} br-btn--primary`}>
                  {g.play}
                </Link>
                <Link href="/" className={`${button} br-btn--secondary`}>
                  {g.home}
                </Link>
              </div>
            </footer>
          </div>
        </div>
      </div>
    </main>
  );
}
