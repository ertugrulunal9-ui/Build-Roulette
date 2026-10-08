/**
 * The local Realtime tenant's quotas. The local stack's tenant (`realtime-dev`) starts with
 * the Free plan's numbers (200 concurrent connections, 100 events/s, 100 joins/s), so a
 * 400-client run needs them raised. `--realtime-limits pro` sets the Pro plan's published
 * quotas (ASSUMED values, see docs/07 §Parameters), so the run also checks whether the plan
 * we would launch on holds this load. The tenant API is Realtime's own management API
 * (behind Kong at /realtime/v1/api), authenticated with a JWT signed by the local JWT secret.
 * The original values are restored after the run.
 */
import { createHmac } from 'node:crypto';
import type { RealtimeLimits } from './config';

export interface TenantLimits {
  max_concurrent_users: number;
  max_events_per_second: number;
  max_joins_per_second: number;
  max_presence_events_per_second: number;
  max_bytes_per_second: number;
  max_channels_per_client: number;
}

/**
 * Supabase Realtime quotas per plan (ASSUMED, from Supabase's "Realtime limits" docs as the
 * author knew them; not re-checked 2026-10-07, pricing pages are unreachable here).
 * `max_bytes_per_second` is not a published quota; 100 000 is the local default and the
 * Pro value only keeps it from distorting the run.
 */
export const PLAN_LIMITS: Record<Exclude<RealtimeLimits, 'keep'>, TenantLimits> = {
  free: {
    max_concurrent_users: 200,
    max_events_per_second: 100,
    max_joins_per_second: 100,
    max_presence_events_per_second: 20,
    max_bytes_per_second: 100_000,
    max_channels_per_client: 100,
  },
  pro: {
    max_concurrent_users: 500,
    max_events_per_second: 500,
    max_joins_per_second: 500,
    max_presence_events_per_second: 50,
    max_bytes_per_second: 1_000_000,
    max_channels_per_client: 100,
  },
  /** Pro with the spend cap turned off (usage beyond the quotas is billed). */
  'pro-nocap': {
    max_concurrent_users: 10_000,
    max_events_per_second: 2_500,
    max_joins_per_second: 2_500,
    max_presence_events_per_second: 1_000,
    max_bytes_per_second: 10_000_000,
    max_channels_per_client: 100,
  },
  unlimited: {
    max_concurrent_users: 10_000,
    max_events_per_second: 10_000,
    max_joins_per_second: 10_000,
    max_presence_events_per_second: 10_000,
    max_bytes_per_second: 100_000_000,
    max_channels_per_client: 100,
  },
};

function serviceJwt(secret: string): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({
    role: 'service_role',
    iss: 'br-loadtest',
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

export class RealtimeTenant {
  private readonly url: string;
  private readonly headers: Record<string, string>;

  constructor(apiUrl: string, jwtSecret: string, tenant = 'realtime-dev') {
    this.url = `${apiUrl}/realtime/v1/api/tenants/${tenant}`;
    this.headers = {
      authorization: `Bearer ${serviceJwt(jwtSecret)}`,
      apikey: 'loadtest',
      'content-type': 'application/json',
    };
  }

  async get(): Promise<TenantLimits> {
    const res = await fetch(this.url, { headers: this.headers });
    if (!res.ok) throw new Error(`realtime tenant GET: HTTP ${String(res.status)}`);
    const body = (await res.json()) as { data: Record<string, unknown> };
    const d = body.data;
    const n = (k: keyof TenantLimits, fallback: number) =>
      typeof d[k] === 'number' ? d[k] : fallback;
    return {
      max_concurrent_users: n('max_concurrent_users', 200),
      max_events_per_second: n('max_events_per_second', 100),
      max_joins_per_second: n('max_joins_per_second', 100),
      max_presence_events_per_second: n('max_presence_events_per_second', 1000),
      max_bytes_per_second: n('max_bytes_per_second', 100_000),
      max_channels_per_client: n('max_channels_per_client', 100),
    };
  }

  async set(limits: TenantLimits): Promise<void> {
    const res = await fetch(this.url, {
      method: 'PATCH',
      headers: this.headers,
      body: JSON.stringify({ tenant: limits }),
    });
    if (!res.ok) throw new Error(`realtime tenant PATCH: HTTP ${String(res.status)}`);
  }
}
