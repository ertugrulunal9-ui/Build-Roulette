import { describe, expect, it } from 'vitest';
import { IMPORT_URL_HOSTS, checkPublicUrl, isLoginUrl } from './hosts';

const code = (url: string, extra: string[] = []) => {
  const r = checkPublicUrl(url, extra);
  return r.ok ? 'ok' : r.error.code;
};

describe('checkPublicUrl', () => {
  it('accepts a subdomain of every allowed host', () => {
    for (const h of IMPORT_URL_HOSTS) expect(code(`https://my-app.${h}/`), h).toBe('ok');
    expect(code('https://a.b.netlify.app/x/y.html?q=1#top')).toBe('ok');
    expect(code('https://someone.github.io/portfolio/')).toBe('ok');
  });

  it('refuses the bare apex and look-alike hosts', () => {
    expect(code('https://lovable.app/')).toBe('url-host-not-allowed');
    expect(code('https://github.io/')).toBe('url-host-not-allowed');
    expect(code('https://evil-lovable.app/')).toBe('url-host-not-allowed');
    expect(code('https://x.evil-lovable.app/')).toBe('url-host-not-allowed');
    expect(code('https://lovable.app.evil.com/')).toBe('url-host-not-allowed');
    expect(code('https://x.lovable.app.evil.com/')).toBe('url-host-not-allowed');
    expect(code('https://xlovable.app/')).toBe('url-host-not-allowed');
    expect(code('https://example.com/')).toBe('url-host-not-allowed');
    expect(code('https://x.lovable.dev/')).toBe('url-host-not-allowed');
  });

  it('compares hosts as URL normalizes them: case, punycode, trailing dots, empty labels', () => {
    const upper = checkPublicUrl('HTTPS://My-App.LOVABLE.App/Path');
    expect(upper.ok && upper.url.hostname).toBe('my-app.lovable.app');
    expect(upper.ok && upper.url.pathname).toBe('/Path');
    // An internationalized subdomain is fine (punycode)…
    const idn = checkPublicUrl('https://münchen.netlify.app/');
    expect(idn.ok && idn.url.hostname).toBe('xn--mnchen-3ya.netlify.app');
    expect(code('https://xn--mnchen-3ya.netlify.app/')).toBe('ok');
    // …but a look-alike apex (Cyrillic "а") is another host.
    expect(code('https://x.lovаble.app/')).toBe('url-host-not-allowed');
    expect(code('https://x.lovable.app./')).toBe('url-host-not-allowed');
    expect(code('https://lovable.app./')).toBe('url-host-not-allowed');
    expect(code('https://a..lovable.app/')).toBe('url-host-not-allowed');
  });

  it('refuses IP literals, local names and anything that is not plain https', () => {
    expect(code('https://127.0.0.1/')).toBe('url-host-not-allowed');
    expect(code('https://127.1/')).toBe('url-host-not-allowed'); // URL makes it 127.0.0.1
    expect(code('https://0x7f.1/')).toBe('url-host-not-allowed');
    expect(code('https://2130706433/')).toBe('url-host-not-allowed');
    expect(code('https://169.254.169.254/latest/meta-data/')).toBe('url-host-not-allowed');
    expect(code('https://[::1]/')).toBe('url-host-not-allowed');
    expect(code('https://[::ffff:127.0.0.1]/')).toBe('url-host-not-allowed');
    expect(code('https://[fd00::1]/')).toBe('url-host-not-allowed');
    expect(code('https://localhost/')).toBe('url-host-not-allowed');
    expect(code('https://x.lovable.app.localhost/')).toBe('url-host-not-allowed');
    expect(code('https://printer.local/')).toBe('url-host-not-allowed');
    expect(code('https://metadata.google.internal/')).toBe('url-host-not-allowed');
    // A numeric-looking subdomain of an allowed host is a name, not an IP.
    expect(code('https://1.2.3.4.lovable.app/')).toBe('ok');
  });

  it('refuses other schemes, ports and credentials', () => {
    expect(code('http://my-app.lovable.app/')).toBe('url-invalid');
    expect(code('ftp://my-app.lovable.app/')).toBe('url-invalid');
    expect(code('file:///etc/passwd')).toBe('url-invalid');
    expect(code('javascript:alert(1)')).toBe('url-invalid');
    expect(code('https://my-app.lovable.app:8443/')).toBe('url-invalid');
    expect(code('https://my-app.lovable.app:443/')).toBe('ok'); // the default port
    expect(code('https://user:pw@my-app.lovable.app/')).toBe('url-invalid');
    expect(code('https://user@my-app.lovable.app/')).toBe('url-invalid');
  });

  it('refuses what is not a link, and very long ones', () => {
    expect(code('')).toBe('url-invalid');
    expect(code('   ')).toBe('url-invalid');
    expect(code('my-app.lovable.app')).toBe('url-invalid');
    expect(code('/assets/x.js')).toBe('url-invalid');
    expect(code(`https://my-app.lovable.app/${'a'.repeat(2100)}`)).toBe('url-invalid');
    expect(code('  https://my-app.lovable.app/  ')).toBe('ok');
  });

  it('accepts exact extra origins only (the local test run)', () => {
    const extra = ['http://127.0.0.1:4321'];
    expect(code('http://127.0.0.1:4321/site/', extra)).toBe('ok');
    expect(code('http://127.0.0.1:4322/', extra)).toBe('url-invalid');
    expect(code('https://127.0.0.1:4321/', extra)).toBe('url-invalid');
    expect(code('http://u:p@127.0.0.1:4321/', extra)).toBe('url-invalid');
    expect(code('http://127.0.0.1:4321/')).toBe('url-invalid');
  });

  it('takes URL objects too', () => {
    expect(checkPublicUrl(new URL('https://a.pages.dev/')).ok).toBe(true);
    expect(checkPublicUrl(new URL('https://pages.dev/')).ok).toBe(false);
  });
});

describe('isLoginUrl', () => {
  it('knows the login pages hosts redirect private sites to', () => {
    expect(isLoginUrl(new URL('https://vercel.com/login?next=x'))).toBe(true);
    expect(isLoginUrl(new URL('https://vercel.com/sso-api?url=x'))).toBe(true);
    expect(isLoginUrl(new URL('https://lovable.dev/login'))).toBe(true);
    expect(isLoginUrl(new URL('https://team.cloudflareaccess.com/cdn-cgi/access/login'))).toBe(
      true,
    );
    expect(isLoginUrl(new URL('https://evil.example.com/'))).toBe(false);
    expect(isLoginUrl(new URL('https://notvercel.com/'))).toBe(false);
  });
});
