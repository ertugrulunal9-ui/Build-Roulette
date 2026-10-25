'use client';

import { HAPPY_PATH_PHASES, type BattlePhase } from '@br/game';
import { CheckIcon } from '@phosphor-icons/react/dist/csr/Check';
import { useT } from '../../lib/i18n/context';

export function PhaseTrack({ phase }: { phase: BattlePhase }) {
  const t = useT();
  const current = HAPPY_PATH_PHASES.findIndex((step) => step === phase);
  return (
    <ol className="br-phase-track" aria-label={t.home.phasesLabel}>
      {HAPPY_PATH_PHASES.map((step, index) => (
        <li
          key={step}
          className={index === current ? 'is-current' : index < current ? 'is-done' : ''}
          aria-current={step === phase ? 'step' : undefined}
        >
          <span className="br-phase-track__number" aria-hidden="true">
            {index < current ? <CheckIcon size={13} weight="bold" /> : index + 1}
          </span>
          <span>{t.phases[step]}</span>
        </li>
      ))}
    </ol>
  );
}
