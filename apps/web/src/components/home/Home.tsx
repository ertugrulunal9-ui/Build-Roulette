'use client';

import { ArrowRightIcon as ArrowRight } from '@phosphor-icons/react/dist/csr/ArrowRight';
import { FolderSimpleIcon as FolderSimple } from '@phosphor-icons/react/dist/csr/FolderSimple';
import { LightbulbIcon as Lightbulb } from '@phosphor-icons/react/dist/csr/Lightbulb';
import { LaptopIcon as Laptop } from '@phosphor-icons/react/dist/csr/Laptop';
import { SparkleIcon as Sparkle } from '@phosphor-icons/react/dist/csr/Sparkle';
import { TimerIcon as Timer } from '@phosphor-icons/react/dist/csr/Timer';
import { ToggleRightIcon as ToggleRight } from '@phosphor-icons/react/dist/csr/ToggleRight';
import { UploadSimpleIcon as UploadSimple } from '@phosphor-icons/react/dist/csr/UploadSimple';
import { UsersThreeIcon as UsersThree } from '@phosphor-icons/react/dist/csr/UsersThree';
import { HAPPY_PATH_PHASES } from '@br/game';
import Image from 'next/image';
import Link from 'next/link';
import { openWelcome } from '../../lib/onboarding/welcome';
import { useT } from '../../lib/i18n/context';
import { LanguagePicker } from '../i18n/LanguagePicker';
import { GUIDE_PATH, TRY_PATH } from '../onboarding/copy';
import { Welcome } from '../onboarding/Welcome';
import { HomeActions } from './HomeActions';
import './home.css';

export function Home() {
  const t = useT();
  const home = t.home;
  const cards = [
    {
      key: 'build',
      label: t.cards.build,
      sample: home.sampleBuild,
      tone: 'blue',
      icon: Sparkle,
    },
    {
      key: 'rule',
      label: t.cards.rule,
      sample: home.sampleRule,
      tone: 'peach',
      icon: ToggleRight,
    },
    {
      key: 'style',
      label: t.cards.style,
      sample: home.sampleStyle,
      tone: 'lime',
      icon: Laptop,
    },
    {
      key: 'time',
      label: t.cards.timeLimit,
      sample: home.sampleTime,
      tone: 'lavender',
      icon: Timer,
    },
  ];
  const steps = [
    { id: 'spin', Icon: Sparkle },
    { id: 'build', Icon: Laptop },
    { id: 'import', Icon: UploadSimple },
    { id: 'reveal', Icon: UsersThree },
  ] as const;

  return (
    <main className="br-home">
      <header className="br-home__nav">
        <Link href="/" className="br-home__brand" aria-label={home.title}>
          <Image
            src="/home/brand-mark.png"
            alt=""
            width={128}
            height={133}
            style={{ height: 'auto' }}
            unoptimized
          />
          <span>{home.title}</span>
        </Link>
        <nav className="br-home__navlinks" aria-label={home.navigationLabel}>
          <button
            type="button"
            data-testid="how-it-works"
            aria-haspopup="dialog"
            onClick={openWelcome}
            className="br-home__navlink br-home__nav-button"
          >
            <Lightbulb weight="fill" aria-hidden="true" />
            {t.common.howItWorks}
          </button>
          <Link href={TRY_PATH} className="br-home__navlink" data-testid="home-try">
            <FolderSimple weight="fill" aria-hidden="true" />
            {home.tryImport}
          </Link>
          <LanguagePicker className="br-home__language" />
        </nav>
      </header>

      <section className="br-home__hero">
        <div className="br-home__headline-wrap">
          <h1
            className="br-home__headline"
            aria-label={`${home.title}: ${home.heroLineOne} ${home.heroLineTwo}`}
          >
            <span>{home.heroLineOne}</span>
            <span className="br-home__headline-blue">
              {home.heroLineTwo}
              <Image
                className="br-home__underline"
                src="/home/headline-underline.png"
                alt=""
                width={300}
                height={14}
                unoptimized
              />
            </span>
          </h1>
          <Image
            className="br-home__rays"
            src="/home/headline-rays.png"
            alt=""
            width={45}
            height={50}
            unoptimized
          />
        </div>
        <div className="br-home__pitch">
          <p data-testid="pitch">{home.heroPitch}</p>
          <HomeActions />
        </div>
      </section>

      <section className="br-home__challenge" aria-label={home.challengeTitle}>
        <p className="br-home__eyebrow">{home.challengeTitle}</p>
        <div className="br-home__challenge-grid">
          {cards.map(({ key, label, sample, tone, icon: Icon }, i) => (
            <article
              key={key}
              className={`br-home__challenge-card br-home__challenge-card--${tone}`}
            >
              <p className="br-home__challenge-label">
                {key !== 'time' && <span>{String(i + 1).padStart(2, '0')}</span>}
                {label}
              </p>
              <div className="br-home__challenge-sample">
                {key === 'time' && <Icon weight="regular" aria-hidden="true" />}
                <strong>{sample}</strong>
                {key === 'build' || key === 'style' ? (
                  <Image
                    className={`br-home__sample-art br-home__sample-art--${key}`}
                    src={key === 'build' ? '/home/tomato.png' : '/home/arcade.png'}
                    alt=""
                    width={key === 'build' ? 90 : 92}
                    height={key === 'build' ? 105 : 92}
                    unoptimized
                  />
                ) : key === 'time' ? null : (
                  <Icon weight="duotone" aria-hidden="true" />
                )}
              </div>
            </article>
          ))}
        </div>
        <p className="br-home__limits">{home.playersAndAccount}</p>
      </section>

      <section
        className="br-home__steps"
        aria-labelledby="home-steps-title"
        data-testid="home-steps"
      >
        <h2 id="home-steps-title" className="sr-only">
          {home.stepsTitle}
        </h2>
        <ol className="br-home__step-grid" data-testid="step-cards">
          {steps.map(({ id, Icon }, i) => (
            <li className="br-home__step" data-testid="step-card" key={id}>
              <span className="br-home__step-number">0{i + 1}</span>
              <Icon className="br-home__step-icon" aria-hidden="true" />
              <h3>{home.quickSteps[id].title}</h3>
              <p>{home.quickSteps[id].text}</p>
            </li>
          ))}
        </ol>
        <ol className="sr-only" aria-label={home.phasesLabel}>
          {HAPPY_PATH_PHASES.map((phase) => (
            <li key={phase}>{t.phases[phase]}</li>
          ))}
        </ol>
        <Link href={GUIDE_PATH} className="br-home__guide" data-testid="home-guide">
          {home.guide} <ArrowRight aria-hidden="true" />
        </Link>
      </section>
      <p className="br-home__tagline">{home.tagline}</p>
      <Welcome />
    </main>
  );
}
