// @vitest-environment happy-dom
/**
 * The host's REVEAL / VOTE settings in the lobby: on/off, the time per build and the
 * voting time, only within the server's ranges (`update_room_settings`), and the summary
 * everyone else sees.
 */
import {
  REVEAL_SLOT_MAX_SECONDS,
  REVEAL_SLOT_MIN_SECONDS,
  VOTING_MAX_SECONDS,
  VOTING_MIN_SECONDS,
} from '@br/game';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RoomSettings } from '../../lib/room/types';
import { REVEAL_SLOT_CHOICES, RevealVoteSettings, VOTING_CHOICES, settingsSummary } from './Lobby';

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
