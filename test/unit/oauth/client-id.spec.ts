import { builtinClientId, classify } from '@modules/oauth/domain/client-id';

const MCP = 'https://mcp.goassay.ai';
const STRICT = { mcpPublicUrl: MCP, allowHttpLoopback: false };
const LOOSE = { mcpPublicUrl: MCP, allowHttpLoopback: true };

const kind = (clientId: unknown, options = STRICT) => classify(clientId as string, options).kind;

describe('client identification (§6.3.6, §6.3.7)', () => {
  describe('BUILTIN', () => {
    it('{MCP}/oauth/clients/assay-mcp → BUILTIN', () => {
      expect(builtinClientId(MCP)).toBe('https://mcp.goassay.ai/oauth/clients/assay-mcp');
      expect(kind(`${MCP}/oauth/clients/assay-mcp`)).toBe('BUILTIN');
    });

    it('is resolved for an http MCP origin on the local stack, without the loopback flag', () => {
      const local = { mcpPublicUrl: 'http://localhost:3200', allowHttpLoopback: false };
      expect(kind('http://localhost:3200/oauth/clients/assay-mcp', local)).toBe('BUILTIN');
    });

    it('matches only byte for byte', () => {
      for (const id of [
        `${MCP}/oauth/clients/assay-mcp/`,
        `${MCP}/oauth/clients/assay-mcp?x=1`,
        `${MCP}/oauth/clients/assay-mcp#`,
        `${MCP}/oauth/clients/Assay-mcp`,
        `${MCP}/oauth/clients/assay-mcp%20`,
        `${MCP}/oauth/clients/./assay-mcp`,
        'https://MCP.goassay.ai/oauth/clients/assay-mcp',
        'https://mcp.goassay.ai:443/oauth/clients/assay-mcp',
        'https://other.example.com/oauth/clients/assay-mcp',
      ]) {
        expect(kind(id)).not.toBe('BUILTIN');
      }
    });

    it('never treats another URL on the MCP origin as a CIMD document', () => {
      expect(kind(`${MCP}/oauth/clients/assay-mcp/`)).toBe('UNKNOWN');
      expect(kind(`${MCP}/oauth/clients/other`)).toBe('UNKNOWN');
      expect(kind(`${MCP}/c/weather`)).toBe('UNKNOWN');
    });
  });

  describe('DCR', () => {
    it('dcr_ + 22 characters → DCR', () => {
      expect(kind('dcr_' + 'A'.repeat(22))).toBe('DCR');
      expect(kind('dcr_abcDEF012_-abcDEF0123_')).toBe('DCR');
    });

    it.each([
      ['21 characters', 'dcr_' + 'A'.repeat(21)],
      ['23 characters', 'dcr_' + 'A'.repeat(23)],
      ['a padding character', 'dcr_' + 'A'.repeat(21) + '='],
      ['a plus', 'dcr_' + 'A'.repeat(21) + '+'],
      ['an uppercase prefix', 'DCR_' + 'A'.repeat(22)],
      ['a trailing newline', 'dcr_' + 'A'.repeat(22) + '\n'],
      ['a leading space', ' dcr_' + 'A'.repeat(22)],
    ])('refuses %s', (_label, id) => {
      expect(kind(id)).toBe('UNKNOWN');
    });
  });

  describe('CIMD', () => {
    it('accepts an https URL with a DNS host and a path', () => {
      expect(kind('https://x.com/c')).toBe('CIMD');
      expect(kind('https://client.example.com/oauth/metadata.json')).toBe('CIMD');
      expect(kind('https://x.com/c?v=1')).toBe('CIMD');
      expect(kind('https://x.com/@acme/client.json')).toBe('CIMD');
      expect(kind('https://foo.github.io/client.json')).toBe('CIMD');
    });

    it('accepts an explicit :443', () => {
      expect(kind('https://x.com:443/c')).toBe('CIMD');
    });

    it('https://x.com/ (path /) → UNKNOWN', () => {
      expect(kind('https://x.com/')).toBe('UNKNOWN');
      expect(kind('https://x.com')).toBe('UNKNOWN');
    });

    it('https://1.2.3.4/c → UNKNOWN, and every other IP literal form', () => {
      for (const id of [
        'https://1.2.3.4/c',
        'https://[::1]/c',
        'https://[2001:db8::1]/c',
        'https://[::ffff:7f00:1]/c',
        'https://[::ffff:127.0.0.1]/c',
        'https://0x7f.0.0.1/c',
        'https://2130706433/c',
        'https://127.1/c',
        'https://0177.0.0.1/c',
      ]) {
        expect(kind(id)).toBe('UNKNOWN');
      }
    });

    it('https://x.com:8443/c → UNKNOWN', () => {
      expect(kind('https://x.com:8443/c')).toBe('UNKNOWN');
      expect(kind('https://x.com:80/c')).toBe('UNKNOWN');
      expect(kind('https://x.com:0443/c')).toBe('UNKNOWN');
    });

    it('https://u@x.com/c → UNKNOWN', () => {
      expect(kind('https://u@x.com/c')).toBe('UNKNOWN');
      expect(kind('https://u:p@x.com/c')).toBe('UNKNOWN');
      expect(kind('https://:p@x.com/c')).toBe('UNKNOWN');
      expect(kind('https://@x.com/c')).toBe('UNKNOWN');
    });

    it('refuses a fragment, even an empty one', () => {
      expect(kind('https://x.com/c#f')).toBe('UNKNOWN');
      expect(kind('https://x.com/c#')).toBe('UNKNOWN');
    });

    it('http://localhost/c → UNKNOWN unless loopback is allowed', () => {
      expect(kind('http://localhost/c')).toBe('UNKNOWN');
      expect(kind('http://localhost/c', LOOSE)).toBe('CIMD');
      expect(kind('http://localhost:4100/client.json', LOOSE)).toBe('CIMD');
    });

    it('allows only http://localhost under the loopback flag', () => {
      for (const id of [
        'http://x.com/c',
        'http://127.0.0.1/c',
        'http://[::1]/c',
        'http://localhost/',
        'http://localhost.x.com/c',
        'http://u@localhost/c',
        'http://localhost/c#f',
        'http://LOCALHOST/c',
      ]) {
        expect(kind(id, LOOSE)).toBe('UNKNOWN');
      }
    });

    it('a 513-character URL → UNKNOWN; 512 is accepted', () => {
      const base = 'https://x.com/';
      const at512 = base + 'a'.repeat(512 - base.length);
      expect(at512).toHaveLength(512);
      expect(kind(at512)).toBe('CIMD');
      expect(kind(at512 + 'a')).toBe('UNKNOWN');
    });

    it('refuses hosts without a public registrable domain', () => {
      for (const id of [
        'https://localhost/c',
        'https://intranet/c',
        'https://foo.internal/c',
        'https://foo.local/c',
        'https://foo.localhost/c',
        'https://github.io/c',
        'https://co.uk/c',
      ]) {
        expect(kind(id)).toBe('UNKNOWN');
      }
    });

    it('refuses non-canonical spellings that a fetch would rewrite', () => {
      for (const id of [
        'HTTPS://x.com/c',
        'https://X.com/c',
        'https://x.com./c',
        'https://x.com/a/../c',
        'https://x.com/./c',
        'https://x.com/%2e%2e/c',
        'https://x.com\\c',
        'https://x.com/c d',
        ' https://x.com/c',
        'https://x.com/c ',
        'https://x.com/c\n',
        'https://x.com/c\t',
        'https://bücher.de/c',
        'https:x.com/c',
        'https:/x.com/c',
        'https:///x.com/c',
      ]) {
        expect(kind(id)).toBe('UNKNOWN');
      }
    });

    it("refuses Assay's own registrable domain (we never fetch ourselves)", () => {
      for (const id of [
        'https://api.goassay.ai/c',
        'https://goassay.ai/c',
        'https://app.goassay.ai/client.json',
        'https://x.mcp.goassay.ai/c',
      ]) {
        expect(kind(id)).toBe('UNKNOWN');
      }
      expect(kind('https://assay.example.com/c')).toBe('CIMD');
      expect(kind('https://notgoassay.ai/c')).toBe('CIMD');
    });

    it('refuses invalid percent-escapes and %00', () => {
      for (const id of [
        'https://x.com/c%00',
        'https://x.com/c%00x',
        'https://x.com/c%zz',
        'https://x.com/c%',
        'https://x.com/c%4',
        'https://x.com/c?q=%G1',
      ]) {
        expect(kind(id)).toBe('UNKNOWN');
      }
      expect(kind('https://x.com/c%20d')).toBe('CIMD');
      expect(kind('https://x.com/c%2Fd')).toBe('CIMD');
    });

    it('checks text only: a DNS name resolving to loopback is still CIMD (the fetch must refuse it)', () => {
      expect(kind('https://127.0.0.1.nip.io/c')).toBe('CIMD');
    });

    it('accepts a punycode host', () => {
      expect(kind('https://xn--bcher-kva.de/c')).toBe('CIMD');
    });
  });

  describe('UNKNOWN', () => {
    it.each([
      ['an empty string', ''],
      ['a bare word', 'my-client'],
      ['a uuid', '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'],
      ['ftp', 'ftp://x.com/c'],
      ['javascript', 'javascript:alert(1)'],
      ['a private-use scheme', 'cursor://x.com/c'],
    ])('%s → UNKNOWN', (_label, id) => {
      expect(kind(id)).toBe('UNKNOWN');
    });

    it('refuses non-strings without throwing', () => {
      for (const value of [undefined, null, 1, {}, ['https://x.com/c']]) {
        expect(kind(value)).toBe('UNKNOWN');
      }
    });

    it('gives UNKNOWN instead of throwing when options are missing or malformed', () => {
      for (const options of [undefined, null, {}, { mcpPublicUrl: 42 }]) {
        expect(classify('https://x.com/c', options as never).kind).toBe('UNKNOWN');
        expect(classify('dcr_' + 'A'.repeat(22), options as never).kind).toBe('UNKNOWN');
      }
    });
  });
});
