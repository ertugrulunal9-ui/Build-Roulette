'use client';

/**
 * The landing page's three ways in: Play solo, Create room (a name → `create_room` →
 * /r/{code}) and Join with code (any case, trimmed, or a pasted invite link → /r/{code}).
 * Supabase loads only when a room is created, so the landing page stays light.
 */
import { normalizeRoomCode } from '@br/game';
import { ArrowRightIcon as ArrowRight } from '@phosphor-icons/react/dist/csr/ArrowRight';
import Link from 'next/link';
import { useState } from 'react';
import { loadPage } from '../../lib/hosting/navigate';
import { useT } from '../../lib/i18n/context';
import { describeError, toGameError, type GameError } from '../../lib/solo/errors';
import { randomDisplayName } from '../../lib/solo/names';

const NAME_KEY = 'br:display-name';

const buttonClass = 'br-home__action-button';
const inputClass = 'br-home__input';

function rememberedName(): string {
  try {
    const saved = window.localStorage.getItem(NAME_KEY)?.trim();
    if (saved) return saved.slice(0, 24);
  } catch {
    // storage blocked
  }
  return randomDisplayName();
}

type Panel = 'none' | 'create' | 'join';

export function HomeActions() {
  const t = useT();
  const [panel, setPanel] = useState<Panel>('none');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<GameError | null>(null);
  const [codeError, setCodeError] = useState(false);

  const open = (p: Panel) => {
    setPanel(p);
    setError(null);
    setCodeError(false);
    if (p === 'create' && name === '') setName(rememberedName());
  };

  const createRoom = async () => {
    const trimmed = name.trim();
    if (trimmed.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const [{ getSupabase, ensureSignedIn }, { SupabaseRoomApi }, { track }] = await Promise.all([
        import('../../lib/supabase/browser'),
        import('../../lib/room/api'),
        import('../../lib/telemetry/analytics'),
      ]);
      const api = new SupabaseRoomApi(getSupabase(), ensureSignedIn);
      await api.ensureSession();
      const room = await api.createRoom(trimmed);
      track('room_created', { room_id: room.room_id });
      try {
        window.localStorage.setItem(NAME_KEY, trimmed);
      } catch {
        // storage blocked
      }
      // A room is a static shell behind a host rewrite (T-037): a page load, not a client
      // navigation. Queued analytics go out on `pagehide` (keepalive).
      loadPage(`/r/${room.code}`);
    } catch (e) {
      setError(toGameError(e));
      setBusy(false);
    }
  };

  const joinRoom = () => {
    const normalized = normalizeRoomCode(code);
    if (!normalized) {
      setCodeError(true);
      return;
    }
    loadPage(`/r/${normalized}`);
  };

  return (
    <div className="br-home__actions">
      <div className="br-home__action-row">
        <button
          type="button"
          data-testid="create-room"
          aria-expanded={panel === 'create'}
          onClick={() => {
            open(panel === 'create' ? 'none' : 'create');
          }}
          className={`${buttonClass} br-home__action-button--primary`}
        >
          {t.home.heroCreateRoom}
          <ArrowRight aria-hidden="true" />
        </button>
        <Link
          href="/play"
          data-testid="play-solo"
          className={`${buttonClass} br-home__action-button--secondary`}
        >
          {t.home.playSolo}
        </Link>
      </div>
      <p className="br-home__join-prompt">
        {t.home.haveCode}{' '}
        <button
          type="button"
          data-testid="join-with-code"
          aria-expanded={panel === 'join'}
          className="br-home__join-trigger br-home__join-inline"
          onClick={() => {
            open(panel === 'join' ? 'none' : 'join');
          }}
        >
          {t.home.heroJoinRoom} <ArrowRight aria-hidden="true" />
        </button>
      </p>

      {panel === 'create' && (
        <form
          className="br-home__form"
          data-testid="create-room-form"
          onSubmit={(e) => {
            e.preventDefault();
            void createRoom();
          }}
        >
          <label htmlFor="host-name" className="text-sm font-semibold">
            {t.common.yourName}
          </label>
          <div className="flex gap-2">
            <input
              id="host-name"
              data-testid="host-name"
              value={name}
              maxLength={24}
              autoComplete="nickname"
              spellCheck={false}
              autoFocus
              onChange={(e) => {
                setName(e.target.value);
              }}
              className={inputClass}
            />
            <button
              type="submit"
              data-testid="create-room-submit"
              disabled={busy || name.trim().length === 0}
              className={`${buttonClass} bg-zinc-900 text-zinc-50 dark:bg-zinc-100 dark:text-zinc-900`}
            >
              {busy ? t.home.creating : t.home.create}
            </button>
          </div>
          {error && (
            <p role="alert" className="text-sm text-red-700 dark:text-red-300">
              {describeError(error, t)}
            </p>
          )}
        </form>
      )}

      {panel === 'join' && (
        <form
          className="br-home__form"
          data-testid="join-room-form"
          onSubmit={(e) => {
            e.preventDefault();
            joinRoom();
          }}
        >
          <label htmlFor="room-code" className="text-sm font-semibold">
            {t.home.roomCode}
          </label>
          <div className="flex gap-2">
            <input
              id="room-code"
              data-testid="room-code-input"
              value={code}
              placeholder="K7QXM"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              autoFocus
              onChange={(e) => {
                setCode(e.target.value);
                setCodeError(false);
              }}
              className={`${inputClass} font-mono tracking-widest uppercase`}
            />
            <button
              type="submit"
              data-testid="join-room-submit"
              disabled={code.trim().length === 0}
              className={`${buttonClass} bg-zinc-900 text-zinc-50 dark:bg-zinc-100 dark:text-zinc-900`}
            >
              {t.home.join}
            </button>
          </div>
          {codeError && (
            <p
              role="alert"
              data-testid="code-error"
              className="text-sm text-red-700 dark:text-red-300"
            >
              {t.home.codeError}
            </p>
          )}
        </form>
      )}
    </div>
  );
}
