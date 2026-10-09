import type { ReactNode } from 'react';
import type { RpcResult } from '../../lib/admin/client';
import { assessHealth, formatAge } from '../../lib/admin/health';
import type { OpsHealth } from '../../lib/admin/types';

/**
 * /admin "Health" (T-030): `admin_ops_health`, called in the browser with the moderator's
 * own session (AdminConsole loads it on every page load and after every action; the RPC is
 * cheap and bounded). The findings at the top name the runbook to open (docs/runbooks/); the
 * tables below are the raw signals the runbooks refer to.
 *
 * "Send a test error to Sentry" (T-037: the browser's reporting, there is no server) calls
 * `onTestError`.
 */

const card =
  'rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900';
const th = 'py-1 pr-3 font-semibold';
const td = 'py-1 pr-3';

function Panel({
  title,
  children,
  testId,
}: {
  title: string;
  children: ReactNode;
  testId: string;
}) {
  return (
    <section className={`${card} flex min-w-0 flex-col gap-2`} data-testid={testId}>
      <h3 className="text-sm font-black tracking-widest text-zinc-500 uppercase">{title}</h3>
      {children}
    </section>
  );
}

function since(iso: string | null | undefined, now: number): string {
  if (!iso) return '–';
  return `${formatAge(Math.max(0, Math.round((now - Date.parse(iso)) / 1000)))} ago`;
}

export function HealthView({
  res,
  onTestError,
}: {
  res: RpcResult<OpsHealth>;
  onTestError: () => void;
}) {
  if (!res.data) {
    return (
      <section className={card} data-testid="admin-health" data-status="error">
        <h2 className="text-xl font-black">Health</h2>
        <p className="text-sm text-red-700 dark:text-red-300">
          Could not load the health signals: {res.error ?? 'unknown'}. Runbook: supabase-outage.
        </p>
      </section>
    );
  }
  const h = res.data;
  const now = Date.parse(h.generated_at);
  const findings = assessHealth(h, now);
  const { battles, jobs, cron, ttl } = h;
  const caps = h.captures_last_day;
  const capTotal = caps.captured + caps.fallback + caps.failed;

  return (
    <section
      className="flex flex-col gap-3"
      aria-label="Health"
      data-testid="admin-health"
      data-status={findings.length === 0 ? 'ok' : 'attention'}
    >
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="mr-auto text-xl font-black">
          Health{' '}
          <span
            className={`ml-1 rounded-full px-2.5 py-0.5 align-middle text-xs font-bold ${
              findings.length === 0
                ? 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200'
                : 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200'
            }`}
          >
            {findings.length === 0 ? 'All clear' : `${String(findings.length)} to check`}
          </span>
        </h2>
        <span className="text-xs text-zinc-500">as of {h.generated_at.slice(11, 19)} UTC</span>
        <button
          type="button"
          onClick={onTestError}
          data-testid="admin-test-error"
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-semibold hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          Send a test error to Sentry
        </button>
      </div>

      {findings.length > 0 && (
        <ul className={`${card} flex flex-col gap-1 text-sm`} data-testid="admin-health-findings">
          {findings.map((f) => (
            <li key={`${f.area}:${f.text}`} data-testid="health-finding" data-area={f.area}>
              ⚠️ {f.text} · <span className="font-mono text-xs">docs/runbooks/{f.runbook}.md</span>
            </li>
          ))}
        </ul>
      )}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Panel title="Battles" testId="health-battles">
          <p className="text-sm">
            Running:{' '}
            {Object.entries(battles.running).length === 0
              ? 'none'
              : Object.entries(battles.running)
                  .map(([phase, n]) => `${phase} ${String(n)}`)
                  .join(' · ')}
          </p>
          <p className="text-sm" data-testid="health-stuck" data-count={battles.stuck_total}>
            Past the deadline (+{battles.grace_s} s): {battles.overdue_total}, of which stuck:{' '}
            <strong>{battles.stuck_total}</strong>
          </p>
          {battles.overdue.length > 0 && (
            <table className="w-full text-left text-xs">
              <thead className="text-zinc-500">
                <tr>
                  <th className={th}>Phase</th>
                  <th className={th}>Overdue</th>
                  <th className={th}>Stuck</th>
                  <th className={th}>Waiting for screenshots</th>
                  <th className={th}>Oldest</th>
                </tr>
              </thead>
              <tbody>
                {battles.overdue.map((o) => (
                  <tr
                    key={o.phase}
                    data-testid="health-overdue"
                    data-phase={o.phase}
                    data-count={o.count}
                    data-stuck={o.stuck}
                    data-waiting={o.waiting_for_captures}
                    className="border-t border-zinc-100 dark:border-zinc-800"
                  >
                    <td className={td}>{o.phase}</td>
                    <td className={td}>{o.count}</td>
                    <td className={td}>{o.stuck}</td>
                    <td className={td}>{o.waiting_for_captures}</td>
                    <td className={td}>
                      <a href={`/admin?q=${o.oldest_battle_id}`} className="font-mono underline">
                        {o.oldest_battle_id.slice(0, 8)}
                      </a>{' '}
                      ({formatAge(o.oldest_overdue_s)})
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="text-sm">
            Destroyed, files not deleted yet: {battles.destroy_pending.count}
            {battles.destroy_pending.oldest_battle_id && (
              <>
                {' '}
                (oldest{' '}
                <a
                  href={`/admin?q=${battles.destroy_pending.oldest_battle_id}`}
                  className="font-mono underline"
                >
                  {battles.destroy_pending.oldest_battle_id.slice(0, 8)}
                </a>
                , {formatAge(battles.destroy_pending.oldest_s)})
              </>
            )}
          </p>
        </Panel>

        <Panel title="Jobs" testId="health-jobs">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-zinc-500">
                <tr>
                  <th className={th}>Kind</th>
                  <th className={th}>Queued</th>
                  <th className={th}>Running</th>
                  <th className={th}>Ready</th>
                  <th className={th}>Oldest pending</th>
                  <th className={th}>Done 1 h</th>
                  <th className={th}>Failed 1 h / 24 h</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr
                    key={j.kind}
                    data-testid="health-job"
                    data-kind={j.kind}
                    data-queued={j.queued}
                    data-done-hour={j.done_last_hour}
                    data-failed-hour={j.failed_last_hour}
                    className="border-t border-zinc-100 align-top dark:border-zinc-800"
                  >
                    <td className={`${td} font-bold`}>{j.kind}</td>
                    <td className={td}>{j.queued}</td>
                    <td className={td}>
                      {j.running}
                      {j.lease_expired > 0 && ` (${String(j.lease_expired)} lease expired)`}
                    </td>
                    <td className={td}>{j.ready}</td>
                    <td className={td}>{formatAge(j.oldest_pending_s)}</td>
                    <td className={td}>{j.done_last_hour}</td>
                    <td className={td}>
                      {j.failed_last_hour} / {j.failed_last_day}
                      {j.last_failure && (
                        <span className="block text-zinc-500">
                          last {since(j.last_failure.at, now)}: {j.last_failure.error ?? '–'}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-sm" data-testid="health-captures">
            Screenshots, last 24 h:{' '}
            {capTotal === 0
              ? 'none'
              : `${String(caps.captured)} rendered, ${String(caps.fallback)} client thumbnail, ${String(caps.failed)} failed (${String(Math.round((caps.captured / capTotal) * 100))} % rendered)`}
          </p>
        </Panel>

        <Panel title="Sweeps (pg_cron)" testId="health-cron">
          {!cron.available ? (
            <p className="text-sm text-red-700 dark:text-red-300">
              Not readable{cron.error ? `: ${cron.error}` : ''}.
            </p>
          ) : (
            <table className="w-full text-left text-xs">
              <thead className="text-zinc-500">
                <tr>
                  <th className={th}>Job</th>
                  <th className={th}>Schedule</th>
                  <th className={th}>Last run</th>
                  <th className={th}>Runs / failed 1 h</th>
                </tr>
              </thead>
              <tbody>
                {cron.jobs.map((c) => (
                  <tr
                    key={c.name}
                    data-testid="health-cron-job"
                    data-name={c.name}
                    data-last-status={c.last_run?.status ?? ''}
                    data-failed-hour={c.failed_last_hour}
                    className="border-t border-zinc-100 align-top dark:border-zinc-800"
                  >
                    <td className={`${td} font-mono`}>
                      {c.name}
                      {!c.active && ' (inactive)'}
                    </td>
                    <td className={`${td} font-mono`}>{c.schedule}</td>
                    <td className={td}>
                      {c.last_run
                        ? `${c.last_run.status}, ${since(c.last_run.start, now)}`
                        : 'never'}
                    </td>
                    <td className={td}>
                      {c.runs_last_hour} / {c.failed_last_hour}
                      {c.last_failure && (
                        <span className="block text-zinc-500">
                          last failure {since(c.last_failure.at, now)}:{' '}
                          {c.last_failure.message ?? '–'}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title="24 h TTL" testId="health-ttl">
          <ul className="text-sm">
            <li>
              Battles older than 24 h, files not deleted: {ttl.battles_past_ttl}
              {ttl.oldest_battle_past_ttl_id && (
                <>
                  {' '}
                  (
                  <a
                    href={`/admin?q=${ttl.oldest_battle_past_ttl_id}`}
                    className="font-mono underline"
                  >
                    {ttl.oldest_battle_past_ttl_id.slice(0, 8)}
                  </a>
                  )
                </>
              )}
            </li>
            <li>
              Build files in storage: {ttl.ephemeral_objects} (oldest{' '}
              {formatAge(ttl.oldest_ephemeral_object_s)}); older than 24 h:{' '}
              {ttl.ephemeral_objects_past_ttl}; of destroyed battles:{' '}
              {ttl.ephemeral_objects_of_destroyed}
            </li>
          </ul>
        </Panel>
      </div>
    </section>
  );
}
