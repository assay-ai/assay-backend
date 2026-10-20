import { registrableDomain } from '@modules/oauth/domain/registrable-domain';

describe('registrableDomain', () => {
  it('a.b.claude.ai → claude.ai', () => {
    expect(registrableDomain('a.b.claude.ai')).toEqual({
      registrable: 'claude.ai',
      host: 'a.b.claude.ai',
    });
  });

  it('foo.github.io → foo.github.io (PSL private section)', () => {
    expect(registrableDomain('foo.github.io')).toEqual({
      registrable: 'foo.github.io',
      host: 'foo.github.io',
    });
    expect(registrableDomain('a.foo.github.io')?.registrable).toBe('foo.github.io');
  });

  it('honours multi-label public suffixes', () => {
    expect(registrableDomain('www.example.co.uk')?.registrable).toBe('example.co.uk');
  });

  it('an xn-- IDN stays punycode', () => {
    expect(registrableDomain('app.xn--bcher-kva.de')).toEqual({
      registrable: 'xn--bcher-kva.de',
      host: 'app.xn--bcher-kva.de',
    });
    expect(registrableDomain('xn--e1afmkfd.xn--p1ai')?.registrable).toBe('xn--e1afmkfd.xn--p1ai');
  });

  it('a Unicode host is returned as punycode', () => {
    expect(registrableDomain('app.bücher.de')).toEqual({
      registrable: 'xn--bcher-kva.de',
      host: 'app.xn--bcher-kva.de',
    });
    expect(registrableDomain('пример.рф')?.registrable).toBe('xn--e1afmkfd.xn--p1ai');
  });

  it('lowercases', () => {
    expect(registrableDomain('A.B.Claude.AI')).toEqual({
      registrable: 'claude.ai',
      host: 'a.b.claude.ai',
    });
  });

  it.each([
    ['an IPv4 literal', '1.2.3.4'],
    ['a bracketed IPv6 literal', '[::1]'],
    ['a bare IPv6 literal', '::1'],
    ['a public suffix itself', 'co.uk'],
    ['a private public suffix itself', 'github.io'],
    ['localhost', 'localhost'],
    ['a single label', 'intranet'],
    ['a reserved TLD', 'foo.localhost'],
    ['an unlisted TLD', 'foo.internal'],
    ['a trailing dot', 'claude.ai.'],
    ['invalid punycode', 'xn--zz.com'],
    ['a port', 'claude.ai:443'],
    ['a path', 'claude.ai/x'],
    ['whitespace', 'claude .ai'],
    ['the empty string', ''],
  ])('refuses %s', (_label, host) => {
    expect(registrableDomain(host)).toBeNull();
  });

  it('refuses non-strings', () => {
    expect(registrableDomain(undefined as unknown as string)).toBeNull();
    expect(registrableDomain(null as unknown as string)).toBeNull();
  });
});
