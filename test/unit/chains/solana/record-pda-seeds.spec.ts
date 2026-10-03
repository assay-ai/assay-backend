/**
 * The one hand-written PDA finder derives from the program's own seeds.
 *
 * `packages/settlement-client/src/record-pdas.ts` exists because
 * `@codama/renderers-js` does not resolve a PDA seed whose path points inside a
 * struct (`propose_slash`, `cancel_slash`, `reverse_slash` all seed
 * `slash_record` from `attestation.request_id`) or one that points at the
 * account's own field (`execute_slash`, `expire_slash` seed it from
 * `slash_record.request_id`). So every door onto a slash record comes out of
 * the generator unresolved, and `findSlashRecordPda` fills that gap by hand.
 *
 * Pure const seeds (`["earnings_vault"]` and friends) Codama resolves itself —
 * those finders are generated, not hand-written, and one test below only
 * asserts that stays true.
 *
 * Filling the slash-record gap by hand reintroduces exactly the thing the
 * generated client abolishes: a copy of the program's interface that nothing
 * checks. This test is the check. It reads the seed bytes out of
 * `idl/x402_payment.json` — the same file the rest of the client is generated
 * from — and compares them with the constants that file declares.
 *
 * If this fails, the program renamed a seed and `record-pdas.ts` did not
 * follow. The symptom in production would be a slash transaction failing with
 * `ConstraintSeeds` (2006), which is safe but opaque; here it is one line.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { address, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import {
  findEscrowPda,
  findSlashRecordPda,
  RECORD_PDA_SEEDS,
  SETTLEMENT_PROGRAM_ADDRESS,
} from '@x402/settlement-client';

const IDL_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'packages',
  'settlement-client',
  'idl',
  'x402_payment.json',
);

interface IdlSeed {
  readonly kind: string;
  readonly value?: number[];
  readonly path?: string;
}

interface IdlAccount {
  readonly name: string;
  readonly pda?: { readonly seeds: IdlSeed[] };
}

interface Idl {
  readonly address: string;
  readonly instructions: ReadonlyArray<{ name: string; accounts: IdlAccount[] }>;
}

const idl: Idl = JSON.parse(readFileSync(IDL_PATH, 'utf8'));

/** The `pda.seeds` the IDL records for one account of one instruction. */
function seedsOf(instruction: string, account: string): IdlSeed[] {
  const found = idl.instructions
    .find((candidate) => candidate.name === instruction)
    ?.accounts.find((candidate) => candidate.name === account);
  if (!found?.pda) {
    throw new Error(`${instruction}.${account} has no pda seeds in the IDL`);
  }
  return found.pda.seeds;
}

describe('the hand-written record PDA uses the program’s own seeds', () => {
  it('reads an IDL that actually declares these accounts as PDAs', () => {
    // Guards against the whole suite passing vacuously if the IDL moves or the
    // instruction is renamed.
    expect(idl.address).toBe(SETTLEMENT_PROGRAM_ADDRESS);
    expect(seedsOf('propose_slash', 'slash_record')).toHaveLength(2);
    expect(seedsOf('execute_slash', 'slash_record')).toHaveLength(2);
  });

  it('takes the slash record’s constant seed from the IDL', () => {
    const [constant, argument] = seedsOf('propose_slash', 'slash_record');

    expect(constant.kind).toBe('const');
    expect(Array.from(RECORD_PDA_SEEDS.slashRecord)).toEqual(constant.value);
    // The second seed is the request id, and this asserts *which* field —
    // deriving from `attestation.provider` instead would produce one record
    // per provider rather than one per request, which is the replay guard.
    expect(argument).toEqual({ kind: 'arg', path: 'attestation.request_id' });
  });

  it('the three later doors resolve the record the proposal wrote', () => {
    // `cancel_slash`, `execute_slash` and `expire_slash` all read the id off
    // the account itself (the IDL also carries an `account: "SlashRecord"` tag
    // on that seed, which is why this compares kind/path rather than the whole
    // object). Lean v3 moved `cancel_slash` onto the admin's signature, so it
    // no longer takes an attestation to seed from; `reverse_slash` is gone.
    // Different spellings of one address — a mismatch would mean executing a
    // record no proposal ever wrote.
    const [constant] = seedsOf('propose_slash', 'slash_record');
    for (const instruction of ['cancel_slash', 'execute_slash', 'expire_slash']) {
      const [seedConstant, seedArgument] = seedsOf(instruction, 'slash_record');
      expect(seedConstant).toEqual(constant);
      expect(seedArgument).toMatchObject({ kind: 'account', path: 'slash_record.request_id' });
    }
  });

  it('derives the address the seeds imply', async () => {
    const requestId = new Uint8Array(32).fill(7);
    const [expected] = await getProgramDerivedAddress({
      programAddress: address(SETTLEMENT_PROGRAM_ADDRESS),
      seeds: [Uint8Array.from(seedsOf('propose_slash', 'slash_record')[0].value!), requestId],
    });

    const [derived] = await findSlashRecordPda({ requestId });

    expect(derived).toBe(expected);
  });

  it('lets a caller override the program address', async () => {
    // A localnet with a fresh program keypair is a different program id, and a
    // finder that ignored the override would derive addresses for the wrong
    // deployment.
    const requestId = new Uint8Array(32).fill(1);
    const other = address('BPFLoaderUpgradeab1e11111111111111111111111');

    const [derived] = await findSlashRecordPda({ requestId }, { programAddress: other });
    const [fromDefault] = await findSlashRecordPda({ requestId });

    expect(derived).not.toBe(fromDefault);
  });

  it('renders the escrow finder too, so it is not hand-written either', () => {
    // `open_escrow` seeds `escrow` from the `buyer` **account**, so Codama
    // resolves it — unlike `redeem_voucher`, which seeds it from
    // `voucher.payer` and gets no default. It is therefore generated, and
    // `record-pdas.ts` deliberately has no copy of it.
    expect(typeof findEscrowPda).toBe('function');
    expect(Object.keys(RECORD_PDA_SEEDS)).toEqual(['slashRecord']);
  });

  it('derives the escrow the whole spend path is keyed on', async () => {
    const buyer = address('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
    const [seedConstant, seedAccount] = seedsOf('open_escrow', 'escrow');

    expect(seedConstant.kind).toBe('const');
    expect(seedAccount).toEqual({ kind: 'account', path: 'buyer' });

    const [expected] = await getProgramDerivedAddress({
      programAddress: address(SETTLEMENT_PROGRAM_ADDRESS),
      seeds: [Uint8Array.from(seedConstant.value!), getAddressEncoder().encode(buyer)],
    });
    const [derived] = await findEscrowPda({ buyer });

    expect(derived).toBe(expected);
  });
});
