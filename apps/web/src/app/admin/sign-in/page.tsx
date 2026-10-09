import type { Metadata } from 'next';
import { AdminSignIn } from '../../../components/admin/AdminSignIn';

/**
 * The moderators' email/password sign-in (T-024; in the browser since T-037,
 * components/admin/AdminSignIn.tsx). Only an account listed in private.admins keeps a
 * session; anything else reads "These details cannot sign in here". Not linked from anywhere
 * and not indexed. Accounts are created by SQL (supabase/README.md "Abuse controls"; locally
 * supabase/scripts/seed-admin.mjs).
 */
export const metadata: Metadata = {
  title: 'Sign in',
  robots: { index: false, follow: false },
};

export default function AdminSignInPage() {
  return <AdminSignIn />;
}
