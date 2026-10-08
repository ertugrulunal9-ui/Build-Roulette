'use client';

/**
 * The landing page's three ways in: Play solo, Create room (a name → `create_room` →
 * /r/{code}) and Join with code (any case, trimmed, or a pasted invite link → /r/{code}).
 * Supabase loads only when a room is created, so the landing page stays light.
 */
import { normalizeRoomCode } from '@br/game';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { describeError, toGameError, type GameError } from '../../lib/solo/errors';
import { randomDisplayName } from '../../lib/solo/names';

const NAME_KEY = 'br:display-name';

const buttonClass =
  'rounded-lg px-5 py-3 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50';
const inputClass =
  'min-w-0 flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-base dark:border-zinc-700 dark:bg-zinc-900';

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
  const router = useRouter();
  const [panel, setPanel] = useState<Panel>('none');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<GameError | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);

  const open = (p: Panel) => {
    setPanel(p);
    setError(null);
    setCodeError(null);
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
      router.push(`/r/${room.code}`);
    } catch (e) {
      setError(toGameError(e));
      setBusy(false);
    }
  };

  const joinRoom = () => {
    const normalized = normalizeRoomCode(code);
    if (!normalized) {
      setCodeError('A room code has 5 letters and digits, like K7QXM.');
      return;
    }
    router.push(`/r/${normalized}`);
  };

  return (
    <div className="flex w-full max-w-md flex-col items-center gap-4">
      <div className="flex flex-col gap-3 sm:flex-row">
        <Link
          href="/play"
          data-testid="play-solo"
          className={`${buttonClass} bg-emerald-600 text-white hover:bg-emerald-700`}
        >
          Play solo
        </Link>
        <button
          type="button"
          data-testid="create-room"
          aria-expanded={panel === 'create'}
          onClick={() => {
            open(panel === 'create' ? 'none' : 'create');
          }}
          className={`${buttonClass} bg-zinc-900 text-zinc-50 dark:bg-zinc-100 dark:text-zinc-900`}
        >
          Create room
        </button>
        <button
          type="button"
          data-testid="join-with-code"
          aria-expanded={panel === 'join'}
          onClick={() => {
            open(panel === 'join' ? 'none' : 'join');
          }}
          className={`${buttonClass} border border-zinc-300 dark:border-zinc-700`}
        >
          Join with code
        </button>
      </div>

      {panel === 'create' && (
        <form
          className="flex w-full flex-col gap-2 text-left"
          data-testid="create-room-form"
          onSubmit={(e) => {
            e.preventDefault();
            void createRoom();
          }}
        >
          <label htmlFor="host-name" className="text-sm font-semibold">
            Your name
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
              {busy ? 'Creating…' : 'Create'}
            </button>
          </div>
          {error && (
            <p role="alert" className="text-sm text-red-700 dark:text-red-300">
              {describeError(error)}
            </p>
          )}
        </form>
      )}

      {panel === 'join' && (
        <form
          className="flex w-full flex-col gap-2 text-left"
          data-testid="join-room-form"
          onSubmit={(e) => {
            e.preventDefault();
            joinRoom();
          }}
        >
          <label htmlFor="room-code" className="text-sm font-semibold">
            Room code
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
                setCodeError(null);
              }}
              className={`${inputClass} font-mono tracking-widest uppercase`}
            />
            <button
              type="submit"
              data-testid="join-room-submit"
              disabled={code.trim().length === 0}
              className={`${buttonClass} bg-zinc-900 text-zinc-50 dark:bg-zinc-100 dark:text-zinc-900`}
            >
              Join
            </button>
          </div>
          {codeError && (
            <p
              role="alert"
              data-testid="code-error"
              className="text-sm text-red-700 dark:text-red-300"
            >
              {codeError}
            </p>
          )}
        </form>
      )}
    </div>
  );
}
