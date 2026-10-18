import { CLIENT_NAME_MAX, claimsTrust, sanitise } from '@modules/oauth/domain/client-name';
import { validateClientMetadata } from '@modules/oauth/domain/client-metadata';

describe('client name sanitising', () => {
  it('keeps an ordinary name', () => {
    expect(sanitise('Claude Code')).toBe('Claude Code');
    expect(sanitise('Visual Studio Code')).toBe('Visual Studio Code');
  });

  it('trims and collapses whitespace', () => {
    expect(sanitise('  Claude   Code \u00a0')).toBe('Claude Code');
    expect(sanitise('\u3000Claude\u2003Code\u3000')).toBe('Claude Code');
  });

  it('strips control characters', () => {
    expect(sanitise('Claude\u0000 Code')).toBe('Claude Code');
    expect(sanitise('Claude\nCode')).toBe('ClaudeCode');
    expect(sanitise('Claude\u001b[31m Code')).toBe('Claude[31m Code');
    expect(sanitise('Claude\u007f\u0085 Code')).toBe('Claude Code');
  });

  it('strips bidi controls (a reversed name cannot be rendered)', () => {
    // "Trojan Source": U+202E flips the rest of the line.
    expect(sanitise('\u202eedoC edualC')).toBe('edoC edualC');
    for (const cp of [
      0x200e, 0x200f, 0x061c, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068,
      0x2069,
    ]) {
      expect(sanitise(`Safe${String.fromCodePoint(cp)}App`)).toBe('SafeApp');
    }
  });

  it('strips other format characters, separators and lone surrogates', () => {
    expect(sanitise('Cl\u200bau\u200dde\ufeff')).toBe('Claude');
    expect(sanitise('Claude\u00adCode')).toBe('ClaudeCode');
    expect(sanitise('Claude\u2028Code\u2029')).toBe('ClaudeCode');
    expect(sanitise('Claude\ud800Code')).toBe('ClaudeCode');
    expect(sanitise('\u{e0041}Claude')).toBe('Claude');
  });

  it('strips Hangul fillers, private-use and unassigned code points', () => {
    expect(sanitise('Claude\u3164Code')).toBe('ClaudeCode');
    expect(sanitise('\u115f\u1160Claude\uffa0')).toBe('Claude');
    expect(sanitise('Claude\ue000\u{f0000}')).toBe('Claude');
    expect(sanitise('Claude\u0378')).toBe('Claude');
    for (const blank of ['\u3164', '\u115f', '\u1160', '\uffa0', '\ue000', '\u3164 \u3164']) {
      expect(sanitise(blank)).toBeNull();
    }
  });

  it('requires at least one letter or digit', () => {
    for (const name of ['---', '...', '\u2800', '🤖', '\u0301\u0301', '_ _']) {
      expect(sanitise(name)).toBeNull();
    }
    expect(sanitise('7')).toBe('7');
    expect(sanitise('Bot 🤖')).toBe('Bot 🤖');
  });

  it('allows at most two combining marks on a base', () => {
    expect(sanitise('e\u0323\u0302')).toBe('e\u0323\u0302');
    expect(sanitise('a\u0301\u0301\u0301')).toBeNull();
    expect(sanitise('Claude' + '\u0301'.repeat(40))).toBeNull();
  });

  it('keeps non-Latin letters and emoji', () => {
    expect(sanitise('Ассистент')).toBe('Ассистент');
    expect(sanitise('助手')).toBe('助手');
    expect(sanitise('Bot 🤖')).toBe('Bot 🤖');
  });

  it('refuses an empty name, or one that is empty once stripped', () => {
    for (const name of ['', '   ', '\u202e', '\u200b\u200b', '\n\t', '\u0000']) {
      expect(sanitise(name)).toBeNull();
    }
  });

  it('accepts 64 characters and refuses 65, counting code points', () => {
    expect(CLIENT_NAME_MAX).toBe(64);
    expect(sanitise('a'.repeat(64))).toBe('a'.repeat(64));
    expect(sanitise('a'.repeat(65))).toBeNull();
    expect(sanitise('a' + '🤖'.repeat(63))).toBe('a' + '🤖'.repeat(63));
    expect(sanitise('a' + '🤖'.repeat(64))).toBeNull();
  });

  it('counts the length after stripping', () => {
    expect(sanitise('a'.repeat(64) + '\u200b'.repeat(10))).toBe('a'.repeat(64));
    expect(sanitise('  ' + 'a'.repeat(64) + '  ')).toBe('a'.repeat(64));
  });

  it('refuses non-strings', () => {
    for (const value of [undefined, null, 1, {}, ['Claude']]) {
      expect(sanitise(value)).toBeNull();
    }
  });
});

describe('a client name that claims trust (§6.3.6, R-OA-25)', () => {
  it.each([
    'Verified',
    'Claude Code Verified',
    'Claude Code (verified)',
    'VERIFIED app',
    'ClaudeVerified',
    'V e r i f i e d',
    'Ver-i_fied',
    'Veri.fied',
    'Veri\u200Bfied',
    'V\u0435r\u0456f\u0456\u0435d',
    '\uFF36\uFF45\uFF52\uFF49\uFF46\uFF49\uFF45\uFF44',
    'V3r1f13d',
    'Verifled',
    've\u0301rified',
    'Claude \u2713',
    'Claude \u2714 Code',
    'Claude \u2705',
    '\u2611 Claude',
    'Assay app',
    'Assay App',
    'assay-app',
    '\u0410ssay app',
    '4ssay 4pp',
    'Claude (says it is)',
    'X \u00b7 an app on this computer',
    'An App On This Computer',
  ])('%j is refused', (name) => {
    expect(claimsTrust(name)).toBe(true);
  });

  it.each([
    'Claude Code',
    'Verifone',
    'Verifier Tools',
    'Unverifiedness Labs',
    'Assayer Labs',
    'Assay Application',
    'Assay',
    'My App',
    'Says Hello',
    'Visual Studio Code',
    'Cursor',
    'An app',
  ])('%j passes', (name) => {
    expect(claimsTrust(name)).toBe(false);
  });

  it('refuses such a name at registration and in a CIMD document, as invalid_client_metadata', () => {
    const allowlist: never[] = [];
    for (const name of ['Claude \u2713 Verified', 'Assay app', 'V\u0435rified']) {
      expect(
        validateClientMetadata(
          { client_name: name, redirect_uris: ['http://127.0.0.1/callback'] },
          allowlist,
        ),
      ).toEqual({ ok: false, error: 'invalid_client_metadata' });
    }
    expect(
      validateClientMetadata(
        { client_name: 'Visual Studio Code', redirect_uris: ['http://127.0.0.1/callback'] },
        allowlist,
      ).ok,
    ).toBe(true);
  });
});
