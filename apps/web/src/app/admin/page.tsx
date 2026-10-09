import type { Metadata } from 'next';
import { AdminApp } from '../../components/admin/AdminApp';

/**
 * /admin: moderation (T-024), a static page since T-037. Everything runs in the browser with
 * the moderator's own Supabase session (components/admin/AdminApp.tsx, lib/admin/client.ts);
 * Postgres's `is_admin()` is the only authority. Without an admin session the page is the
 * plain "not found" screen. Not indexed, and the tab title names nothing until the session is
 * checked.
 */
export const metadata: Metadata = {
  title: { absolute: 'Build Roulette' },
  robots: { index: false, follow: false },
};

export default function AdminPage() {
  return <AdminApp />;
}
