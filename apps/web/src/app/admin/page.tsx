import { REPORT_REASON_LABELS, isReportReason } from '@br/game';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { adminRpc, parseLookup } from '../../lib/admin/session';
import type { AdminAction, BattleLog, LogEvent, QueueItem, RoomLog } from '../../lib/admin/types';
import { screenshotUrl } from '../../lib/supabase/config';
import { dismissReportsAction, signOutAction, takeDownAction } from './actions';
import { requireAdminPage } from './admin-session';

/**
 * /admin (T-024): the moderators' page, server-rendered. Everyone who is not a signed-in
 * admin gets the plain 404 (requireAdminPage). Three parts:
 *
 * - **Report queue:** open reports grouped by build, with the screenshot, the battle, the
 *   reason counts and the details. Dismiss, or take the build down (hidden at once; the
 *   capture worker deletes its screenshot).
 * - **Look up** a battle id or a room code: the battle_events / room_events timeline (the
 *   event-log page moved here from M3) and the builds with their status.
 * - **Admin actions:** the latest entries of the admin log.
 */

export const metadata: Metadata = {
  title: 'Moderation',
  robots: { index: false, follow: false },
};
export const dynamic = 'force-dynamic';

interface AdminPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const one = (v: string | string[] | undefined) => (typeof v === 'string' ? v : undefined);

function reasonLabel(reason: string): string {
  return isReportReason(reason) ? REPORT_REASON_LABELS[reason].label : reason;
}

const ERROR_TEXT: Record<string, string> = {
  already_taken_down: 'That build was already taken down.',
  build_not_found: 'That build no longer exists.',
  battle_not_found: 'No battle has this id.',
  room_not_found: 'No room has this code (closed rooms are purged after 7 days).',
  invalid_details: 'The note is too long (500 characters at most).',
};

const DONE_TEXT: Record<string, string> = {
  dismissed: 'Reports dismissed.',
  taken_down:
    'Build taken down: hidden everywhere now; its screenshot is deleted by the capture worker.',
  retried: 'The screenshot delete was queued again.',
};

function when(iso: string | null | undefined): string {
  if (!iso) return '–';
  return new Date(iso)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d+Z$/, ' UTC');
}

function timeOnly(iso: string): string {
  return new Date(iso).toISOString().slice(11, 23);
}

const card =
  'rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900';
const smallButton =
  'rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-semibold hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800';

export default async function AdminPage({ searchParams }: AdminPageProps) {
  const params = await searchParams;
  const q = one(params['q']);
  const view = one(params['view']) === 'resolved' ? 'resolved' : 'open';
  const path = `/admin${q ? `?q=${encodeURIComponent(q)}` : view === 'resolved' ? '?view=resolved' : ''}`;
  const token = await requireAdminPage(path);

  const done = one(params['done']);
  const error = one(params['error']);
  const lookup = parseLookup(q);

  return (
    <main className="mx-auto flex min-h-dvh max-w-6xl flex-col gap-6 px-4 py-8" data-testid="admin">
      <header className="flex flex-wrap items-center gap-3">
        <div className="mr-auto">
          <p className="text-sm font-semibold text-zinc-500">Build Roulette</p>
          <h1 className="text-3xl font-black tracking-tight">Moderation</h1>
        </div>
        <nav className="flex flex-wrap gap-2 text-sm font-semibold">
          <Link
            href="/admin"
            className={smallButton}
            aria-current={!q && view === 'open' ? 'page' : undefined}
          >
            Open reports
          </Link>
          <Link
            href="/admin?view=resolved"
            className={smallButton}
            aria-current={!q && view === 'resolved' ? 'page' : undefined}
          >
            Resolved
          </Link>
        </nav>
        <form action={signOutAction}>
          <button type="submit" className={smallButton} data-testid="admin-sign-out">
            Sign out
          </button>
        </form>
      </header>

      {(done ?? error) && (
        <p
          role="status"
          data-testid="admin-flash"
          data-done={done ?? ''}
          data-error={error ?? ''}
          className={`rounded-xl px-4 py-3 text-sm font-semibold ${
            error
              ? 'bg-red-50 text-red-800 dark:bg-red-950/60 dark:text-red-200'
              : 'bg-emerald-50 text-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-200'
          }`}
        >
          {error
            ? (ERROR_TEXT[error] ?? `Failed: ${error}`)
            : done === 'dismissed'
              ? `${DONE_TEXT['dismissed'] ?? ''} (${one(params['n']) ?? '0'})`
              : (DONE_TEXT[done ?? ''] ?? 'Done.')}
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

      {q ? (
        lookup.kind === 'battle' ? (
          <BattleLogView token={token} battleId={lookup.id} />
        ) : lookup.kind === 'room' ? (
          <RoomLogView token={token} code={lookup.code} />
        ) : (
          <p className="text-sm text-red-700 dark:text-red-300" data-testid="admin-lookup-invalid">
            Enter a battle id (a UUID) or a room code (5 letters and digits).
          </p>
        )
      ) : (
        <QueueView token={token} resolved={view === 'resolved'} />
      )}

      <ActionLog token={token} />
    </main>
  );
}

// ─── The report queue ─────────────────────────────────────────────────────────────────

async function QueueView({ token, resolved }: { token: string; resolved: boolean }) {
  const res = await adminRpc<{ builds: QueueItem[] }>(token, 'admin_report_queue', {
    p_resolved: resolved,
    p_limit: 100,
  });
  const items = res.data?.builds ?? [];
  return (
    <section className="flex flex-col gap-4" aria-label="Report queue" data-testid="admin-queue">
      <h2 className="text-xl font-black">
        {resolved ? 'Resolved reports' : 'Open reports'}{' '}
        <span className="text-zinc-500">({items.length})</span>
      </h2>
      {res.error && <p className="text-sm text-red-700">Could not load the queue: {res.error}</p>}
      {items.length === 0 && !res.error && (
        <p className="text-sm text-zinc-500" data-testid="admin-queue-empty">
          {resolved ? 'Nothing resolved yet.' : 'No open reports. 🎉'}
        </p>
      )}
      {items.map((item) => (
        <QueueCard key={item.build_id} item={item} resolved={resolved} />
      ))}
    </section>
  );
}

function QueueCard({ item, resolved }: { item: QueueItem; resolved: boolean }) {
  const publicPage = item.battle_phase === 'results' || item.battle_phase === 'destroyed';
  const view = resolved ? 'resolved' : 'open';
  return (
    <article
      className={`${card} grid grid-cols-1 gap-4 md:grid-cols-[16rem_minmax(0,1fr)]`}
      data-testid="report-item"
      data-build={item.build_id}
      data-taken-down={item.taken_down_at ? 'true' : 'false'}
    >
      <div className="relative aspect-[16/10] overflow-hidden rounded-lg bg-zinc-100 dark:bg-zinc-800">
        {item.screenshot_path ? (
          // eslint-disable-next-line @next/next/no-img-element -- a public Supabase Storage URL
          <img
            src={screenshotUrl(item.screenshot_path)}
            alt={`Screenshot of ${item.name ?? 'the build'}`}
            className="absolute inset-0 h-full w-full object-cover object-top"
            data-testid="report-item-screenshot"
          />
        ) : (
          <p className="absolute inset-0 grid place-items-center p-3 text-center text-xs text-zinc-500">
            {item.taken_down_at
              ? item.takedown?.storage_deleted_at
                ? 'Taken down · screenshot deleted'
                : `Taken down · screenshot delete ${item.takedown?.job_status ?? 'pending'}`
              : item.capture_status === 'pending'
                ? 'No screenshot yet'
                : 'No screenshot'}
          </p>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        <div>
          <h3 className="truncate text-lg font-black" data-testid="report-item-name">
            {item.name ?? 'Untitled build'}
            {item.taken_down_at && (
              <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 align-middle text-xs font-bold text-red-800 dark:bg-red-950 dark:text-red-200">
                Taken down
              </span>
            )}
          </h3>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            by <strong>{item.builder_name ?? 'unknown'}</strong> · {item.status}
            {item.final_rank !== null && ` · rank ${String(item.final_rank)}`} · {item.battle_mode}{' '}
            battle, {item.battle_phase}
          </p>
          <p className="mt-1 flex flex-wrap gap-3 text-sm font-semibold">
            {publicPage && (
              <Link href={`/battles/${item.battle_id}`} className="underline" target="_blank">
                Results page
              </Link>
            )}
            <Link
              href={`/admin?q=${item.battle_id}`}
              className="underline"
              data-testid="report-item-log"
            >
              Battle event log
            </Link>
          </p>
        </div>
        <p className="flex flex-wrap gap-2" data-testid="report-item-reasons">
          {Object.entries(item.reasons).map(([reason, n]) => (
            <span
              key={reason}
              data-reason={reason}
              className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-bold text-amber-900 dark:bg-amber-950 dark:text-amber-200"
            >
              {reasonLabel(reason)} × {String(n)}
            </span>
          ))}
          <span className="text-xs text-zinc-500">
            {item.report_count} report{item.report_count === 1 ? '' : 's'}, first{' '}
            {when(item.first_reported_at)}
          </span>
        </p>
        <ul className="flex flex-col gap-1 text-sm" data-testid="report-item-reports">
          {item.reports.map((r) => (
            <li key={r.id} className="rounded-lg bg-zinc-50 px-3 py-1.5 dark:bg-zinc-800/60">
              <span className="font-mono text-xs text-zinc-500">{when(r.created_at)}</span> ·{' '}
              <strong>{REPORT_REASON_LABELS[r.reason].label}</strong>
              {r.status !== 'open' && <span className="text-zinc-500"> ({r.status})</span>}
              {r.details && (
                <span className="block whitespace-pre-wrap break-words text-zinc-700 dark:text-zinc-300">
                  “{r.details}”
                </span>
              )}
            </li>
          ))}
        </ul>
        {item.takedown?.note && (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Takedown note: {item.takedown.note}
          </p>
        )}
        <div className="flex flex-wrap items-start gap-2">
          {!item.taken_down_at && item.open_count > 0 && (
            <form action={dismissReportsAction}>
              <input type="hidden" name="build_id" value={item.build_id} />
              <input type="hidden" name="view" value={view} />
              <button type="submit" className={smallButton} data-testid="admin-dismiss">
                Dismiss {item.open_count === 1 ? 'report' : `${String(item.open_count)} reports`}
              </button>
            </form>
          )}
          {!item.taken_down_at && (
            <details className="rounded-md border border-red-300 px-3 py-1.5 dark:border-red-900">
              <summary
                className="cursor-pointer text-sm font-bold text-red-700 dark:text-red-300"
                data-testid="admin-take-down"
              >
                Take down…
              </summary>
              <form action={takeDownAction} className="mt-2 flex flex-col gap-2">
                <input type="hidden" name="build_id" value={item.build_id} />
                <input type="hidden" name="view" value={view} />
                <textarea
                  name="note"
                  maxLength={500}
                  rows={2}
                  placeholder="Note for the log (optional)"
                  data-testid="admin-take-down-note"
                  className="w-72 max-w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-950"
                />
                <p className="max-w-72 text-xs text-zinc-500">
                  Hides its name and screenshot everywhere at once, deletes the screenshot, marks
                  the reports actioned. In a running battle the build is also disqualified.
                </p>
                <button
                  type="submit"
                  data-testid="admin-take-down-confirm"
                  className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-bold text-white hover:bg-red-700"
                >
                  Take it down
                </button>
              </form>
            </details>
          )}
          {item.takedown?.job_status === 'failed' && (
            <form action={takeDownAction}>
              <input type="hidden" name="build_id" value={item.build_id} />
              <input type="hidden" name="view" value={view} />
              <button type="submit" className={smallButton} data-testid="admin-retry-takedown">
                Retry the screenshot delete ({item.takedown.job_error ?? 'failed'})
              </button>
            </form>
          )}
        </div>
      </div>
    </article>
  );
}

// ─── Event logs ───────────────────────────────────────────────────────────────────────

function Timeline({ events, testId }: { events: LogEvent[]; testId: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs" data-testid={testId}>
        <thead className="text-zinc-500">
          <tr>
            <th className="py-1 pr-3 font-semibold">Time (UTC)</th>
            <th className="py-1 pr-3 font-semibold">v</th>
            <th className="py-1 pr-3 font-semibold">Event</th>
            <th className="py-1 pr-3 font-semibold">By</th>
            <th className="py-1 font-semibold">Payload</th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {events.map((e) => (
            <tr
              key={e.id}
              className="border-t border-zinc-100 align-top dark:border-zinc-800"
              data-testid="log-event"
              data-type={e.type}
            >
              <td className="py-1 pr-3 whitespace-nowrap">{timeOnly(e.created_at)}</td>
              <td className="py-1 pr-3">{e.version}</td>
              <td className="py-1 pr-3 font-bold">{e.type}</td>
              <td className="py-1 pr-3 whitespace-nowrap">
                {e.actor_name ?? (e.actor_id ? e.actor_id.slice(0, 8) : 'system')}
              </td>
              <td className="py-1 break-all text-zinc-600 dark:text-zinc-400">
                {JSON.stringify(e.payload).slice(0, 400)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {events.length === 0 && <p className="text-sm text-zinc-500">No events.</p>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={`${card} flex flex-col gap-3`}>
      <h3 className="text-sm font-black tracking-widest text-zinc-500 uppercase">{title}</h3>
      {children}
    </section>
  );
}

async function BattleLogView({ token, battleId }: { token: string; battleId: string }) {
  const res = await adminRpc<BattleLog>(token, 'admin_battle_log', { p_battle_id: battleId });
  if (!res.data) {
    return (
      <p className="text-sm text-red-700 dark:text-red-300" data-testid="admin-lookup-error">
        {ERROR_TEXT[res.error ?? ''] ?? `Could not load the battle: ${res.error ?? 'unknown'}`}
      </p>
    );
  }
  const { battle, challenge, room, players, builds, events, jobs } = res.data;
  return (
    <div className="flex flex-col gap-4" data-testid="admin-battle-log" data-battle={battle.id}>
      <h2 className="text-xl font-black">
        Battle <span className="font-mono text-base">{battle.id}</span>
      </h2>
      <Section title="Battle">
        <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
          <dt className="text-zinc-500">Phase</dt>
          <dd className="font-bold" data-testid="admin-battle-phase">
            {battle.phase} (v{battle.version})
          </dd>
          <dt className="text-zinc-500">Mode</dt>
          <dd>
            {typeof battle.settings['mode'] === 'string' ? battle.settings['mode'] : 'multiplayer'}
          </dd>
          <dt className="text-zinc-500">Room</dt>
          <dd>
            {room ? (
              <Link href={`/admin?q=${room.code}`} className="font-mono underline">
                {room.code}
              </Link>
            ) : (
              '–'
            )}
            {room && ` (${room.status})`}
          </dd>
          <dt className="text-zinc-500">Challenge</dt>
          <dd>{challenge ? `${challenge.build} · ${challenge.rule} · ${challenge.style}` : '–'}</dd>
          <dt className="text-zinc-500">Created</dt>
          <dd>{when(battle.created_at)}</dd>
          <dt className="text-zinc-500">Finished</dt>
          <dd>{when(battle.finished_at)}</dd>
          <dt className="text-zinc-500">Destroyed</dt>
          <dd>{when(battle.destroyed_at)}</dd>
        </dl>
        {(battle.phase === 'results' || battle.phase === 'destroyed') && (
          <Link
            href={`/battles/${battle.id}`}
            className="text-sm font-semibold underline"
            target="_blank"
          >
            Public results page
          </Link>
        )}
      </Section>
      <Section title={`Players (${String(players.length)})`}>
        <ul className="flex flex-wrap gap-2 text-sm">
          {players.map((p) => (
            <li key={p.user_id} className="rounded-full bg-zinc-100 px-3 py-1 dark:bg-zinc-800">
              {p.display_name}
              {p.state && p.state !== 'active' && (
                <span className="text-zinc-500"> · {p.state}</span>
              )}
              <span className="ml-1 font-mono text-[10px] text-zinc-500">
                {p.user_id.slice(0, 8)}
              </span>
            </li>
          ))}
        </ul>
      </Section>
      <Section title={`Builds (${String(builds.length)})`}>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm" data-testid="admin-builds">
            <thead className="text-xs text-zinc-500">
              <tr>
                <th className="py-1 pr-3">Rank</th>
                <th className="py-1 pr-3">Build</th>
                <th className="py-1 pr-3">By</th>
                <th className="py-1 pr-3">Status</th>
                <th className="py-1 pr-3">Capture</th>
                <th className="py-1 pr-3">Reports</th>
              </tr>
            </thead>
            <tbody>
              {builds.map((b) => (
                <tr
                  key={b.id}
                  className="border-t border-zinc-100 dark:border-zinc-800"
                  data-testid="admin-build"
                  data-build={b.id}
                  data-taken-down={b.taken_down_at ? 'true' : 'false'}
                >
                  <td className="py-1 pr-3">{b.final_rank ?? '–'}</td>
                  <td className="py-1 pr-3 font-semibold">
                    {b.name ?? '–'}
                    {b.taken_down_at && (
                      <span className="ml-1 text-xs text-red-700 dark:text-red-300">
                        (taken down)
                      </span>
                    )}
                  </td>
                  <td className="py-1 pr-3">{b.builder_name ?? '–'}</td>
                  <td className="py-1 pr-3">{b.status}</td>
                  <td className="py-1 pr-3">{b.capture_status}</td>
                  <td className="py-1 pr-3">
                    {b.reports > 0 ? `${String(b.open_reports)} open / ${String(b.reports)}` : '–'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
      <Section title={`battle_events (${String(events.length)})`}>
        <Timeline events={events} testId="admin-battle-events" />
      </Section>
      <Section title={`Jobs (${String(jobs.length)})`}>
        <ul className="flex flex-col gap-1 font-mono text-xs">
          {jobs.map((j) => (
            <li key={j.id}>
              #{j.id} {j.kind} {j.ref_id.slice(0, 8)} · {j.status} · {j.attempts} attempt
              {j.attempts === 1 ? '' : 's'}
              {j.last_error ? ` · ${j.last_error}` : ''}
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

async function RoomLogView({ token, code }: { token: string; code: string }) {
  const res = await adminRpc<RoomLog>(token, 'admin_room_log', { p_code: code });
  if (!res.data) {
    return (
      <p className="text-sm text-red-700 dark:text-red-300" data-testid="admin-lookup-error">
        {ERROR_TEXT[res.error ?? ''] ?? `Could not load the room: ${res.error ?? 'unknown'}`}
      </p>
    );
  }
  const { room, members, battles, events } = res.data;
  return (
    <div className="flex flex-col gap-4" data-testid="admin-room-log" data-room={room.code}>
      <h2 className="text-xl font-black">
        Room <span className="font-mono">{room.code}</span>{' '}
        <span className="text-base font-semibold text-zinc-500">({room.status})</span>
      </h2>
      <Section title={`Members (${String(members.length)})`}>
        <ul className="flex flex-wrap gap-2 text-sm">
          {members.map((m) => (
            <li key={m.user_id} className="rounded-full bg-zinc-100 px-3 py-1 dark:bg-zinc-800">
              {m.display_name ?? m.user_id.slice(0, 8)} · {m.role}
              {m.user_id === room.host_id && ' 👑'}
              {m.kicked_at ? ' · kicked' : m.left_at ? ' · left' : ''}
            </li>
          ))}
        </ul>
      </Section>
      <Section title={`Battles (${String(battles.length)})`}>
        <ul className="flex flex-col gap-1 text-sm">
          {battles.map((b) => (
            <li key={b.id}>
              <Link href={`/admin?q=${b.id}`} className="font-mono underline">
                {b.id}
              </Link>{' '}
              · {b.phase} · {when(b.created_at)}
            </li>
          ))}
        </ul>
      </Section>
      <Section title={`room_events (${String(events.length)})`}>
        <Timeline events={events} testId="admin-room-events" />
      </Section>
    </div>
  );
}

// ─── The admin log ────────────────────────────────────────────────────────────────────

async function ActionLog({ token }: { token: string }) {
  const res = await adminRpc<AdminAction[]>(token, 'admin_action_log', { p_limit: 20 });
  const actions = res.data ?? [];
  return (
    <section className={`${card} flex flex-col gap-2`} data-testid="admin-actions">
      <h2 className="text-sm font-black tracking-widest text-zinc-500 uppercase">
        Latest admin actions
      </h2>
      {actions.length === 0 ? (
        <p className="text-sm text-zinc-500">None yet.</p>
      ) : (
        <ul className="flex flex-col gap-1 text-xs">
          {actions.map((a) => (
            <li key={a.id} data-testid="admin-action" data-action={a.action}>
              <span className="font-mono text-zinc-500">{when(a.created_at)}</span> ·{' '}
              <strong>{a.action}</strong> by {a.admin_email ?? 'a removed admin'}
              {a.build_id && <span className="font-mono"> · build {a.build_id.slice(0, 8)}</span>}
              {a.battle_id && (
                <>
                  {' · '}
                  <Link href={`/admin?q=${a.battle_id}`} className="font-mono underline">
                    battle {a.battle_id.slice(0, 8)}
                  </Link>
                </>
              )}
              {a.note && <span className="text-zinc-500"> · “{a.note}”</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
