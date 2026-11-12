// @vitest-environment happy-dom
/**
 * The host's REVEAL / VOTE settings in the lobby: on/off, the time per build and the
 * voting time, only within the server's ranges (`update_room_settings`), and the summary
 * everyone else sees. The host's own cards and build time (T-053) and their summary.
 */
import {
  BUILD_TIME_LIMITS_MINUTES,
  REVEAL_SLOT_MAX_SECONDS,
  REVEAL_SLOT_MIN_SECONDS,
  VOTING_MAX_SECONDS,
  VOTING_MIN_SECONDS,
} from '@br/game';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RoomSettings } from '../../lib/room/types';
import {
  CustomCardSettings,
  REVEAL_SLOT_CHOICES,
  RevealVoteSettings,
  VOTING_CHOICES,
  cardsSummary,
  settingsSummary,
} from './Lobby';
import { tr } from '../../lib/i18n/messages/tr';

afterEach(cleanup);

function renderSettings(settings: RoomSettings, disabled = false) {
  const onChange = vi.fn();
  render(createElement(RevealVoteSettings, { settings, disabled, onChange }));
  return onChange;
}

describe('reveal and vote settings (host)', () => {
  it('offers only values the server accepts', () => {
    expect(REVEAL_SLOT_CHOICES.length).toBeGreaterThan(1);
    for (const s of REVEAL_SLOT_CHOICES) {
      expect(s).toBeGreaterThanOrEqual(REVEAL_SLOT_MIN_SECONDS);
      expect(s).toBeLessThanOrEqual(REVEAL_SLOT_MAX_SECONDS);
    }
    for (const s of VOTING_CHOICES) {
      expect(s).toBeGreaterThanOrEqual(VOTING_MIN_SECONDS);
      expect(s).toBeLessThanOrEqual(VOTING_MAX_SECONDS);
    }
    renderSettings({});
    const slot = screen.getByTestId<HTMLSelectElement>('setting-reveal-slot');
    expect([...slot.options].map((o) => o.value)).toEqual([
      'auto',
      ...REVEAL_SLOT_CHOICES.map(String),
    ]);
    expect(slot.value).toBe('auto');
    expect(screen.getByTestId<HTMLSelectElement>('setting-voting').value).toBe('60');
    expect(screen.getByTestId<HTMLInputElement>('setting-reveal-vote').checked).toBe(true);
  });

  it('sends a patch per change; Auto clears the fixed slot', () => {
    const onChange = renderSettings({ reveal_slot_s: 45, voting_s: 90 });
    expect(screen.getByTestId<HTMLSelectElement>('setting-reveal-slot').value).toBe('45');
    fireEvent.change(screen.getByTestId('setting-reveal-slot'), { target: { value: 'auto' } });
    expect(onChange).toHaveBeenLastCalledWith({ reveal_slot_s: null });
    fireEvent.change(screen.getByTestId('setting-reveal-slot'), { target: { value: '30' } });
    expect(onChange).toHaveBeenLastCalledWith({ reveal_slot_s: 30 });
    fireEvent.change(screen.getByTestId('setting-voting'), { target: { value: '120' } });
    expect(onChange).toHaveBeenLastCalledWith({ voting_s: 120 });
    fireEvent.click(screen.getByTestId('setting-reveal-vote'));
    expect(onChange).toHaveBeenLastCalledWith({ reveal_vote: false });
  });

  it('with reveal and vote off, the timings are disabled', () => {
    renderSettings({ reveal_vote: false });
    expect(screen.getByTestId<HTMLInputElement>('setting-reveal-vote').checked).toBe(false);
    expect(screen.getByTestId<HTMLSelectElement>('setting-reveal-slot').disabled).toBe(true);
    expect(screen.getByTestId<HTMLSelectElement>('setting-voting').disabled).toBe(true);
  });

  it('the summary the other members see', () => {
    expect(settingsSummary({})).toBe(
      'Reveal and vote on · 30–60 s per build (by the number of builds) · 60 s to vote.',
    );
    expect(settingsSummary({ reveal_slot_s: 45, voting_s: 90 })).toBe(
      'Reveal and vote on · 45 s per build · 90 s to vote.',
    );
    expect(settingsSummary({ reveal_vote: false, voting_s: 90 })).toContain('off');
  });
});

function renderCards(settings: RoomSettings) {
  const onChange = vi.fn();
  const view = render(createElement(CustomCardSettings, { settings, disabled: false, onChange }));
  const rerender = (next: RoomSettings) => {
    view.rerender(createElement(CustomCardSettings, { settings: next, disabled: false, onChange }));
  };
  return { onChange, rerender };
}

const card = (kind: 'build' | 'rule' | 'style') =>
  screen.getByTestId<HTMLInputElement>(`setting-card-${kind}`);

describe('custom cards (host, T-053)', () => {
  it('three empty cards (drawn from the deck) and a random time limit by default', () => {
    renderCards({});
    for (const kind of ['build', 'rule', 'style'] as const) {
      expect(card(kind).value).toBe('');
      expect(card(kind).placeholder).toBe('Random from the deck');
      expect(card(kind).maxLength).toBe(80);
    }
    const time = screen.getByTestId<HTMLSelectElement>('setting-time-limit');
    expect(time.value).toBe('random');
    expect([...time.options].map((o) => o.value)).toEqual([
      'random',
      ...BUILD_TIME_LIMITS_MINUTES.map((m) => String(m * 60)),
    ]);
    expect(time.options[0]?.textContent).toBe('Random (10, 15 or 20 min)');
  });

  it('saves a card on blur or Enter, cleaned like the server', () => {
    const { onChange } = renderCards({});
    fireEvent.change(card('build'), { target: { value: '  A pet rock   that judges you ' } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(card('build'));
    expect(onChange).toHaveBeenLastCalledWith({ custom_build: 'A pet rock that judges you' });
    fireEvent.change(card('rule'), { target: { value: 'No buttons' } });
    fireEvent.keyDown(card('rule'), { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith({ custom_rule: 'No buttons' });
  });

  it('an emptied card goes back to the deck; an unchanged one sends nothing', () => {
    const { onChange } = renderCards({ custom_style: 'Windows 95' });
    expect(card('style').value).toBe('Windows 95');
    fireEvent.blur(card('style'));
    fireEvent.change(card('style'), { target: { value: ' Windows   95 ' } });
    fireEvent.blur(card('style'));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(card('style'), { target: { value: '   ' } });
    fireEvent.blur(card('style'));
    expect(onChange).toHaveBeenLastCalledWith({ custom_style: null });
  });

  it('a card that is too short is not sent and says why', () => {
    const { onChange } = renderCards({});
    fireEvent.change(card('rule'), { target: { value: 'ab' } });
    fireEvent.blur(card('rule'));
    expect(onChange).not.toHaveBeenCalled();
    expect(card('rule').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByTestId('card-length-rule').textContent).toBe(
      'A card is 3 to 80 characters.',
    );
  });

  it('a new value from the server replaces the draft; a refused save keeps it', () => {
    const { rerender } = renderCards({});
    fireEvent.change(card('build'), { target: { value: 'A shady card' } });
    // Refused (card_not_allowed): the settings did not change.
    rerender({});
    expect(card('build').value).toBe('A shady card');
    rerender({ custom_build: 'A lava lamp' });
    expect(card('build').value).toBe('A lava lamp');
    rerender({});
    expect(card('build').value).toBe('');
  });

  it('the time limit: a fixed one, or back to random', () => {
    const { onChange } = renderCards({ time_limit_s: 1800 });
    const time = screen.getByTestId<HTMLSelectElement>('setting-time-limit');
    expect(time.value).toBe('1800');
    fireEvent.change(time, { target: { value: 'random' } });
    expect(onChange).toHaveBeenLastCalledWith({ time_limit_s: null });
    fireEvent.change(time, { target: { value: '2700' } });
    expect(onChange).toHaveBeenLastCalledWith({ time_limit_s: 2700 });
  });

  it('the summary the other members see names the cards, never their text', () => {
    expect(cardsSummary({})).toBeNull();
    expect(cardsSummary({ reveal_vote: false, max_players: 4 })).toBeNull();
    expect(cardsSummary({ custom_build: 'A secret' })).toBe(
      'The host wrote the BUILD card: you see it at the spin.',
    );
    const both = cardsSummary({
      custom_build: 'A secret',
      custom_rule: 'Another',
      time_limit_s: 1800,
    });
    expect(both).toBe(
      'The host wrote the BUILD and RULE cards: you see them at the spin. Build time: 30 min.',
    );
    expect(both).not.toContain('secret');
    expect(cardsSummary({ time_limit_s: 2700 })).toBe('Build time: 45 min.');
    expect(cardsSummary({ custom_build: 'x', custom_rule: 'y' }, tr)).toBe(
      'Oda sahibi PROJE ve KURAL kartlarını kendisi yazdı. Çarkta görürsün.',
    );
    expect(cardsSummary({ custom_style: 'x', time_limit_s: 600 }, tr)).toBe(
      'Oda sahibi STİL kartını kendisi yazdı. Çarkta görürsün. Süre: 10 dk.',
    );
  });
});
