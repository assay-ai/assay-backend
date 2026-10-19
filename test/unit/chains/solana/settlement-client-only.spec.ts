/**
 * The settlement program's wire format is produced in exactly one place, and
 * that place is generated.
 *
 * `@assay/settlement-client` is Codama output rendered from the program's IDL,
 * which is itself rendered from the program source, and two CI gates keep the
 * chain honest end to end (`scripts/check-idl-sync.sh` in assay-solana, and
 * `yarn client:check`). None of that is worth anything if a second encoder can
 * be written next to it — which is not hypothetical: until this commit,
 * `scripts/verifier-key/registry.ts` computed `sha256("global:register_verifier")`
 * by hand and `verifier-registry.service.ts` read `VerifierKey` with a
 * `DataView` and a table of offsets in a comment. Both were correct. Neither was
 * checked by anything.
 *
 * `eslint.config.mjs` bans the loudest form under `src/`. This file is the lock
 * that survives the rule being deleted, disabled for a directory, or silenced
 * inline — and, unlike the lint rule, it also covers `scripts/`, which is where
 * the hand-rolled encoder actually lived.
 *
 * ## What it checks
 *
 * Not "no file may contain a `DataView`" — that would fire across the whole
 * repo and be turned off within a month. It first works out which files touch
 * the settlement program at all, and applies the ban only to those. A file that
 * has no business with the program is not this test's concern.
 *
 * ## If this test failed
 *
 * You almost certainly want a function that already exists:
 *
 *   - encoding an instruction     `get<Name>Instruction[Async](…)`
 *   - decoding an account         `fetch<Name>` / `get<Name>Decoder()`
 *   - deriving a PDA              `find<Name>Pda(…)`
 *   - naming a custom error       `getAssayPaymentErrorMessage(code)`
 *
 * If the program genuinely has no such function, the program's IDL is the thing
 * to change — not this scan.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const BACKEND = join(__dirname, '..', '..', '..', '..');

/**
 * Everything that could hold a second encoder.
 *
 * `packages/settlement-client/src` is in the list on purpose: moving the
 * hand-written parts of the client into the package would otherwise move them
 * out of this scan, which is the quietest possible way to defeat it.
 */
const ROOTS = ['src', 'scripts', join('packages', 'settlement-client', 'src')] as const;

/** The generated client, by the specifier every consumer imports it under. */
const CLIENT_PACKAGE = '@assay/settlement-client';

/**
 * How a file is recognised as touching the settlement program.
 *
 * Deliberately generous: importing the client counts, and so does naming the
 * program id env var or one of the program's own account types. A hand-rolled
 * encoder that imported nothing would still have to name *something* the
 * program owns in order to target it.
 */
const TOUCHES_SETTLEMENT_PROGRAM = [
  new RegExp(String.raw`from\s+'${CLIENT_PACKAGE.replace('/', '\\/')}'`),
  /SOLANA_SETTLEMENT_PROGRAM_ID/,
  /SETTLEMENT_PROGRAM_ID/,
  /\bVerifierKey\b/,
  /\bProviderStake\b/,
  /\bSlashRecord\b/,
  /\bEconomicsConfig\b/,
];

interface ForbiddenPattern {
  readonly pattern: RegExp;
  readonly what: string;
  readonly unless?: RegExp;
}

/**
 * Byte-level work on a settlement-program payload. Each of these existed in the
 * code this test replaces.
 */
const FORBIDDEN: readonly ForbiddenPattern[] = [
  {
    // `sha256("global:<instruction>")[..8]` — Anchor's instruction discriminator,
    // recomputed instead of taken from the IDL.
    pattern: /\bcreateHash\s*\(/,
    what: 'a hand-computed Anchor discriminator (createHash)',
  },
  {
    // An eight-element byte array literal is a discriminator typed out. Longer
    // arrays are something else (a key prefix, a seed) and are not matched.
    pattern: /\[\s*(?:\d{1,3}\s*,\s*){7}\d{1,3}\s*\]/,
    what: 'an 8-byte discriminator written out as a literal',
  },
  {
    pattern: /\bnew\s+DataView\s*\(/,
    what: 'a DataView over program account data (hand-decoded Borsh)',
  },
  {
    pattern: /\b(?:get|set)Big(?:U?Int)64\s*\(/,
    what: 'a hand-read i64/u64 field',
  },
  {
    pattern: /\b(?:read|write)Big(?:U?Int)64LE\s*\(/,
    what: 'a hand-written i64/u64 field',
  },
  {
    pattern: /\bnew\s+TransactionInstruction\s*\(/,
    what: 'a hand-assembled TransactionInstruction',
  },
  {
    pattern: /\bBuffer\s*\.\s*concat\s*\(/,
    what: 'instruction data assembled by concatenation',
    // Wrapping a key in its ASN.1 prefix is not instruction encoding, and
    // `scripts/verifier-key/rotation-drill.ts` does exactly that to turn a raw
    // ed25519 seed into a PKCS#8 `KeyObject`. Exempted by what the line is
    // building rather than by which file it is in: an exemption keyed on a path
    // covers everything that file ever does next.
    unless: /pkcs8|spki|_PREFIX\b/i,
  },
];

/**
 * The generated tree, exempt wholesale — and guarded by something stronger.
 *
 * It is full of 8-byte discriminator literals, because that is what a generated
 * client *is*. Scanning it would report every one of them. It does not need this
 * scan: `yarn client:check` re-renders it from the IDL and fails on any
 * difference in either direction, which is a tighter guarantee than "contains no
 * suspicious patterns".
 */
const GENERATED_TREE = join('packages', 'settlement-client', 'src', 'generated');

/**
 * The files allowed to write program bytes by hand, and the reason.
 *
 * Both encode a message somebody signs. A signed message is neither an
 * instruction nor an account, so it is nowhere in the IDL and there is nothing
 * to generate from. Both are exempt from the Borsh-primitive rules **only** —
 * neither may build an instruction or compute a discriminator — and both are
 * covered by their own spec plus the program itself, which recomputes the
 * message and refuses a signature over anything else.
 *
 * Keyed on the files rather than the directory: an exemption on
 * `packages/settlement-client/src` would cover every file added there later.
 */
const SIGNED_MESSAGE_ENCODERS: readonly string[] = [
  join('packages', 'settlement-client', 'src', 'attestation-message.ts'),
  join('packages', 'settlement-client', 'src', 'voucher-message.ts'),
];

/** The rules the two signed-message encoders are exempt from. Not the instruction ones. */
const BORSH_PRIMITIVE_RULES = [
  'a DataView over program account data (hand-decoded Borsh)',
  'a hand-read i64/u64 field',
  'a hand-written i64/u64 field',
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
 * Strip comments and non-specifier string literals.
 *
 * Without this, the doc comment on `registry.ts` explaining that it *used to*
 * compute `sha256("global:register_verifier")` would fail the test that exists
 * to explain — and that gets resolved by deleting the explanation.
 */
function stripCommentsAndStrings(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1 ')
    .replace(/`(?:\\[\s\S]|[^\\`])*`/g, '``')
    .replace(/'(?:\\[\s\S]|[^\\'])*'/g, (match) => (/^'[\w@./:-]+'$/.test(match) ? match : "''"));
}

describe('the settlement program is only ever spoken to through the generated client', () => {
  const files = ROOTS.flatMap((root) =>
    typescriptFilesUnder(join(BACKEND, root)).map((file) => relative(BACKEND, file)),
  );

  const sources = new Map(
    files.map((file) => [file, stripCommentsAndStrings(readFileSync(join(BACKEND, file), 'utf8'))]),
  );

  // Everything in the client package's own source is in scope by definition —
  // it is the program's interface, so it cannot fail a content test for
  // "mentions the program". Everywhere else has to say so.
  const CLIENT_SOURCE = join('packages', 'settlement-client', 'src');
  const settlementFiles = files
    .filter((file) => !file.startsWith(GENERATED_TREE + sep))
    .filter(
      (file) =>
        file.startsWith(CLIENT_SOURCE + sep) ||
        TOUCHES_SETTLEMENT_PROGRAM.some((pattern) => pattern.test(sources.get(file)!)),
    );

  it('finds the files that touch the program at all', () => {
    // A path typo, or a rename of the client package, would make every
    // assertion below vacuously pass.
    expect(files.length).toBeGreaterThan(100);
    expect(settlementFiles.length).toBeGreaterThan(2);
    expect(settlementFiles).toContain(join('scripts', 'verifier-key', 'registry.ts'));
    expect(settlementFiles).toContain(
      join('src', 'modules', 'chains', 'solana', 'verifier-registry.service.ts'),
    );
    // The package's hand-written files are in scope; its generated tree is not.
    for (const encoder of SIGNED_MESSAGE_ENCODERS) {
      expect(settlementFiles).toContain(encoder);
    }
    expect(settlementFiles.some((file) => file.startsWith(GENERATED_TREE + sep))).toBe(false);
  });

  it('encodes and decodes nothing by hand', () => {
    const violations: string[] = [];

    for (const file of settlementFiles) {
      const lines = sources.get(file)!.split('\n');
      for (const { pattern, what, unless } of FORBIDDEN) {
        if (SIGNED_MESSAGE_ENCODERS.includes(file) && BORSH_PRIMITIVE_RULES.includes(what)) {
          continue;
        }
        const line = lines.findIndex((text) => pattern.test(text) && !unless?.test(text));
        if (line !== -1) {
          violations.push(`${file}:${line + 1} — ${what}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('reaches the program through the client wherever it builds an instruction', () => {
    // Reading an account can be done with an RPC call and a decoder; *writing*
    // one cannot happen without an instruction, and every instruction the
    // backend can send has a builder in the generated client. So any file that
    // sends a transaction to this program must import the client.
    const senders = settlementFiles.filter((file) => /\bsend\s*\(\s*\[/.test(sources.get(file)!));

    expect(senders.length).toBeGreaterThan(0);
    for (const file of senders) {
      expect(sources.get(file)).toContain(CLIENT_PACKAGE);
    }
  });

  it('catches the exact code this commit replaced', () => {
    // The two encoders that lived in this repo, kept as literal source so a
    // future rewrite of FORBIDDEN cannot quietly stop catching them.
    const historical = [
      "const data = Buffer.concat([discriminator('register_verifier'), i64(expiresAt)]);",
      "return createHash('sha256').update(`global:${instruction}`).digest().subarray(0, 8);",
      'const view = new DataView(data.buffer, data.byteOffset, data.byteLength);',
      'const revokedAtRaw = view.getBigInt64(offset, true);',
      'const VERIFIER_KEY_DISCRIMINATOR = Buffer.from([27, 40, 233, 33, 249, 246, 9, 239]);',
      'const transaction = new Transaction().add(new TransactionInstruction(instruction));',
    ];

    for (const line of historical) {
      const stripped = stripCommentsAndStrings(line);
      const caught = FORBIDDEN.some(
        ({ pattern, unless }) => pattern.test(stripped) && !unless?.test(stripped),
      );
      expect({ line, caught }).toEqual({ line, caught: true });
    }
  });

  it('does not fire on ordinary code that has nothing to do with encoding', () => {
    const innocent = [
      "import { findVerifierKeyPda } from '@assay/settlement-client';",
      'const [pda] = await findVerifierKeyPda({ verifier }, { programAddress });',
      'const account = await fetchMaybeVerifierKey(rpc, pda);',
      'const bytes = new Uint8Array(getBase64Encoder().encode(account.value.data[0]));',
      "const label = Buffer.from(view.subarray(0, end)).toString('utf8');",
      'return new Date(Number(decoded.registeredAt) * 1000);',
    ];

    for (const line of innocent) {
      const stripped = stripCommentsAndStrings(line);
      const caught = FORBIDDEN.filter(
        ({ pattern, unless }) => pattern.test(stripped) && !unless?.test(stripped),
      );
      expect({ line, caught: caught.map((c) => c.what) }).toEqual({ line, caught: [] });
    }
  });
});
