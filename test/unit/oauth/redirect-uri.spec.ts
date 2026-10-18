import {
  RedirectAllowlistEntry,
  isValidAllowlistUri,
  matches,
  registrable,
} from '@modules/oauth/domain/redirect-uri';

/** §6.3.9's initial allowlist. */
const ALLOWLIST: RedirectAllowlistEntry[] = [
  { uri: 'https://chatgpt.com/connector_platform_oauth_redirect', review: false },
  { uri: 'https://claude.ai/api/mcp/auth_callback', review: true },
  { uri: 'https://claude.com/api/mcp/auth_callback', review: true },
  { uri: 'https://vscode.dev/redirect', review: true },
  { uri: 'cursor://example.cursor/oauth/callback', review: true },
];

const CHATGPT = 'https://chatgpt.com/connector_platform_oauth_redirect';
const CLAUDE = 'https://claude.ai/api/mcp/auth_callback';
const LOOPBACK = 'http://127.0.0.1/callback';

describe('redirect URIs (§6.3.9)', () => {
  describe('loopback (RFC 8252 §7.3)', () => {
    it('http://127.0.0.1:5555/callback matches a registered http://127.0.0.1/callback', () => {
      expect(matches([LOOPBACK], 'http://127.0.0.1:5555/callback', ALLOWLIST)).toBe(true);
    });

    it('/callback/x does not', () => {
      expect(matches([LOOPBACK], 'http://127.0.0.1:5555/callback/x', ALLOWLIST)).toBe(false);
    });

    it('ignores the port on both sides', () => {
      const registered = ['http://127.0.0.1:8080/callback'];
      expect(matches(registered, 'http://127.0.0.1:5555/callback', ALLOWLIST)).toBe(true);
      expect(matches(registered, 'http://127.0.0.1/callback', ALLOWLIST)).toBe(true);
      expect(matches(registered, 'http://127.0.0.1:65535/callback', ALLOWLIST)).toBe(true);
    });

    it('matches each loopback host only against itself', () => {
      for (const host of ['127.0.0.1', '[::1]', 'localhost']) {
        const registered = [`http://${host}/cb`];
        expect(matches(registered, `http://${host}:4242/cb`, ALLOWLIST)).toBe(true);
        for (const other of ['127.0.0.1', '[::1]', 'localhost'].filter((h) => h !== host)) {
          expect(matches(registered, `http://${other}:4242/cb`, ALLOWLIST)).toBe(false);
        }
      }
    });

    it('treats an empty path as /', () => {
      expect(matches(['http://127.0.0.1'], 'http://127.0.0.1:4000/', ALLOWLIST)).toBe(true);
      expect(matches(['http://127.0.0.1/'], 'http://127.0.0.1:4000', ALLOWLIST)).toBe(true);
      expect(matches(['http://127.0.0.1/'], 'http://127.0.0.1:4000/x', ALLOWLIST)).toBe(false);
    });

    it('compares the path exactly', () => {
      for (const requested of [
        'http://127.0.0.1:5555/callback/',
        'http://127.0.0.1:5555/Callback',
        'http://127.0.0.1:5555/callbac',
        'http://127.0.0.1:5555/callbackx',
        'http://127.0.0.1:5555//callback',
        'http://127.0.0.1:5555/x/../callback',
        'http://127.0.0.1:5555/./callback',
        'http://127.0.0.1:5555/%63allback',
        'http://127.0.0.1:5555/callback%2F',
        'http://127.0.0.1:5555/callback;x',
        'http://127.0.0.1:5555\\callback',
      ]) {
        expect(matches([LOOPBACK], requested, ALLOWLIST)).toBe(false);
      }
    });

    it('refuses a query or a fragment, even an empty one', () => {
      for (const requested of [
        'http://127.0.0.1:5555/callback?',
        'http://127.0.0.1:5555/callback?x=1',
        'http://127.0.0.1:5555/callback#',
        'http://127.0.0.1:5555/callback#f',
      ]) {
        expect(matches([LOOPBACK], requested, ALLOWLIST)).toBe(false);
      }
      expect(registrable('http://127.0.0.1/callback?x=1', ALLOWLIST)).toBe(false);
      expect(registrable('http://127.0.0.1/callback#f', ALLOWLIST)).toBe(false);
    });

    it('refuses hosts that only look like loopback', () => {
      for (const host of [
        '127.0.0.2',
        '127.1',
        '127.0.0.1.',
        '0x7f.0.0.1',
        '2130706433',
        '0177.0.0.1',
        '0.0.0.0',
        '[0:0:0:0:0:0:0:1]',
        '[::ffff:127.0.0.1]',
        '[::1%25lo0]',
        '::1',
        'localhost.',
        'localhost.example.com',
        '127.0.0.1.example.com',
        'sub.localhost',
        'LOCALHOST',
        'LocalHost',
      ]) {
        const uri = `http://${host}:5555/callback`;
        expect(registrable(uri, ALLOWLIST)).toBe(false);
        expect(matches([`http://${host}/callback`, LOOPBACK], uri, ALLOWLIST)).toBe(false);
      }
    });

    it('refuses an uppercase or https scheme', () => {
      for (const uri of [
        'HTTP://127.0.0.1/callback',
        'Http://127.0.0.1/callback',
        'https://127.0.0.1/callback',
      ]) {
        expect(registrable(uri, ALLOWLIST)).toBe(false);
        expect(
          matches([LOOPBACK, uri], uri.replace('/callback', ':5555/callback'), ALLOWLIST),
        ).toBe(false);
      }
    });

    it('refuses userinfo, odd ports and smuggled authorities', () => {
      for (const uri of [
        'http://user@127.0.0.1/callback',
        'http://user:pw@127.0.0.1:5555/callback',
        'http://127.0.0.1@evil.example/callback',
        'http://evil.example#@127.0.0.1/callback',
        'http://127.0.0.1:/callback',
        'http://127.0.0.1:0/callback',
        'http://127.0.0.1:65536/callback',
        'http://127.0.0.1:05555/callback',
        'http://127.0.0.1:5555x/callback',
        'http://127.0.0.1:+5555/callback',
        'http://127.0.0.1 /callback',
        ' http://127.0.0.1/callback',
        'http://127.0.0.1/callback ',
        'http://127.0.0.1/callback\n',
        'http://127.0.0.1/call\tback',
        'http:/127.0.0.1/callback',
        'http:127.0.0.1/callback',
        '//127.0.0.1/callback',
      ]) {
        expect(registrable(uri, ALLOWLIST)).toBe(false);
        expect(matches([LOOPBACK], uri, ALLOWLIST)).toBe(false);
      }
    });

    it('refuses dot segments and percent-encoding in a registered loopback path', () => {
      for (const uri of [
        'http://127.0.0.1/a/../callback',
        'http://127.0.0.1/./callback',
        'http://127.0.0.1/callback/..',
        'http://127.0.0.1/callback/.',
        'http://127.0.0.1/%2e%2e/callback',
        'http://127.0.0.1/call%20back',
      ]) {
        expect(registrable(uri, ALLOWLIST)).toBe(false);
      }
    });

    it('accepts ordinary loopback paths', () => {
      for (const uri of [
        'http://127.0.0.1/callback',
        'http://127.0.0.1:33418/',
        'http://127.0.0.1:33418',
        'http://[::1]:8080/oauth/callback',
        'http://localhost:1455/auth/callback',
        'http://127.0.0.1/a.b_c~d-e',
      ]) {
        expect(registrable(uri, ALLOWLIST)).toBe(true);
      }
    });
  });

  describe('allowlist', () => {
    it('https://chatgpt.com/connector_platform_oauth_redirect is allowed', () => {
      expect(registrable(CHATGPT, ALLOWLIST)).toBe(true);
      expect(matches([CHATGPT], CHATGPT, ALLOWLIST)).toBe(true);
    });

    it('https://claude.ai/api/mcp/auth_callback is refused while review:true', () => {
      expect(registrable(CLAUDE, ALLOWLIST)).toBe(false);
      expect(matches([CLAUDE], CLAUDE, ALLOWLIST)).toBe(false);
    });

    it('is allowed once its review is cleared', () => {
      const cleared = ALLOWLIST.map((e) => (e.uri === CLAUDE ? { ...e, review: false } : e));
      expect(matches([CLAUDE], CLAUDE, cleared)).toBe(true);
    });

    it('refuses a private-use scheme entry under review', () => {
      const uri = 'cursor://example.cursor/oauth/callback';
      expect(matches([uri], uri, ALLOWLIST)).toBe(false);
      const cleared = [{ uri, review: false }];
      expect(matches([uri], uri, cleared)).toBe(true);
    });

    it('…redirect?x=1 is refused', () => {
      expect(matches([CHATGPT], `${CHATGPT}?x=1`, ALLOWLIST)).toBe(false);
      expect(matches([`${CHATGPT}?x=1`], `${CHATGPT}?x=1`, ALLOWLIST)).toBe(false);
      expect(registrable(`${CHATGPT}?x=1`, ALLOWLIST)).toBe(false);
    });

    it('…redirect#f is refused', () => {
      expect(matches([CHATGPT], `${CHATGPT}#f`, ALLOWLIST)).toBe(false);
      expect(matches([CHATGPT], `${CHATGPT}#`, ALLOWLIST)).toBe(false);
      expect(registrable(`${CHATGPT}#f`, ALLOWLIST)).toBe(false);
    });

    it('https://chatgpt.com.evil.com/... is refused', () => {
      const evil = 'https://chatgpt.com.evil.com/connector_platform_oauth_redirect';
      expect(registrable(evil, ALLOWLIST)).toBe(false);
      expect(matches([CHATGPT, evil], evil, ALLOWLIST)).toBe(false);
    });

    it('refuses prefix, suffix, case, encoding and authority variants', () => {
      for (const variant of [
        `${CHATGPT}/`,
        `${CHATGPT}x`,
        `${CHATGPT}/../connector_platform_oauth_redirect`,
        CHATGPT.slice(0, -1),
        'https://chatgpt.com/',
        'https://chatgpt.com',
        'https://CHATGPT.com/connector_platform_oauth_redirect',
        'HTTPS://chatgpt.com/connector_platform_oauth_redirect',
        'https://chatgpt.com/Connector_platform_oauth_redirect',
        'https://chatgpt.com:443/connector_platform_oauth_redirect',
        'https://chatgpt.com./connector_platform_oauth_redirect',
        'https://chatgpt.com/connector%5Fplatform_oauth_redirect',
        'https://chatgpt.com/connector_platform_oauth_redirect%23f',
        'https://chatgpt.com/connector_platform_oauth_redirect%3Fx=1',
        'http://chatgpt.com/connector_platform_oauth_redirect',
        'https://user@chatgpt.com/connector_platform_oauth_redirect',
        'https://evil.example@chatgpt.com/connector_platform_oauth_redirect',
        'https://chatgpt.com@evil.example/connector_platform_oauth_redirect',
        'https://evil.example/https://chatgpt.com/connector_platform_oauth_redirect',
        'https://chatgpt.com\\@evil.example/connector_platform_oauth_redirect',
        ` ${CHATGPT}`,
        `${CHATGPT} `,
        `${CHATGPT}\n`,
        `${CHATGPT}\u0000`,
        `${CHATGPT}\u200b`,
      ]) {
        expect(registrable(variant, ALLOWLIST)).toBe(false);
        expect(matches([CHATGPT, variant], variant, ALLOWLIST)).toBe(false);
      }
    });

    it('requires the URI to be registered for the client, too', () => {
      expect(matches([], CHATGPT, ALLOWLIST)).toBe(false);
      expect(matches([LOOPBACK], CHATGPT, ALLOWLIST)).toBe(false);
      expect(matches([CHATGPT], LOOPBACK, ALLOWLIST)).toBe(false);
    });

    it('never honours a wildcard, prefix, query or fragment in an allowlist entry', () => {
      const bad: RedirectAllowlistEntry[] = [
        { uri: 'https://chatgpt.com/*', review: false },
        { uri: 'https://*.chatgpt.com/cb', review: false },
        { uri: 'https://chatgpt.com/cb?x=1', review: false },
        { uri: 'https://chatgpt.com/cb#f', review: false },
      ];
      for (const entry of bad) {
        expect(isValidAllowlistUri(entry.uri)).toBe(false);
        expect(matches([entry.uri], entry.uri, bad)).toBe(false);
      }
      expect(matches(['https://chatgpt.com/*'], 'https://chatgpt.com/anything', bad)).toBe(false);
      expect(matches(['https://chatgpt.com/cb'], 'https://chatgpt.com/cb', bad)).toBe(false);
    });

    it('refuses a loopback URI placed in the allowlist (only §6.3.9 rule 1 admits loopback)', () => {
      expect(isValidAllowlistUri('http://127.0.0.1/callback')).toBe(false);
    });

    it('validates allowlist entries: exact HTTPS or private-use scheme only', () => {
      for (const uri of [
        CHATGPT,
        'https://claude.ai/api/mcp/auth_callback',
        'cursor://example.cursor/oauth/callback',
        'com.example.app:/oauth2redirect',
      ]) {
        expect(isValidAllowlistUri(uri)).toBe(true);
      }
      for (const uri of [
        'http://chatgpt.com/cb',
        'https://chatgpt.com',
        'https://CHATGPT.com/cb',
        'https://1.2.3.4/cb',
        'https://user@chatgpt.com/cb',
        'javascript:alert(1)',
        'data:text/html,x',
        'file:///etc/passwd',
        'cursor:',
        'not a uri',
        '',
      ]) {
        expect(isValidAllowlistUri(uri)).toBe(false);
      }
    });

    it('fails closed instead of throwing when the allowlist is missing or malformed', () => {
      for (const allowlist of [undefined, null, {}, 'x', [null, 1, { uri: CHATGPT }]]) {
        const list = allowlist as unknown as RedirectAllowlistEntry[];
        expect(registrable(CHATGPT, list)).toBe(false);
        expect(matches([CHATGPT], CHATGPT, list)).toBe(false);
      }
      // Loopback does not depend on the allowlist.
      expect(registrable(LOOPBACK, undefined as unknown as RedirectAllowlistEntry[])).toBe(true);
    });

    it('refuses non-string input without throwing', () => {
      for (const value of [undefined, null, 1, {}, [CHATGPT]]) {
        expect(registrable(value as unknown as string, ALLOWLIST)).toBe(false);
        expect(matches([CHATGPT], value as unknown as string, ALLOWLIST)).toBe(false);
      }
    });
  });
});
