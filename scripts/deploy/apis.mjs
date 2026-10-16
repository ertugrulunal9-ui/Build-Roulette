// The HTTP APIs the deploy uses (T-042), on an injected `fetch`. Tokens only ever go in the
// Authorization (or apikey) header; error messages carry the API's own error text, never a
// request or response body that could hold a secret.
//
// Cloudflare (https://api.cloudflare.com/client/v4), as wrangler 4.147 calls it:
//   GET   /user/tokens/verify                    → result.status ("active"); an account-owned
//         token answers error 1000 there, then  GET /accounts/{id}/tokens/verify
//   GET   /accounts/{id}/pages/projects/{name}    → result {name, subdomain, production_branch,
//         source?, deployment_configs.production.{env_vars, wrangler_config_hash}};
//         HTTP 404 with error 8000007 when it does not exist
//   POST  /accounts/{id}/pages/projects           {name, production_branch} → result.subdomain
//   PATCH /accounts/{id}/pages/projects/{name}    {deployment_configs: {production: {env_vars:
//         {KEY: {type: "secret_text", value}}}}} (what `wrangler pages secret put` sends)
// Supabase Management API (https://api.supabase.com), as the Supabase CLI 2.119.0 describes it:
//   GET   /v1/projects/{ref}                      → {ref, name, region, status: ACTIVE_HEALTHY | INACTIVE (paused) | …}
//   POST  /v1/projects/{ref}/database/query       {query} → 201, the rows as JSON
//   GET   /v1/projects/{ref}/config/auth          PATCH the same path with only the changed fields
//   GET   /v1/projects/{ref}/secrets              → [{name, value: digest, updated_at}]
//   POST  /v1/projects/{ref}/secrets              [{name, value}]

export const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
export const SUPABASE_API = 'https://api.supabase.com';
const TIMEOUT_MS = 30_000;

export class ApiError extends Error {
  /** @param {string} message @param {{status?: number, codes?: number[], api?: string}} [info] */
  constructor(message, { status = 0, codes = [], api = '' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.codes = codes;
    /** 'cloudflare' or 'supabase' */
    this.api = api;
  }
}

/**
 * One HTTP call with retries: reads retry network errors, 5xx and 429; writes retry only 429
 * (the request was not processed). Returns {status, json, text}.
 */
async function call(fetchImpl, sleep, url, { method = 'GET', headers = {}, body } = {}) {
  const read = method === 'GET';
  const attempts = 3;
  for (let i = 1; ; i++) {
    let res;
    let text;
    try {
      res = await fetchImpl(url, {
        method,
        headers: { accept: 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      text = await res.text();
    } catch (e) {
      if (read && i < attempts) {
        await sleep(2_000 * i);
        continue;
      }
      throw new ApiError(
        `no answer from ${new URL(url).host} (${e instanceof Error ? e.message : String(e)})`,
      );
    }
    if ((res.status === 429 || (read && res.status >= 500)) && i < attempts) {
      await sleep(3_000 * i);
      continue;
    }
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = undefined;
    }
    return { status: res.status, json, text };
  }
}

const short = (s, n = 300) => {
  const t = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

// ─── Cloudflare ─────────────────────────────────────────────────────────────

/** @param {{fetch: typeof fetch, sleep: (ms: number) => Promise<void>, token: string, accountId: string, base?: string}} o */
export function cloudflareApi({
  fetch: fetchImpl,
  sleep,
  token,
  accountId,
  base = CLOUDFLARE_API,
}) {
  const req = async (path, opts = {}) => {
    const r = await call(fetchImpl, sleep, `${base}${path}`, {
      ...opts,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    });
    const errors = Array.isArray(r.json?.errors) ? r.json.errors : [];
    const ok = r.status >= 200 && r.status < 300 && r.json?.success === true;
    const codes = errors.map((e) => Number(e?.code)).filter(Number.isFinite);
    const message = errors.length
      ? errors.map((e) => `${String(e?.code)} ${short(e?.message, 160)}`).join('; ')
      : `HTTP ${String(r.status)}`;
    return { ...r, ok, codes, message };
  };
  const fail = (what, r) =>
    new ApiError(`${what}: ${r.message} (HTTP ${String(r.status)})`, {
      status: r.status,
      codes: r.codes,
      api: 'cloudflare',
    });
  const projectPath = (name) => `/accounts/${accountId}/pages/projects/${encodeURIComponent(name)}`;

  return {
    /**
     * {status: 'active' | 'disabled' | 'expired', kind: 'user' | 'account'}. With
     * `accountFallback`, an account-owned token (error 1000 on /user) is verified on the account.
     */
    async verifyToken({ accountFallback = true } = {}) {
      let r = await req('/user/tokens/verify');
      let kind = 'user';
      if (!r.ok && accountFallback && r.codes.includes(1000)) {
        // An account-owned token (Manage Account → API Tokens) verifies on the account.
        r = await req(`/accounts/${accountId}/tokens/verify`);
        kind = 'account';
      }
      if (!r.ok) throw fail('token refused', r);
      return { status: String(r.json.result?.status ?? 'unknown'), kind };
    },
    /** The project, or null when it does not exist (404, error 8000007). */
    async getProject(name) {
      const r = await req(projectPath(name));
      if (r.ok) return r.json.result;
      if (r.status === 404 && r.codes.includes(8000007)) return null;
      throw fail(`reading the Pages project ${name}`, r);
    },
    async createProject(name, productionBranch) {
      const r = await req(`/accounts/${accountId}/pages/projects`, {
        method: 'POST',
        body: { name, production_branch: productionBranch },
      });
      if (!r.ok) throw fail(`creating the Pages project ${name}`, r);
      return r.json.result;
    },
    /** A production secret (`secret_text`) on a Pages project; applies to the next deployment. */
    async setSecret(name, key, value, wranglerConfigHash) {
      const production = { env_vars: { [key]: { type: 'secret_text', value } } };
      if (wranglerConfigHash) production.wrangler_config_hash = wranglerConfigHash;
      const r = await req(projectPath(name), {
        method: 'PATCH',
        body: { deployment_configs: { production } },
      });
      if (!r.ok) throw fail(`setting ${key} on the Pages project ${name}`, r);
    },
  };
}

// ─── Supabase ───────────────────────────────────────────────────────────────

/** @param {{fetch: typeof fetch, sleep: (ms: number) => Promise<void>, token: string, ref: string, base?: string}} o */
export function supabaseApi({ fetch: fetchImpl, sleep, token, ref, base = SUPABASE_API }) {
  const req = (path, opts = {}) =>
    call(fetchImpl, sleep, `${base}/v1/projects/${ref}${path}`, {
      ...opts,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    });
  const fail = (what, r) => {
    const detail = r.json?.message ?? r.json?.error ?? r.json?.msg;
    return new ApiError(
      `${what}: HTTP ${String(r.status)}${detail ? ` ${short(typeof detail === 'string' ? detail : JSON.stringify(detail))}` : ''}`,
      { status: r.status, api: 'supabase' },
    );
  };
  const ok = (r) => r.status >= 200 && r.status < 300;

  return {
    async getProject() {
      const r = await req('');
      if (!ok(r) || !r.json) throw fail(`reading the project ${ref}`, r);
      return r.json;
    },
    /** Runs one SQL statement; returns its rows. */
    async query(sql) {
      const r = await req('/database/query', { method: 'POST', body: { query: sql } });
      if (!ok(r)) throw fail('SQL', r);
      if (!Array.isArray(r.json)) throw new ApiError('SQL: the answer was not a list of rows');
      return r.json;
    },
    async getAuthConfig() {
      const r = await req('/config/auth');
      if (!ok(r) || !r.json) throw fail('reading the Auth settings', r);
      return r.json;
    },
    async patchAuthConfig(patch) {
      const r = await req('/config/auth', { method: 'PATCH', body: patch });
      if (!ok(r)) throw fail(`changing the Auth settings (${Object.keys(patch).join(', ')})`, r);
    },
    /** [{name, value}] where value is a digest of the secret (never the secret itself). */
    async listSecrets() {
      const r = await req('/secrets');
      if (!ok(r) || !Array.isArray(r.json)) throw fail("reading the functions' secret names", r);
      return r.json;
    },
    async setSecrets(list) {
      const r = await req('/secrets', { method: 'POST', body: list });
      if (!ok(r))
        throw fail(`setting the function secrets ${list.map((s) => s.name).join(', ')}`, r);
    },
  };
}

/**
 * GET {supabaseUrl}/auth/v1/settings with the app's key: 200 when the key belongs to the
 * project. Returns {status, settings}.
 */
export async function authSettings({ fetch: fetchImpl, sleep }, supabaseUrl, anonKey) {
  const headers = { apikey: anonKey };
  // A legacy anon key is a JWT and also goes in Authorization; a publishable key does not.
  if (anonKey.startsWith('eyJ')) headers.authorization = `Bearer ${anonKey}`;
  const r = await call(fetchImpl, sleep, `${supabaseUrl}/auth/v1/settings`, { headers });
  return { status: r.status, settings: r.json ?? null };
}
