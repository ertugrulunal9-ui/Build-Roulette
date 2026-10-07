import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { ACCESS_COOKIE, isAdminToken, jwtSecondsLeft } from '../../../lib/admin/session';
import { signInAction } from '../actions';

/**
 * The moderators' email/password sign-in (T-024). Only an account listed in
 * private.admins gets a session; anything else reads "These details cannot sign in here".
 * Not linked from anywhere and not indexed. Accounts are created by SQL (supabase/README.md
 * "Abuse controls"; locally supabase/scripts/seed-admin.mjs).
 */

export const metadata: Metadata = {
  title: 'Sign in',
  robots: { index: false, follow: false },
};

interface SignInProps {
  searchParams: Promise<{ error?: string | string[] }>;
}

export default async function AdminSignIn({ searchParams }: SignInProps) {
  const access = (await cookies()).get(ACCESS_COOKIE)?.value;
  if (access && (jwtSecondsLeft(access) ?? -1) > 30 && (await isAdminToken(access))) {
    redirect('/admin');
  }
  const { error } = await searchParams;
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 px-4 py-10">
      <header className="flex flex-col gap-1">
        <p className="text-sm font-semibold text-zinc-500">Build Roulette</p>
        <h1 className="text-3xl font-black tracking-tight">Moderator sign-in</h1>
      </header>
      <form action={signInAction} className="flex flex-col gap-3" data-testid="admin-sign-in">
        <label className="flex flex-col gap-1 text-sm font-semibold">
          Email
          <input
            name="email"
            type="email"
            required
            autoComplete="username"
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
            data-testid="admin-password"
            className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-base font-normal dark:border-zinc-700 dark:bg-zinc-900"
          />
        </label>
        <button
          type="submit"
          data-testid="admin-sign-in-submit"
          className="rounded-lg bg-zinc-900 px-4 py-3 font-bold text-white dark:bg-zinc-100 dark:text-zinc-900"
        >
          Sign in
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
