/**
 * `report_build` from the browser (T-024). Signs in anonymously first when the visitor has
 * no session yet (a public results page is readable without one), with Turnstile when it is
 * configured. Throws a `GameError` (`already_reported`, `own_build`, `build_not_found`,
 * `rate_limited`, …).
 */
import type { ReportReason } from '@br/game';
import { toGameError } from '../solo/errors';

export interface ReportInput {
  buildId: string;
  reason: ReportReason;
  /** Optional; at most 500 characters (REPORT_DETAILS_MAX). */
  details: string;
}

export type SubmitReport = (input: ReportInput) => Promise<void>;

export const submitReport: SubmitReport = async ({ buildId, reason, details }) => {
  try {
    const { getSupabase, ensureSignedIn } = await import('../supabase/browser');
    const supabase = getSupabase();
    await ensureSignedIn(supabase);
    const { error } = await supabase.rpc('report_build', {
      p_build_id: buildId,
      p_reason: reason,
      p_details: details.trim() === '' ? null : details.trim(),
    });
    if (error) throw error;
  } catch (e) {
    throw toGameError(e);
  }
};
