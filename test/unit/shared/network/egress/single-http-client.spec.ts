/**
 * There is exactly one HTTP client, and this test is the second lock on it.
 *
 * `eslint.config.mjs` already bans `axios`, `node:http`, global `fetch` and the
 * rest everywhere under `src/` except `src/shared/network/egress/`. That rule is
 * the fast feedback; this file is the one that survives the rule being deleted,
 * disabled for a directory, or silenced with an inline comment — all three of
 * which are a one-line diff that reads, in review, like housekeeping.
 *
 * The threat this protects is not sophisticated. Six months from now someone
 * needs to call a webhook, reaches for the library they know, and ships a code
 * path with no address check, no redirect re-check, no size cap and no
 * deadline. Provider registration is open with no approval, so the URL that
 * path fetches is one a stranger typed.
 *
 * If you are here because this test failed: the fix is to inject
 * `EgressHttpClient` from `@shared/network/egress`. It is provided by
 * `NetworkModule`, which is `@Global`. If the client genuinely cannot express
 * what you need, extend the client — the point is that the next reviewer only
 * has one file to read.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SRC = join(__dirname, '..', '..', '..', '..', '..', 'src');

/** The one directory allowed to open a socket. Must match `eslint.config.mjs`. */
const EGRESS_DIR = join('shared', 'network', 'egress');

/**
 * Every way to get an outbound socket that does not go through the egress
 * client. Kept as source patterns rather than a dependency graph walk because
 * the failure mode is a human writing one of these lines, and this is the form
 * that names the offending line back to them.
 */
interface ForbiddenPattern {
  readonly pattern: RegExp;
  readonly what: string;
  /**
   * A same-line escape hatch for the one shape the pattern cannot tell apart
   * from the thing it is hunting.
   *
   * Used sparingly and only where the alternative is a false positive, because
   * a rule that fires on ordinary code gets suppressed — and a suppressed rule
   * protects nothing. See the false-positive test below for the list this is
   * measured against.
   */
  readonly unless?: RegExp;
}

const FORBIDDEN: ReadonlyArray<ForbiddenPattern> = [
  {
    pattern: /\bfrom\s+['"]axios(?:\/[^'"]*)?['"]/,
    what: "import from 'axios'",
    unless: /\bimport\s+type\b/,
  },
  { pattern: /\bfrom\s+['"]@nestjs\/axios['"]/, what: "import from '@nestjs/axios'" },
  { pattern: /\brequire\(\s*['"]axios(?:\/[^'"]*)?['"]\s*\)/, what: "require('axios')" },
  { pattern: /\bfrom\s+['"]axios-retry['"]/, what: "import from 'axios-retry'" },
  { pattern: /\bfrom\s+['"]node-fetch['"]/, what: "import from 'node-fetch'" },
  { pattern: /\bfrom\s+['"]undici['"]/, what: "import from 'undici'" },
  { pattern: /\bfrom\s+['"]got['"]/, what: "import from 'got'" },
  { pattern: /\bfrom\s+['"]superagent['"]/, what: "import from 'superagent'" },
  { pattern: /\bfrom\s+['"]ky['"]/, what: "import from 'ky'" },
  { pattern: /\bfrom\s+['"]needle['"]/, what: "import from 'needle'" },
  {
    pattern: /\bfrom\s+['"]follow-redirects(?:\/[^'"]*)?['"]/,
    what: "import from 'follow-redirects'",
  },
  {
    pattern: /\bfrom\s+['"](?:node:)?https?['"]/,
    what: "import from 'node:http' / 'node:https'",
    unless: /\bimport\s+type\b/,
  },
  { pattern: /\brequire\(\s*['"](?:node:)?https?['"]\s*\)/, what: "require('node:http')" },
  { pattern: /\bfrom\s+['"]https?-proxy-agent['"]/, what: 'a proxy agent import' },

  // The primitives every HTTP library wraps. An adversarial review read
  // instance-metadata credentials in six lines of `node:net` and passed both
  // locks, because the ban enumerated libraries and `node:net` is not one.
  {
    pattern:
      /\bfrom\s+['"](?:node:)?(?:net|tls|http2|dgram|child_process|vm|worker_threads|module)['"]/,
    what: "import from 'node:net' / 'node:tls' / 'node:vm' / 'node:child_process' and friends",
    // `import type { Socket } from 'node:net'` emits no runtime code and cannot
    // open a socket. The repo already writes type-only imports of `socket.io`,
    // so a ban that fires on the idiom is a ban somebody turns off.
    unless: /\bimport\s+type\b/,
  },
  {
    pattern:
      /\brequire\(\s*['"](?:node:)?(?:net|tls|http2|dgram|child_process|vm|worker_threads|module)['"]\s*\)/,
    what: "require('node:net') and friends",
  },
  {
    pattern:
      /\bimport\(\s*['"](?:node:)?(?:net|tls|http2|dgram|child_process|vm|worker_threads|module)['"]\s*\)/,
    what: "dynamic import('node:net') and friends",
  },
  {
    pattern: /\bfrom\s+['"](?:socket\.io-client|engine\.io-client|ws|xmlhttprequest-ssl)['"]/,
    // Anchored by the quotes, so unlike the lint group pattern this never
    // matched `./ws/gateway` — but keep them in step.
    what: 'an HTTP/WebSocket client dependency',
    unless: /\bimport\s+type\b/,
  },
  // Code as data. `stripCommentsAndStrings` erases the payload by design — that
  // is what keeps this scan free of false positives — so these match the
  // *evaluator*, which is the only part left visible.
  { pattern: /\bnew\s+Function\s*\(/, what: 'new Function (a socket built from a string)' },
  { pattern: /(?<![.\w$])eval\s*\(/, what: 'eval' },
  { pattern: /\bvm\s*\.\s*runIn\w+/, what: 'vm.runInThisContext and friends' },
  { pattern: /\bnew\s+WebSocket\b/, what: 'new WebSocket (a socket to any host:port)' },
  { pattern: /\bnew\s+EventSource\b/, what: 'new EventSource' },

  {
    pattern: /(?<![.\w$])fetch\s*\(/,
    what: 'a call to global fetch()',
    // `async fetch(id: string) {` and `fetch(url: string): Promise<T> {` are
    // method *definitions*, not calls. Telling them apart needs the trailing
    // brace, which is why this one carries an exception rather than a cleverer
    // lookbehind.
    // A method *definition* ends in `{`; a method *declaration* — the shape in
    // an interface, an abstract class or a TS overload — ends in `;` after a
    // return type. Both are exempt. The `;` case demands the `: Type` so that a
    // plain `await fetch(url);` is still caught.
    unless: /(?:^|[\s;{(])(?:abstract\s+)?(?:async\s+)?fetch\s*\([^)]*\)\s*(?:\{|:[^{;]*[;{])/,
  },
  {
    pattern: /\b(?:globalThis|global)\s*\.\s*(?:fetch|WebSocket)\b/,
    what: 'globalThis.fetch / global.fetch',
  },
  { pattern: /\bnew\s+XMLHttpRequest\b/, what: 'XMLHttpRequest' },

  // The indirect forms. Every one of these was demonstrated to pass both this
  // spec and `yarn lint` in an adversarial review of the original rule, and
  // `await import('node:http')` is the dangerous one precisely because it reads
  // like ordinary lazy loading.
  {
    pattern: /\bimport\(\s*['"](?:node:)?https?['"]\s*\)/,
    what: "dynamic import('node:http')",
  },
  {
    pattern: /\bimport\(\s*['"](?:axios|undici|got|node-fetch|superagent|ky|needle)['"]\s*\)/,
    what: 'dynamic import of an HTTP client',
  },
  // Capturing `fetch` under another name.
  //
  // The first version of this matched a bare `fetch` followed by punctuation,
  // and an adversarial review showed it firing on `interface Transport { fetch:
  // ... }`, `{ fetch: undefined }`, `function make(fetch: unknown)` and
  // `export { fetch } from './my-transport'` — none of which touch the global,
  // and the first of which is exactly the shape you write when building the
  // `EgressHttpClient`-backed transport this file's own comment recommends.
  // Closing the gap must not fire on closing the gap.
  //
  // So these match the *assignment*, which is the only part that can actually
  // capture the global.
  //
  // `global` is `globalThis` in Node, and every pattern here needs the twin:
  // `global.fetch(url)` was one line that passed both locks and reads like
  // ordinary Node.
  //
  // Note what is deliberately NOT here: a bare `const send = fetch;`. Matching
  // it needs scope, and without scope it fires on `function make(fetch:
  // Transport) { const send = fetch; }` — a local parameter, no global in
  // sight, and the exact signature of the `EgressHttpClient`-backed transport
  // this file recommends writing. ESLint's `no-restricted-globals` resolves
  // scope properly and catches the real form, so that one is left to the lock
  // that can actually decide it. A rule that fires on its own recommended fix
  // does not survive to catch anything.
  { pattern: /\}\s*=\s*(?:globalThis|global)\b/, what: 'destructuring from globalThis' },
  {
    // `= globalThis;`, `= (globalThis);`, `= globalThis as any;`,
    // `= globalThis satisfies object;`, `= globalThis!;`
    pattern:
      /=\s*\(?\s*(?:globalThis|global)\b\s*\)?\s*(?:as\s+[^;,)]+|satisfies\s+[^;,)]+|!)?\s*(?:[;,)]|$)/m,
    what: 'globalThis aliased to a variable',
  },
  {
    pattern: /\b(?:globalThis|global)\b[^;\n]{0,40}?\[\s*['"](?:fetch|WebSocket)['"]\s*\]/,
    what: "globalThis['fetch']",
  },
  {
    // A *computed* key on globalThis, cast or not — `(globalThis as any)['fet'
    // + 'ch']` is the form that walked past the second version. A plain string
    // literal key (`globalThis['crypto']`) is exempt here AND in the lint
    // selector: the two locks disagreeing about one line is how an
    // `eslint-disable` gets written.
    pattern: /\b(?:globalThis|global)\b[^;\n]{0,40}?\[\s*(?!['"][A-Za-z_$][\w$]*['"]\s*\])/,
    what: 'a computed property on globalThis (fetch by string concatenation)',
  },
  {
    pattern: /\bReflect\s*\.\s*get\s*\(\s*(?:globalThis|global)\b/,
    what: 'Reflect.get(globalThis, ...)',
  },
  {
    pattern: /\bgetOwnPropertyDescriptor\s*\(\s*(?:globalThis|global)\b/,
    what: 'Object.getOwnPropertyDescriptor(globalThis, ...)',
  },
  { pattern: /\bcreateRequire\b/, what: 'createRequire (require() smuggled past the import ban)' },
  {
    // `[^;\n]{0,40}?` for the same reason the globalThis patterns carry it:
    // `(process as any).binding('tcp_wrap')` is the form you write in
    // TypeScript, and the un-tolerant version walked straight past it.
    pattern: /\bprocess\b[^;\n]{0,40}?\.\s*binding\s*\(/,
    what: 'process.binding',
  },
];

/**
 * Third-party modules that make their own HTTP requests, and the files allowed
 * to construct them.
 *
 * `@solana/kit`'s default transport calls global `fetch` internally, so an RPC
 * client is a second HTTP client that no source-text ban can see — the
 * adversarial review proved it dialling `127.0.0.1` with none of this
 * directory's checks applied. It is tolerable **only** because the URL it dials
 * is `SOLANA_RPC_URL` from the environment, never a provider's. This list is
 * what stops that exception from spreading: a new file constructing an RPC
 * client turns this test red, and the reviewer has to decide whether that URL
 * is operator config or somebody else's.
 *
 * The durable fix is to hand `createSolanaRpc` a transport built on
 * `EgressHttpClient` (`@solana/kit` supports one) — recorded as open work.
 */
const HTTP_CAPABLE_SDK = /\bcreateSolanaRpc(?:FromTransport|Subscriptions)?\s*\(/;

const HTTP_CAPABLE_SDK_CALLERS: readonly string[] = [
  // Exactly one, and that is the point. Both modules used to call
  // `createSolanaRpc` directly; they now go through
  // `createSanctionedSolanaRpc`, which is the single place a second HTTP
  // client is constructed and the single place its requests are declared to
  // the runtime guard. If this list grows back to two, someone has built a
  // second unguarded transport.
  join('modules', 'chains', 'solana', 'sanctioned-rpc.ts'),
];

function typescriptFilesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...typescriptFilesUnder(full));
    } else if (entry.endsWith('.ts')) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Strip comments and string literals before scanning.
 *
 * Without this, a doc comment that says "do not use `axios`" fails the test it
 * is explaining — and the way that gets resolved is by deleting the
 * explanation, which is the opposite of what this file wants.
 */
function stripCommentsAndStrings(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1 ')
    .replace(/`(?:\\[\s\S]|[^\\`])*`/g, '``')
    .replace(/'(?:\\[\s\S]|[^\\'])*'/g, (match) =>
      // Import specifiers are single-quoted and must stay visible; anything
      // else collapses so an error message mentioning axios is not a failure.
      /^'[\w@./:-]+'$/.test(match) ? match : "''",
    );
}

describe('exactly one outbound HTTP client', () => {
  const files = typescriptFilesUnder(SRC);

  it('finds a source tree to scan at all', () => {
    // A path typo would make every assertion below vacuously pass.
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((file) => file.includes(EGRESS_DIR))).toBe(true);
  });

  it('has no direct HTTP client anywhere in src/ outside the egress directory', () => {
    const violations: string[] = [];

    for (const file of files) {
      const rel = relative(SRC, file);
      if (rel.startsWith(EGRESS_DIR + sep)) continue;

      const source = stripCommentsAndStrings(readFileSync(file, 'utf8'));

      for (const { pattern, what, unless } of FORBIDDEN) {
        const line = source
          .split('\n')
          .findIndex((text) => pattern.test(text) && !unless?.test(text));
        if (line !== -1) {
          violations.push(`${rel}:${line + 1} — ${what}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('constructs an HTTP-capable chain SDK only where the URL is operator config', () => {
    const callers = files
      .map((file) => relative(SRC, file))
      .filter((rel) => !rel.startsWith(EGRESS_DIR + sep))
      .filter((rel) =>
        HTTP_CAPABLE_SDK.test(stripCommentsAndStrings(readFileSync(join(SRC, rel), 'utf8'))),
      );

    // Not `toContain` in both directions by accident: an entry that disappears
    // should also fail, so the list cannot rot into a permanent exemption for
    // files that no longer exist.
    expect(callers.sort()).toEqual([...HTTP_CAPABLE_SDK_CALLERS].sort());
  });

  it('catches the indirect forms an adversarial review got past the first version', () => {
    // Each of these compiled, passed `yarn lint`, and passed the first version
    // of the scan above. They are kept as literal source lines so that a future
    // refactor of `FORBIDDEN` cannot quietly stop catching them — which is how
    // a rule like this decays.
    const bypasses: ReadonlyArray<[string, string]> = [
      ['dynamic import of node:http', "const { request } = await import('node:http');"],
      ['dynamic import of https', "const h = await import('node:https');"],
      ['dynamic import of axios', "const { default: ax } = await import('axios');"],
      ['destructured global fetch', 'const { fetch: send } = globalThis;'],
      ['computed globalThis', "const f = globalThis['fet' + 'ch'];"],
      ['createRequire', 'const req = createRequire(__filename);'],
      ['process.binding', "const tcp = process.binding('tcp_wrap');"],
      ['cast process.binding', "const tcp = (process as any).binding('tcp_wrap');"],
      ['plain axios import (control)', "import axios from 'axios';"],
      ['plain fetch call (control)', 'await fetch(url);'],

      // Round two. A raw `node:net` client read instance-metadata credentials
      // in six lines and passed both locks — the ban had enumerated libraries,
      // and every library is a wrapper over one of these.
      ['node:net import', "import { connect } from 'node:net';"],
      ['bare net import', "import { Socket } from 'net';"],
      ['node:tls import', "import { connect } from 'node:tls';"],
      ['node:http2 import', "import { connect } from 'node:http2';"],
      ['child_process (curl)', "import { execFileSync } from 'node:child_process';"],
      ['dynamic import of node:net', "const net = await import('node:net');"],
      ['require of node:net', "const net = require('node:net');"],
      ['@nestjs/axios', "import { HttpModule } from '@nestjs/axios';"],

      // The computed-globalThis ban defeated by the cast you would actually
      // write in TypeScript.
      ['cast globalThis', "const f = (globalThis as any)['fet' + 'ch'];"],
      ['globalThis via a variable', 'const g = globalThis;'],
      ['globalThis literal fetch key', "const f = globalThis['fetch'];"],
    ];

    const missed = bypasses
      .filter(
        ([, line]) =>
          !FORBIDDEN.some(({ pattern, unless }) => pattern.test(line) && !unless?.test(line)),
      )
      .map(([what]) => what);

    expect(missed).toEqual([]);
  });

  it('leaves exactly one form to the lint lock, because scope decides it', () => {
    // `const send = fetch;` is a real bypass and this scan deliberately does
    // not match it. Matching a bare `= fetch` needs scope: without it the rule
    // fires on `function make(fetch: Transport) { const send = fetch; }`, where
    // `fetch` is a parameter and no global is involved — and that signature is
    // the `EgressHttpClient`-backed transport this file recommends writing.
    //
    // ESLint's `no-restricted-globals` resolves scope properly and catches the
    // real form while ignoring the shadowed one, so the decision lives there.
    // Asserted rather than left implicit: the gap is a choice, and the next
    // person to read this table should find that written down instead of
    // guessing it was an oversight.
    const aliased = 'const send = fetch;';

    expect(
      FORBIDDEN.some(({ pattern, unless }) => pattern.test(aliased) && !unless?.test(aliased)),
    ).toBe(false);

    const config = readFileSync(join(SRC, '..', 'eslint.config.mjs'), 'utf8');
    expect(config).toContain('GLOBAL_BANS');
    expect(config).toContain('no-restricted-globals');
  });

  it('does not fire on ordinary code that merely looks similar', () => {
    // The other half of the contract. A ban that flags `await fetchUser()` or a
    // property called `fetch` gets suppressed within a week, and a suppressed
    // ban is no ban.
    const innocent = [
      'const user = await fetchUserById(id);',
      'const rows = await repository.fetch(query);',
      'this.prefetchNextPage();',
      "import { Injectable } from '@nestjs/common';",
      "import { readFileSync } from 'node:fs';",
      'const { httpStatus } = response;',
      "await import('./lazy-module');",

      // Round two found every one of these firing. The first is the sharp
      // edge: `interface Transport { fetch: ... }` is precisely the shape of
      // the `EgressHttpClient`-backed transport that closes the `@solana/kit`
      // gap — a rule that blocks the fix for the hole it guards gets deleted,
      // and then the hole is unguarded.
      '  fetch: (url: string) => Promise<string>;',
      'export const cfg = { fetch: undefined, retries: 3 };',
      'export function make(fetch: unknown) {',
      "export { fetch } from './my-transport';",
      "export const rnd = globalThis['crypto'];",
      '  async fetch(id: string): Promise<Row> {',
      '  fetch(id: string) {',
      'const netTotal = gross - fees;',
      "import { Networks } from './networks';",

      // Round three. Families 1, 2 and 4: method *declarations* named `fetch`,
      // aliasing a local `fetch`, and type-only imports of the newly banned
      // primitives. Family 1 is the sharp edge again — an interface declaring
      // `fetch(url: string): Promise<Response>` is the transport that closes
      // the `@solana/kit` gap, and a rule that blocks its own fix gets deleted.
      'export interface Transport { fetch(url: string): Promise<Response>; }',
      'export abstract class Port { abstract fetch(id: string): Promise<Row>; }',
      'export type Client = { fetch(u: string): Promise<string> };',
      '  fetch(id: string): Promise<Row>;',
      'export function makeClient(fetch: Transport) { const send = fetch; }',
      'export function make(fetch: Transport, send = fetch) {',
      "import type { Socket } from 'node:net';",
      "import type { IncomingHttpHeaders } from 'node:http';",
      "import type { ChildProcess } from 'node:child_process';",
      "import type { AxiosInstance } from 'axios';",
      // Family 3: this line is blessed here, so the lint selector must bless it
      // too — `keeps the lint rule` asserts the selector carries the matching
      // `:not([property.type='Literal'])`.
      "export const rnd = globalThis['crypto'];",
      'const globalTimeout = config.timeout;',
      "import { WsGateway } from './ws/gateway';",
      "import { WsAdapter } from '@websocket/ws/ws.adapter';",
      'const processed = process.env.NODE_ENV;',
      'export const globalState = { ready: false };',
    ];

    const falsePositives = innocent.filter((line) =>
      FORBIDDEN.some(({ pattern, unless }) => pattern.test(line) && !unless?.test(line)),
    );

    expect(falsePositives).toEqual([]);
  });

  it('keeps the lint rule that says the same thing', () => {
    // The two locks are independent on purpose, so this asserts the other one
    // still exists rather than trusting that it does.
    const config = readFileSync(join(SRC, '..', 'eslint.config.mjs'), 'utf8');

    expect(config).toContain('HTTP_CLIENT_BAN');
    expect(config).toContain('GLOBAL_BANS');
    expect(config).toContain("'axios'");
    expect(config).toContain("'node:http'");
    expect(config).toContain('src/shared/network/egress/**');
    expect(config).toContain('no-restricted-globals');
    // The indirect-form bans, added after an adversarial review got
    // `await import('node:http')` past both locks.
    expect(config).toContain('INDIRECT_HTTP_BAN');
    expect(config).toContain('ImportExpression');
    expect(config).toContain('createRequire');
    // Round two: the primitives, and the cast that defeated the first
    // computed-globalThis selector.
    expect(config).toContain("'node:net'");
    expect(config).toContain("'node:child_process'");
    expect(config).toContain('TSAsExpression');
    // Round three: the `global` alias, WebSocket as a banned global, code-as-data,
    // and the type-import exemption that keeps the ban from firing on `import type`.
    expect(config).toContain("'WebSocket'");
    expect(config).toContain('allowTypeImports');
    expect(config).toContain("'node:vm'");
    expect(config).toContain("'no-new-func'");
    expect(config).toMatch(/globalThis\|global/);
  });
});
