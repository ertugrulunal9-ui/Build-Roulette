import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CdnError } from '../src/errors';
import { parseSri, verifyIntegrity } from '../src/integrity';

const data = Buffer.from('hello tarball');
const sha512 = `sha512-${createHash('sha512').update(data).digest('base64')}`;
const sha256 = `sha256-${createHash('sha256').update(data).digest('base64')}`;
const sha1 = createHash('sha1').update(data).digest('hex');
const wrong512 = `sha512-${createHash('sha512').update('other').digest('base64')}`;

function failure(fn: () => unknown): string {
  try {
    fn();
    return 'ok';
  } catch (e) {
    expect(e).toBeInstanceOf(CdnError);
    return (e as CdnError).message;
  }
}

describe('verifyIntegrity', () => {
  it('accepts a matching sha512', () => {
    expect(verifyIntegrity(data, { integrity: sha512 })).toEqual({ algorithm: 'sha512' });
  });

  it('rejects a mismatching sha512', () => {
    expect(failure(() => verifyIntegrity(data, { integrity: wrong512 }))).toMatch(
      /sha512 digest does not match/,
    );
  });

  it('uses the strongest algorithm listed and accepts any digest of it', () => {
    // sha512 present: a matching weaker hash does not rescue a wrong sha512.
    expect(failure(() => verifyIntegrity(data, { integrity: `${sha256} ${wrong512}` }))).toMatch(
      /sha512/,
    );
    expect(verifyIntegrity(data, { integrity: `${wrong512} ${sha512}` }).algorithm).toBe('sha512');
    expect(verifyIntegrity(data, { integrity: sha256 }).algorithm).toBe('sha256');
  });

  it('falls back to sha1 shasum only when allowed', () => {
    expect(failure(() => verifyIntegrity(data, { shasum: sha1 }))).toMatch(
      /did not provide a supported integrity hash/,
    );
    expect(verifyIntegrity(data, { shasum: sha1 }, { allowSha1Fallback: true }).algorithm).toBe(
      'sha1',
    );
    expect(
      failure(() => verifyIntegrity(data, { shasum: '0'.repeat(40) }, { allowSha1Fallback: true })),
    ).toMatch(/sha1 shasum does not match/);
  });

  it('ignores unknown algorithms and malformed tokens', () => {
    expect(parseSri('md5-abc sha512 sha512-!!! foo').size).toBe(0);
    expect(failure(() => verifyIntegrity(data, { integrity: 'md5-xyz' }))).toMatch(
      /supported integrity hash/,
    );
  });
});
