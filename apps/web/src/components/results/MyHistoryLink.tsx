'use client';

/**
 * "Your battle history" on the results page, for a viewer whose browser has a (possibly
 * anonymous) session. The results come from `get_public_battle` with the anon key, which
 * names players without ids, so this only ever links the viewer to their own history. The
 * Supabase client loads lazily, after the page. A plain link: `/u/{id}` is a static shell
 * behind a host rewrite (T-037).
 */
import { useEffect, useState } from 'react';

export function MyHistoryLink({ className }: { className?: string }) {
  const [userId, setUserId] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void import('../../lib/supabase/browser')
      .then(async ({ getSupabase }) => {
        const { data } = await getSupabase().auth.getSession();
        if (live && data.session) setUserId(data.session.user.id);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  if (!userId) return null;
  return (
    <a href={`/u/${userId}`} className={className} data-testid="my-history-link">
      Your battle history
    </a>
  );
}
