// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * The one directory allowed to open an outbound socket.
 * See `src/shared/network/egress/egress-http.client.ts`.
 */
const EGRESS_DIR = 'src/shared/network/egress/**';

const HTTP_CLIENT_BAN = {
  group: [
    // The libraries...
    'axios',
    'axios/*',
    'axios-retry',
    '@nestjs/axios',
    'node-fetch',
    'got',
    'undici',
    'superagent',
    'request',
    'ky',
    'needle',
    'phin',
    'http',
    'https',
    'node:http',
    'node:https',
    'follow-redirects',
    'follow-redirects/*',
    'https-proxy-agent',
    'http-proxy-agent',

    // ...and the primitives underneath them. Banning only the libraries is a
    // ban on the *convenient* ways to make a request: an adversarial review
    // wrote a working client that read instance-metadata credentials in six
    // lines of `node:net`, and it passed both locks. Every library on the list
    // above is a wrapper over something on the list below.
    'net',
    'node:net',
    'tls',
    'node:tls',
    'http2',
    'node:http2',
    'dgram',
    'node:dgram',
    // `execFileSync('curl', [url])` is an HTTP client with a shell in front.
    'child_process',
    'node:child_process',
    // Code as data: these turn a string into a socket, and a string is the one
    // thing no source scan can read.
    'vm',
    'node:vm',
    'worker_threads',
    'node:worker_threads',
    'module',
    'node:module',
    // Present in node_modules and one `import` away from being a second client
    // pointed at an arbitrary URL.
    'socket.io-client',
    'engine.io-client',
    'xmlhttprequest-ssl',
  ],
  // Type-only imports emit no runtime code and cannot open a socket. Without
  // this, `import type { Socket } from 'node:net'` is an error — and a ban that
  // fires on a type import is a ban somebody disables.
  allowTypeImports: true,
  message:
    'Outbound HTTP goes through EgressHttpClient (@shared/network/egress) and nowhere else. A direct client skips every SSRF check: post-DNS address rules, pinned connect, per-hop redirect re-checking, body-size and read-time caps.',
};

/**
 * The globals that open a socket without importing anything.
 *
 * `fetch` was the only one banned at first. `WebSocket` ships in Node 22+ and
 * `new WebSocket(url)` sends a full HTTP GET to any host:port — an adversarial
 * review used it to reach a stand-in metadata service in one line, past both
 * locks. A ban on one global is a ban on one spelling.
 */
const GLOBAL_BANS = ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest'].map((name) => ({
  name,
  message: `Outbound HTTP goes through EgressHttpClient (@shared/network/egress) and nowhere else. Global ${name} skips every SSRF check.`,
}));

/**
 * `no-restricted-imports` does not fire on `import()` — verified, not assumed.
 * An adversarial review of the original rule got `await import('node:http')`
 * past both this config and the architecture test, and it is the bypass most
 * likely to survive review because it reads like ordinary lazy loading.
 */
const INDIRECT_HTTP_BAN = [
  {
    selector: "ImportExpression[source.value=/^(node:)?https?$/]",
    message:
      'Outbound HTTP goes through EgressHttpClient (@shared/network/egress). A dynamic import of node:http skips every SSRF check.',
  },
  {
    selector:
      "ImportExpression[source.value=/^(axios|undici|got|node-fetch|superagent|ky|needle)$/]",
    message:
      'Outbound HTTP goes through EgressHttpClient (@shared/network/egress). A dynamic import of an HTTP client skips every SSRF check.',
  },
  {
    selector: "ImportExpression[source.value=/^(node:)?(net|tls|http2|dgram|child_process)$/]",
    message:
      'Outbound HTTP goes through EgressHttpClient (@shared/network/egress). These are the primitives every HTTP client wraps; a dynamic import of one skips every SSRF check.',
  },
  {
    // Written as a child selector rather than `[object.name='globalThis']`
    // because the latter stops matching the moment anyone writes
    // `(globalThis as any)['fet' + 'ch']` — which is the form you would
    // actually write in TypeScript, and which an adversarial review used to
    // walk straight past the first version of this rule.
    // `:not([property.type='Literal'])` keeps this in step with the spec, which
    // exempts a plain literal key. The two locks disagreeing about one line is
    // how an `eslint-disable` gets written.
    selector:
      "MemberExpression[computed=true]:not([property.type='Literal']) > Identifier.object[name=/^(globalThis|global)$/]",
    message:
      "globalThis['fet' + 'ch'] is how the fetch ban gets bypassed. Use EgressHttpClient (@shared/network/egress).",
  },
  {
    selector: "MemberExpression[computed=true][property.value=/^(fetch|WebSocket)$/]",
    message:
      "globalThis['fetch'] is how the fetch ban gets bypassed. Use EgressHttpClient (@shared/network/egress).",
  },
  {
    // `global` is `globalThis`. Neither lock mentioned it, and
    // `global.fetch(url)` is one line that reads like ordinary Node.
    selector: "MemberExpression[object.name='global'][property.name=/^(fetch|WebSocket)$/]",
    message:
      'global is globalThis. Outbound HTTP goes through EgressHttpClient (@shared/network/egress).',
  },
  {
    selector: "TSAsExpression > Identifier[name=/^(globalThis|global)$/]",
    message:
      'Casting globalThis is how the computed-property ban gets bypassed. Use EgressHttpClient (@shared/network/egress).',
  },
  {
    // A specifier the selector above cannot read: `import('node' + ':http')`,
    // `` import(`node:http`) ``, `import(name)`. A dynamic import whose target
    // is not legible in the source is not reviewable either.
    selector: "ImportExpression:not([source.type='Literal'])",
    message:
      "A dynamic import with a computed specifier cannot be reviewed or linted — `import('node' + ':http')` is indistinguishable from lazy loading. Use literal specifiers behind a switch (`case 'en': return import('./locales/en.json')`), and route outbound HTTP through EgressHttpClient (@shared/network/egress).",
  },
  {
    selector: "CallExpression[callee.name='createRequire']",
    message:
      'createRequire smuggles require() past the import ban. Outbound HTTP goes through EgressHttpClient (@shared/network/egress).',
  },
];

/**
 * `ws` by exact specifier, not as a group pattern.
 *
 * `no-restricted-imports` group patterns are gitignore-style, so a bare `'ws'`
 * matches any path segment called `ws` — `./ws/gateway`, `@shared/ws`,
 * `@websocket/ws/ws.gateway`. This repo has `src/websocket/` and a
 * `@websocket/*` alias, so one `ws/` directory would have broken the build on
 * an import with nothing to do with HTTP. Found before it happened; keep it
 * exact.
 */
const WS_PACKAGE_BAN = {
  name: 'ws',
  message:
    'Outbound WebSocket goes through EgressHttpClient (@shared/network/egress) or not at all.',
  allowTypeImports: true,
};

const CHAIN_SDK_BAN = {
  group: [
    '@solana/*',
    '@solana-program/*',
    '@coral-xyz/*',
    // The generated settlement-program client is a chain SDK like any other:
    // it deals in `Address`, in account layouts and in instruction bytes. It
    // belongs behind the same boundary, or "add EVM" touches every module.
    '@assay/settlement-client',
    // The blockhash reader is a Solana port and nothing outside
    // `src/modules/chains/**` may import it. It sits in this ban rather than in
    // a block of its own because this block ALREADY exempts
    // `src/modules/chains/**` and restates the egress rules it would otherwise
    // erase; a fourth `files: ['src/**/*.ts']` block would erase this one, since
    // flat config takes the LAST matching block's value for a rule rather than
    // merging. The durable half is
    // `test/unit/architecture/blockhash-stays-in-solana.spec.ts`, which also
    // covers `scripts/` — which ESLint does not lint.
    '@modules/chains/solana/blockhash.port',
    '**/chains/solana/blockhash.port',
    'viem',
    'ethers',
    'web3',
  ],
  message:
    'Chain SDKs and chain-specific ports belong in src/modules/chains/. Use a port (ChainAdapter, FacilitatorPort, DepositRequirementsBuilderPort) instead. A blockhash is not a chain-neutral concept.',
};

/**
 * The settlement program's wire format comes from `@assay/settlement-client` and
 * nowhere else.
 *
 * The generated client is rendered from the program's IDL and two CI gates keep
 * it in step with the program source. A second, hand-written encoder next to it
 * is a copy of the interface that nothing checks — and until this rule existed
 * there was one, computing `sha256("global:register_verifier")` for the
 * instruction that decides who may take a provider's stake.
 *
 * This is the fast lock. The durable one is
 * `test/unit/chains/solana/settlement-client-only.spec.ts`, which also covers
 * `scripts/` — where the hand-rolled encoder actually lived, and which ESLint
 * does not lint.
 */
const HAND_ENCODED_INSTRUCTION_BAN = [
  {
    selector: "NewExpression[callee.name='TransactionInstruction']",
    message:
      'Instructions for the settlement program come from @assay/settlement-client (getSlashInstruction, getOpenStakeInstruction, …). A hand-assembled TransactionInstruction encodes an unchecked copy of the program interface.',
  },
  {
    selector:
      "CallExpression[callee.property.name='update'] > TemplateLiteral > TemplateElement[value.raw=/^(global|account|event):/]",
    message:
      "sha256('global:<instruction>') is Anchor's discriminator, and it is already in the IDL. Use the builders in @assay/settlement-client rather than recomputing it.",
  },
];

export default tseslint.config(
  {
    ignores: [
      'eslint.config.mjs',
      'node_modules/**',
      'dist/**',
      'coverage/**',
      '*.js',
      '*.mjs',
      'scripts/**',
      'workers/**',
      '.yarn/**',
      'build/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      "prettier/prettier": ["error", { endOfLine: "auto" }],
    },
  },
  {
    // The egress boundary, mechanically enforced — the SSRF control only holds
    // if there is exactly one place in `src/` that opens an outbound socket.
    //
    // Provider registration is open, with no
    // approval, so the URLs this system fetches are, by design, typed by
    // strangers. Every check lives in `src/shared/network/egress/`: post-DNS
    // address rules, a pinned connect, per-hop redirect re-checking, body-size
    // and read-time caps. One `axios.get()` elsewhere routes around all of it
    // and reads, in review, as ordinary code.
    //
    // This block is the one that also covers `src/modules/chains/**`, which the
    // chain-SDK block below has to exempt. Re-asserted independently by
    // `test/unit/shared/network/egress/single-http-client.spec.ts`, so deleting
    // either rule turns a suite red rather than turning the rule off.
    files: ['src/**/*.ts'],
    ignores: [EGRESS_DIR],
    rules: {
      // The `@typescript-eslint` variant, because only it understands
      // `allowTypeImports`. The base rule must be off or both fire.
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-restricted-imports': ['error', { patterns: [HTTP_CLIENT_BAN], paths: [WS_PACKAGE_BAN] }],
      'no-restricted-globals': ['error', ...GLOBAL_BANS],
      'no-restricted-syntax': ['error', ...INDIRECT_HTTP_BAN, ...HAND_ENCODED_INSTRUCTION_BAN],
      // `eval`/`new Function` build a socket out of a string, and a string is
      // the one thing the source scan deliberately cannot read.
      'no-eval': 'error',
      'no-new-func': 'error',
      'no-implied-eval': 'error',
    },
  },
  {
    // The chain boundary, mechanically enforced. Documentation does not survive
    // a deadline: without this rule, the first `PublicKey` in a service is a
    // lint-clean commit, and the "add EVM" diff touches every module.
    //
    // Flat config takes the LAST matching block's value for a rule rather than
    // merging, so this block has to restate the egress ban it would otherwise
    // erase. `src/modules/chains/**` is exempt here and picks the egress ban up
    // from the block above.
    files: ['src/**/*.ts'],
    ignores: ['src/modules/chains/**', EGRESS_DIR],
    rules: {
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-restricted-imports': [
        'error',
        { patterns: [CHAIN_SDK_BAN, HTTP_CLIENT_BAN], paths: [WS_PACKAGE_BAN] },
      ],
      'no-restricted-globals': ['error', ...GLOBAL_BANS],
      'no-restricted-syntax': ['error', ...INDIRECT_HTTP_BAN, ...HAND_ENCODED_INSTRUCTION_BAN],
      // `eval`/`new Function` build a socket out of a string, and a string is
      // the one thing the source scan deliberately cannot read.
      'no-eval': 'error',
      'no-new-func': 'error',
      'no-implied-eval': 'error',
    },
  },
);
