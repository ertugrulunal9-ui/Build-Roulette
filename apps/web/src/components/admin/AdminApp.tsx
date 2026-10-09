'use client';

/**
 * /admin (T-024; client-side since T-037): the moderators' page.
 *
 * The page is a static file like every other, so anyone can load its script; what it shows
 * comes only from the admin RPCs, called with the moderator's own session
 * (lib/admin/client.ts), and Postgres decides (`is_admin()` in every admin RPC). Without a
 * session in this tab, or with one that is not an admin's, the page is the plain "not
 * found" screen (no request is made without a session).
 *
 * - **Report queue:** open reports grouped by build, with the screenshot, the battle, the
 *   reason counts and the details. Dismiss, or take the build down (hidden at once in the
 *   database: the public pages read it on every load; the capture worker deletes its
 *   screenshot).
 * - **Look up** a battle id or a room code (`?q=`): the battle_events / room_events timeline
 *   and the builds with their status.
 * - **Admin actions:** the latest entries of the admin log.
 * - **Health** (T-030): `admin_ops_health`, the signals the runbooks in docs/runbooks/ start
 *   from, and "Send a test error to Sentry" (from this page: there is no server).
 */
import { useCallback, useEffect, useState } from 'react';
import {
  adminRpc,
  checkAdmin,
  getAdminClient,
  parseLookup,
  signOutAdmin,
  type AdminClient,
  type RpcResult,
} from '../../lib/admin/client';
import type { AdminAction, BattleLog, OpsHealth, QueueItem, RoomLog } from '../../lib/admin/types';
import { loadPage } from '../../lib/hosting/navigate';
import { useBrowserUrl } from '../../lib/hosting/use-browser-url';
import { TEST_ERROR_MESSAGE, errorReportingEnabled } from '../../lib/telemetry/config';
import { DocumentTitle } from '../DocumentTitle';
import { NotFoundView } from '../NotFoundView';
import {
  ActionLog,
  BattleLogView,
  ERROR_TEXT,
  QueueView,
  RoomLogView,
  smallButton,
} from './AdminViews';
import { HealthView } from './HealthView';

type Gate = 'checking' | 'admin' | 'none' | 'error';

export function AdminApp() {
  const [gate, setGate] = useState<Gate>('checking');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    checkAdmin(getAdminClient()).then(
      (g) => {
        if (live) setGate(g);
      },
      () => {
        if (live) setGate('error');
      },
    );
    return () => {
      live = false;
    };
  }, [attempt]);

  // Until the session is known to be an admin's, the tab names nothing.
  const neutral = <title>Build Roulette</title>;
  if (gate === 'checking') {
    return (
      <>
        {neutral}
        <main className="min-h-dvh" data-testid="admin-checking" aria-busy="true" />
      </>
    );
  }
  if (gate === 'none') {
    return (
      <>
        {neutral}
        <NotFoundView testId="admin-not-found" />
      </>
    );
  }
  if (gate === 'error') {
    return (
      <>
        {neutral}
        <main
          className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-6 text-center"
          data-testid="admin-check-error"
        >
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Could not reach the server to check this session.
          </p>
          <button
            type="button"
            className={smallButton}
            onClick={() => {
              setGate('checking');
              setAttempt((n) => n + 1);
            }}
          >
            Try again
          </button>
        </main>
      </>
    );
  }
  // The page's one moderator client (created in the browser only: the gate opens there).
  return <AdminConsole client={getAdminClient()} />;
}

interface Flash {
  done?: string;
  error?: string;
  n?: number;
}

const DONE_TEXT: Record<string, string> = {
  dismissed: 'Reports dismissed.',
  taken_down:
    'Build taken down: hidden everywhere now; its screenshot is deleted by the capture worker.',
  retried: 'The screenshot delete was queued again.',
  test_error_sent: `A test error was thrown in this page. Sentry shows “${TEST_ERROR_MESSAGE}” (runtime: browser, route: /admin) within a minute.`,
  test_error_off: 'Error reporting is off in this build (no NEXT_PUBLIC_SENTRY_DSN).',
};

interface ConsoleData {
  health: RpcResult<OpsHealth> | null;
  queue: RpcResult<{ builds: QueueItem[] }> | null;
  battle: RpcResult<BattleLog> | null;
  room: RpcResult<RoomLog> | null;
  actions: RpcResult<AdminAction[]>;
}

function AdminConsole({ client }: { client: AdminClient }) {
  const url = useBrowserUrl();
  const q = url?.searchParams.get('q') ?? null;
  const view = url?.searchParams.get('view') === 'resolved' ? 'resolved' : 'open';
  const lookup = parseLookup(q);
  const [data, setData] = useState<ConsoleData | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<Flash | null>(null);

  useEffect(() => {
    if (url === null) return;
    let live = true;
    const none = Promise.resolve(null);
    void Promise.all([
      q ? none : adminRpc<OpsHealth>(client, 'admin_ops_health'),
      q
        ? none
        : adminRpc<{ builds: QueueItem[] }>(client, 'admin_report_queue', {
            p_resolved: view === 'resolved',
            p_limit: 100,
          }),
      lookup.kind === 'battle'
        ? adminRpc<BattleLog>(client, 'admin_battle_log', { p_battle_id: lookup.id })
        : none,
      lookup.kind === 'room'
        ? adminRpc<RoomLog>(client, 'admin_room_log', { p_code: lookup.code })
        : none,
      adminRpc<AdminAction[]>(client, 'admin_action_log', { p_limit: 20 }),
    ]).then(([health, queue, battle, room, actions]) => {
      if (live) setData({ health, queue, battle, room, actions });
    });
    return () => {
      live = false;
    };
    // `lookup` and `url` are derived from `q` and `view`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, q, view, refresh, url === null]);

  /** Runs one admin RPC, then reloads every section and says how it went. */
  const act = useCallback(
    async (fn: string, args: Record<string, unknown>, done: (data: unknown) => Flash) => {
      setBusy(true);
      const res = await adminRpc<unknown>(client, fn, args);
      setFlash(res.error ? { error: res.error } : done(res.data));
      setRefresh((n) => n + 1);
      setBusy(false);
    },
    [client],
  );

  const actions = {
    busy,
    dismiss: (buildId: string) => {
      void act('admin_dismiss_reports', { p_build_id: buildId, p_note: null }, (d) => ({
        done: 'dismissed',
        n: (d as { dismissed?: number } | null)?.dismissed ?? 0,
      }));
    },
    takeDown: (buildId: string, note: string) => {
      void act('admin_take_down_build', { p_build_id: buildId, p_note: note || null }, (d) => ({
        done: (d as { retried?: boolean } | null)?.retried ? 'retried' : 'taken_down',
      }));
    },
  };

  const testError = () => {
    if (!errorReportingEnabled()) {
      setFlash({ done: 'test_error_off' });
      return;
    }
    setFlash({ done: 'test_error_sent' });
    // Uncaught, from this page's own code: the path any app error takes (the window's error
    // handler, then Sentry with the page's tags), not a direct capture call.
    window.setTimeout(() => {
      throw new Error(TEST_ERROR_MESSAGE);
    }, 0);
  };

  const signOut = async () => {
    setBusy(true);
    await signOutAdmin(client);
    loadPage('/');
  };

  return (
    <main className="mx-auto flex min-h-dvh max-w-6xl flex-col gap-6 px-4 py-8" data-testid="admin">
      <DocumentTitle title="Moderation" />
      <header className="flex flex-wrap items-center gap-3">
        <div className="mr-auto">
          <p className="text-sm font-semibold text-zinc-500">Build Roulette</p>
          <h1 className="text-3xl font-black tracking-tight">Moderation</h1>
        </div>
        <nav className="flex flex-wrap gap-2 text-sm font-semibold">
          <a
            href="/admin"
            className={smallButton}
            aria-current={!q && view === 'open' ? 'page' : undefined}
          >
            Open reports
          </a>
          <a
            href="/admin?view=resolved"
            className={smallButton}
            aria-current={!q && view === 'resolved' ? 'page' : undefined}
          >
            Resolved
          </a>
        </nav>
        <button
          type="button"
          className={smallButton}
          data-testid="admin-sign-out"
          disabled={busy}
          onClick={() => {
            void signOut();
          }}
        >
          Sign out
        </button>
      </header>

      {flash && (
        <p
          role="status"
          data-testid="admin-flash"
          data-done={flash.done ?? ''}
          data-error={flash.error ?? ''}
          className={`rounded-xl px-4 py-3 text-sm font-semibold ${
            flash.error
              ? 'bg-red-50 text-red-800 dark:bg-red-950/60 dark:text-red-200'
              : 'bg-emerald-50 text-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-200'
          }`}
        >
          {flash.error
            ? (ERROR_TEXT[flash.error] ?? `Failed: ${flash.error}`)
            : flash.done === 'dismissed'
              ? `${DONE_TEXT['dismissed'] ?? ''} (${String(flash.n ?? 0)})`
              : (DONE_TEXT[flash.done ?? ''] ?? 'Done.')}
        </p>
      )}

      <form method="get" action="/admin" className="flex flex-wrap gap-2" role="search">
        <label htmlFor="admin-q" className="sr-only">
          Battle id or room code
        </label>
        <input
          id="admin-q"
          name="q"
          defaultValue={q ?? ''}
          placeholder="Battle id or room code (event log)"
          data-testid="admin-lookup-input"
          className="min-w-0 flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-2 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        <button type="submit" className={smallButton} data-testid="admin-lookup-submit">
          Look up
        </button>
      </form>

      {!data ? (
        <p className="text-sm text-zinc-500" data-testid="admin-loading">
          Loading…
        </p>
      ) : q ? (
        lookup.kind === 'battle' && data.battle ? (
          <BattleLogView res={data.battle} />
        ) : lookup.kind === 'room' && data.room ? (
          <RoomLogView res={data.room} />
        ) : (
          <p className="text-sm text-red-700 dark:text-red-300" data-testid="admin-lookup-invalid">
            Enter a battle id (a UUID) or a room code (5 letters and digits).
          </p>
        )
      ) : (
        <>
          {data.health && <HealthView res={data.health} onTestError={testError} />}
          {data.queue && (
            <QueueView res={data.queue} resolved={view === 'resolved'} actions={actions} />
          )}
        </>
      )}

      {data && <ActionLog res={data.actions} />}
    </main>
  );
}
