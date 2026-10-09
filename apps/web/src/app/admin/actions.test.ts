/**
 * The admin actions' cache revalidation (T-026): a takedown expires the cached copies of the
 * battle's public pages (tag from the RPC's answer, not from the form), at once and once
 * more a little later; nothing else does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SessionModule from '../../lib/admin/session';
import { TAKEDOWN_REEXPIRE_MS } from '../../lib/cache/policy';

const m = vi.hoisted(() => ({
  updateTag: vi.fn(),
  revalidatePath: vi.fn(),
  after: vi.fn<(task: () => Promise<void>) => void>(),
  adminRpc: vi.fn(),
  isAdminToken: vi.fn(),
}));

vi.mock('next/cache', () => ({ updateTag: m.updateTag, revalidatePath: m.revalidatePath }));
vi.mock('next/server', () => ({ after: m.after }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`);
  },
  notFound: () => {
    throw new Error('notFound');
  },
}));
vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (name === 'br_admin_at' ? { value: 'admin-token' } : undefined),
      set: vi.fn(),
    }),
  headers: () => Promise.resolve(new Headers()),
}));
vi.mock('../../lib/admin/session', async (importOriginal) => ({
  ...(await importOriginal<typeof SessionModule>()),
  adminRpc: m.adminRpc,
  isAdminToken: m.isAdminToken,
  jwtSecondsLeft: () => 3600,
}));

const { dismissReportsAction, takeDownAction } = await import('./actions');

const BATTLE = 'b0260000-0000-4000-8000-000000000001';
const BUILD = 'c0260000-0000-4000-8000-000000000001';

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

beforeEach(() => {
  m.isAdminToken.mockResolvedValue(true);
});
afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('takeDownAction', () => {
  it("expires the battle's public copies at once, and again a little later", async () => {
    m.adminRpc.mockResolvedValue({
      data: { build_id: BUILD, battle_id: BATTLE, retried: false },
      error: null,
    });
    await expect(
      // A forged battle id in the form changes nothing: the RPC's answer decides.
      takeDownAction(form({ build_id: BUILD, battle_id: 'ignored', note: 'scam' })),
    ).rejects.toThrow(`redirect:/admin?done=taken_down&build=${BUILD}`);
    expect(m.adminRpc).toHaveBeenCalledWith('admin-token', 'admin_take_down_build', {
      p_build_id: BUILD,
      p_note: 'scam',
    });
    expect(m.updateTag).toHaveBeenCalledExactlyOnceWith(`battle:${BATTLE}`);

    // The second expiry (the page, by path) runs after the response.
    expect(m.after).toHaveBeenCalledTimes(1);
    expect(m.revalidatePath).not.toHaveBeenCalled();
    vi.useFakeTimers();
    const task = m.after.mock.calls[0]?.[0];
    const done = task?.();
    await vi.advanceTimersByTimeAsync(TAKEDOWN_REEXPIRE_MS - 1);
    expect(m.revalidatePath).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(m.revalidatePath.mock.calls).toEqual([[`/battles/${BATTLE}`]]);
  });

  it('also on a retry of the screenshot delete', async () => {
    m.adminRpc.mockResolvedValue({ data: { battle_id: BATTLE, retried: true }, error: null });
    await expect(takeDownAction(form({ build_id: BUILD }))).rejects.toThrow(
      `redirect:/admin?done=retried&build=${BUILD}`,
    );
    expect(m.updateTag).toHaveBeenCalledExactlyOnceWith(`battle:${BATTLE}`);
  });

  it('revalidates nothing when the takedown fails', async () => {
    m.adminRpc.mockResolvedValue({ data: null, error: 'already_taken_down' });
    await expect(takeDownAction(form({ build_id: BUILD }))).rejects.toThrow(
      'redirect:/admin?error=already_taken_down',
    );
    expect(m.updateTag).not.toHaveBeenCalled();
    expect(m.after).not.toHaveBeenCalled();
  });

  it('is a 404 (and revalidates nothing) for someone who is not an admin', async () => {
    m.isAdminToken.mockResolvedValue(false);
    await expect(takeDownAction(form({ build_id: BUILD }))).rejects.toThrow('notFound');
    expect(m.adminRpc).not.toHaveBeenCalled();
    expect(m.updateTag).not.toHaveBeenCalled();
  });
});

describe('dismissReportsAction', () => {
  it('changes nothing public, so revalidates nothing', async () => {
    m.adminRpc.mockResolvedValue({ data: { build_id: BUILD, dismissed: 2 }, error: null });
    await expect(dismissReportsAction(form({ build_id: BUILD }))).rejects.toThrow(
      `redirect:/admin?done=dismissed&build=${BUILD}&n=2`,
    );
    expect(m.updateTag).not.toHaveBeenCalled();
    expect(m.revalidatePath).not.toHaveBeenCalled();
    expect(m.after).not.toHaveBeenCalled();
  });
});
