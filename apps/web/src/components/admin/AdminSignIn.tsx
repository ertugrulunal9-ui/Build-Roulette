'use client';

/**
 * The moderators' sign-in form (T-024, in the browser since T-037). Email + password through
 * the moderator client (lib/admin/client.ts: its own session in this tab's sessionStorage,
 * never the player's anonymous one); only an account `is_admin()` accepts keeps the session.
 * A wrong password and a real account without the role get the same answer. A tab that is
 * already signed in as an admin goes straight to /admin.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { checkAdmin, getAdminClient, signInAdmin } from '../../lib/admin/client';

export function AdminSignIn() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  // The button stays disabled until the page runs: a form submitted natively before that
  // would put the password in the URL (a GET to this page).
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setReady(true);
    let live = true;
    void checkAdmin(getAdminClient()).then((gate) => {
      if (live && gate === 'admin') window.location.replace('/admin');
    });
    return () => {
      live = false;
    };
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(false);
    const result = await signInAdmin(getAdminClient(), email.trim(), password).catch(
      () => 'denied' as const,
    );
    if (result === 'ok') {
      window.location.assign('/admin');
      return;
    }
    setError(true);
    setBusy(false);
  };

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 px-4 py-10">
      <header className="flex flex-col gap-1">
        <p className="text-sm font-semibold text-zinc-500">Build Roulette</p>
        <h1 className="text-3xl font-black tracking-tight">Moderator sign-in</h1>
      </header>
      <form
        onSubmit={(e) => {
          void submit(e);
        }}
        className="flex flex-col gap-3"
        data-testid="admin-sign-in"
      >
        <label className="flex flex-col gap-1 text-sm font-semibold">
          Email
          <input
            name="email"
            type="email"
            required
            autoComplete="username"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
            }}
            data-testid="admin-email"
            className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-base font-normal dark:border-zinc-700 dark:bg-zinc-900"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-semibold">
          Password
          <input
            name="password"
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
            }}
            data-testid="admin-password"
            className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-base font-normal dark:border-zinc-700 dark:bg-zinc-900"
          />
        </label>
        <button
          type="submit"
          disabled={busy || !ready}
          data-testid="admin-sign-in-submit"
          className="rounded-lg bg-zinc-900 px-4 py-3 font-bold text-white disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        {error && (
          <p
            role="alert"
            className="text-sm text-red-700 dark:text-red-300"
            data-testid="admin-sign-in-error"
          >
            These details cannot sign in here.
          </p>
        )}
      </form>
    </main>
  );
}
