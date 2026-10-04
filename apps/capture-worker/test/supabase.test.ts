import { describe, expect, it } from 'vitest';
import { BackendError } from '../src/backend';
import { encodePath, SupabaseBackend } from '../src/supabase';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const impl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const raw = init?.body;
    const call: Call = {
      url: input instanceof Request ? input.url : input.toString(),
      method: init?.method ?? 'GET',
      headers: init?.headers as Record<string, string>,
      body: typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw,
    };
    calls.push(call);
    return Promise.resolve(respond(call));
  };
  return { calls, impl };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('SupabaseBackend', () => {
  it('sends the legacy JWT service key as apikey and Bearer; a sb_secret key as apikey only', async () => {
    const f = fakeFetch(() => json(200, null));
    await new SupabaseBackend({
      url: 'http://db/',
      serviceKey: 'eyJabc',
      fetch: f.impl,
    }).completeDestroy('b');
    await new SupabaseBackend({
      url: 'http://db',
      serviceKey: 'sb_secret_x',
      fetch: f.impl,
    }).completeDestroy('b');
    expect(f.calls[0]?.url).toBe('http://db/rest/v1/rpc/complete_destroy');
    expect(f.calls[0]?.headers).toMatchObject({ apikey: 'eyJabc', authorization: 'Bearer eyJabc' });
    expect(f.calls[0]?.body).toEqual({ p_battle_id: 'b' });
    expect(f.calls[1]?.headers['authorization']).toBeUndefined();
    expect(f.calls[1]?.headers['apikey']).toBe('sb_secret_x');
  });

  it('claim_job: an all-null row means "nothing to do"', async () => {
    const empty = fakeFetch(() =>
      json(200, { id: null, kind: null, ref_id: null, status: null, attempts: null }),
    );
    const b1 = new SupabaseBackend({ url: 'http://db', serviceKey: 'k', fetch: empty.impl });
    expect(await b1.claimJob('capture')).toBeNull();
    expect(empty.calls[0]?.body).toEqual({ p_kind: 'capture' });

    const row = {
      id: 7,
      kind: 'destroy',
      ref_id: 'r',
      status: 'running',
      attempts: 1,
      run_after: 'x',
      last_error: null,
    };
    const one = fakeFetch(() => json(200, row));
    const b2 = new SupabaseBackend({ url: 'http://db', serviceKey: 'k', fetch: one.impl });
    expect(await b2.claimJob('destroy')).toEqual(row);
  });

  it('PostgREST errors become BackendError with the stable code', async () => {
    const f = fakeFetch(() =>
      json(400, {
        code: 'P0001',
        message: 'wrong_phase',
        details: 'Cannot destroy a battle in results.',
      }),
    );
    const b = new SupabaseBackend({ url: 'http://db', serviceKey: 'k', fetch: f.impl });
    const err = await b.completeDestroy('x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackendError);
    expect(err).toMatchObject({ status: 400, code: 'wrong_phase' });
    expect((err as Error).message).toContain('Cannot destroy a battle in results.');
  });

  it('Storage: HTTP 400 with statusCode 404 in the body means "not found" for sign and download', async () => {
    const f = fakeFetch(() =>
      json(400, { statusCode: '404', error: 'not_found', message: 'Object not found' }),
    );
    const b = new SupabaseBackend({ url: 'http://db', serviceKey: 'k', fetch: f.impl });
    expect(await b.createSignedUrl('ephemeral-builds', 'a/b/bundle.js', 60)).toBeNull();
    expect(await b.download('ephemeral-builds', 'a/b/thumb.webp')).toBeNull();
    expect(f.calls[0]?.url).toBe('http://db/storage/v1/object/sign/ephemeral-builds/a/b/bundle.js');
    expect(f.calls[0]?.body).toEqual({ expiresIn: 60 });
    expect(f.calls[1]?.url).toBe(
      'http://db/storage/v1/object/authenticated/ephemeral-builds/a/b/thumb.webp',
    );
    // …but not for an upload.
    await expect(
      b.upload('screenshots', 'a/b.webp', new Uint8Array([1]), 'image/webp'),
    ).rejects.toMatchObject({
      status: 404,
    });
  });

  it('Storage: signed URLs are absolute, uploads upsert, list pages and marks folders', async () => {
    let page = 0;
    const f = fakeFetch((call) => {
      if (call.url.includes('/object/sign/'))
        return json(200, { signedURL: '/object/sign/x?token=t' });
      if (call.url.includes('/object/list/')) {
        page++;
        if (page === 1) {
          return json(
            200,
            Array.from({ length: 1000 }, (_, i) => ({ name: `f${String(i)}`, id: 'x' })),
          );
        }
        return json(200, [{ name: 'autosave', id: null }]);
      }
      if (call.method === 'DELETE') return json(200, [{ name: 'a/1' }]);
      return json(200, { Key: 'k' });
    });
    const b = new SupabaseBackend({ url: 'http://db', serviceKey: 'k', fetch: f.impl });
    expect(await b.createSignedUrl('ephemeral-builds', 'x', 60)).toBe(
      'http://db/storage/v1/object/sign/x?token=t',
    );
    await b.upload('screenshots', 'a/b.webp', new Uint8Array([1, 2]), 'image/webp');
    const up = f.calls.find(
      (c) => c.method === 'POST' && c.url.endsWith('/object/screenshots/a/b.webp'),
    );
    expect(up?.headers).toMatchObject({ 'content-type': 'image/webp', 'x-upsert': 'true' });
    const entries = await b.list('ephemeral-builds', 'a/');
    expect(entries).toHaveLength(1001);
    expect(entries.at(-1)).toEqual({ name: 'autosave', isFolder: true });
    const lists = f.calls.filter((c) => c.url.endsWith('/object/list/ephemeral-builds'));
    expect(lists.map((c) => (c.body as { offset: number }).offset)).toEqual([0, 1000]);
    expect(await b.remove('ephemeral-builds', ['a/1', 'a/2'])).toEqual(['a/1']);
    expect(await b.remove('ephemeral-builds', [])).toEqual([]);
  });

  it('encodes path segments', () => {
    expect(encodePath('a b/c#d/e')).toBe('a%20b/c%23d/e');
  });
});
