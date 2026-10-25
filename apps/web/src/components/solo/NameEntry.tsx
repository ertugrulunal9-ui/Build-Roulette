'use client';

import { DiceFiveIcon } from '@phosphor-icons/react/dist/csr/DiceFive';
import { useState } from 'react';
import { useT } from '../../lib/i18n/context';
import { describeError, type GameError } from '../../lib/solo/errors';
import { randomDisplayName } from '../../lib/solo/names';
import { HowItWorksButton, Welcome } from '../onboarding/Welcome';
import { AppHeader } from '../ui/AppHeader';
import './solo-screens.css';

const NAME_KEY = 'br:display-name';

function initialName(): string {
  try {
    const saved = window.localStorage.getItem(NAME_KEY);
    if (saved && saved.trim().length > 0) return saved.slice(0, 24);
  } catch {
    // storage blocked
  }
  return randomDisplayName();
}

interface NameEntryProps {
  busy: boolean;
  error: GameError | null;
  onSpin: (name: string) => void;
}

/**
 * One input with a random fun default name, and the Spin button. Before a battle, so the
 * welcome screen (T-049) may show here on the first visit, and "How it works" reopens it.
 */
export function NameEntry({ busy, error, onSpin }: NameEntryProps) {
  const t = useT();
  const [name, setName] = useState(initialName);
  const trimmed = name.trim();

  return (
    <main className="br-page br-name-page">
      <AppHeader actions={<HowItWorksButton />} guide={false} />
      <div className="br-name-layout">
        <section className="br-name-intro">
          <h1 className="br-display">{t.solo.title}</h1>
          <p className="br-name-lede">{t.solo.intro}</p>
          <ul className="br-name-challenge" aria-label={t.solo.title}>
            {(['build', 'rule', 'style'] as const).map((kind, index) => (
              <li key={kind} className={`br-name-challenge__${kind}`}>
                <span>
                  {String(index + 1).padStart(2, '0')} · {t.cards[kind]}
                </span>
                <strong>
                  {kind === 'build'
                    ? t.home.sampleBuild
                    : kind === 'rule'
                      ? t.home.sampleRule
                      : t.home.sampleStyle}
                </strong>
              </li>
            ))}
          </ul>
        </section>

        <form
          className="br-surface br-surface-pad br-name-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (trimmed.length === 0 || busy) return;
            try {
              window.localStorage.setItem(NAME_KEY, trimmed);
            } catch {
              // storage blocked
            }
            onSpin(trimmed);
          }}
        >
          <label htmlFor="display-name" className="br-name-form__label">
            {t.common.yourName}
          </label>
          <div className="br-name-form__row">
            <input
              id="display-name"
              data-testid="display-name"
              value={name}
              maxLength={24}
              autoComplete="nickname"
              spellCheck={false}
              onChange={(e) => {
                setName(e.target.value);
              }}
              className="br-field"
            />
            <button
              type="button"
              title={t.common.anotherName}
              aria-label={t.common.anotherName}
              onClick={() => {
                setName(randomDisplayName());
              }}
              className="br-btn br-btn--secondary br-name-roll"
            >
              <DiceFiveIcon size={22} aria-hidden="true" />
            </button>
          </div>
          <button
            type="submit"
            disabled={busy || trimmed.length === 0}
            className="br-btn br-btn--primary br-name-submit"
          >
            {busy ? t.solo.spinningUp : t.solo.spin}
          </button>
          {error && (
            <p role="alert" className="br-name-error">
              {describeError(error, t)}
              {error.details &&
                !['battle_in_progress', 'name_not_allowed', 'rate_limited'].includes(
                  error.code,
                ) && <span className="block text-xs opacity-75">{error.details}</span>}
            </p>
          )}
          <p className="br-name-footer">{t.solo.footer}</p>
        </form>
      </div>
      <Welcome />
    </main>
  );
}

export function ResumeOffer({
  onResume,
  onCancel,
}: {
  onResume: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  return (
    <main className="br-page br-resume-page">
      <AppHeader practice={false} />
      <section className="br-surface br-surface-pad br-resume-card">
        <h1 className="br-display">{t.solo.resumeTitle}</h1>
        <p>{t.solo.resumeText}</p>
        <div className="br-resume-actions">
          <button type="button" onClick={onResume} className="br-btn br-btn--primary">
            {t.solo.resume}
          </button>
          <button type="button" onClick={onCancel} className="br-btn br-btn--secondary">
            {t.solo.back}
          </button>
        </div>
      </section>
    </main>
  );
}
