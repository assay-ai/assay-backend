import { readFileSync } from 'fs';
import { join } from 'path';

import {
  Address,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getProgramDerivedAddress,
  getTransactionDecoder,
} from '@solana/kit';
import { X402_PAYMENT_PROGRAM_ADDRESS } from '@x402/settlement-client';

/**
 * The account-list drift gate — a check that once had no test at all.
 *
 * ## The failure this exists to catch
 *
 * Per-buyer escrows added an account to three instructions that already existed. Every one
 * of them compiled, and the whole unit suite stayed green, because nothing
 * asserted on an account list: the specs pinned the discriminator and the empty
 * signature slots, and an eighth account on a seven-account instruction changes
 * neither. Only the chain refuses.
 *
 * Worse, `tsc` catches only *half* of it. Codama marks an account it can derive
 * as **optional** on the `…InstructionAsync` input, so omitting `config` on
 * `withdraw` type-checks — and the builder then fills it in by calling
 * `findConfigPda()` with no argument, which derives it under the client's
 * compiled-in `declare_id!()` rather than under the id the program is actually
 * deployed at. Those two differ for the whole life of a redeploy branch, which
 * is exactly when this is most likely to happen.
 *
 * So this helper asserts two things against the **vendored IDL**, which is the
 * one artefact that moves when the program does:
 *
 * 1. the built instruction carries exactly as many accounts as the IDL declares;
 * 2. every account the IDL derives from constant seeds is the PDA under the
 *    **deployed** program id — and, when that differs from the compiled-in one,
 *    is provably not the compiled-in derivation.
 */

interface IdlSeed {
  readonly kind: string;
  readonly value?: readonly number[];
}

interface IdlAccount {
  readonly name: string;
  readonly pda?: { readonly seeds: readonly IdlSeed[]; readonly program?: unknown };
}

interface IdlInstruction {
  readonly name: string;
  readonly accounts: readonly IdlAccount[];
}

const IDL = JSON.parse(
  readFileSync(
    join(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      '..',
      'packages',
      'settlement-client',
      'idl',
      'x402_payment.json',
    ),
    'utf8',
  ),
) as { readonly instructions: readonly IdlInstruction[] };

function idlInstruction(snakeName: string): IdlInstruction {
  const found = IDL.instructions.find((instruction) => instruction.name === snakeName);
  if (!found) {
    throw new Error(`no instruction named ${snakeName} in the vendored IDL`);
  }
  return found;
}

/** The static account addresses the last instruction of a compiled transaction names, in order. */
export function accountsOfLastInstruction(transactionBase64: string): readonly Address[] {
  const bytes = new Uint8Array(getBase64Encoder().encode(transactionBase64));
  const transaction = getTransactionDecoder().decode(bytes);
  const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  if (message.version !== 0) {
    throw new Error(`expected a v0 compiled message, got version ${String(message.version)}`);
  }
  const instruction = message.instructions[message.instructions.length - 1];
  const indices = instruction.accountIndices ?? [];
  return indices.map((index) => message.staticAccounts[index]);
}

/**
 * Assert the built instruction matches the IDL's account list, and that no
 * constant-seed PDA on it was derived under the compiled-in program address.
 *
 * `deployedProgramAddress` must differ from `X402_PAYMENT_PROGRAM_ADDRESS` for
 * the second half to have teeth; the callers all use a distinct test id, and
 * this refuses outright if one ever stops.
 */
export async function expectSettlementAccountList(
  transactionBase64: string,
  snakeInstructionName: string,
  deployedProgramAddress: Address,
): Promise<void> {
  if (deployedProgramAddress === X402_PAYMENT_PROGRAM_ADDRESS) {
    throw new Error(
      'this gate needs a deployed program id that differs from the compiled-in one, ' +
        'or a PDA derived under the wrong id is indistinguishable from a correct one',
    );
  }

  const declared = idlInstruction(snakeInstructionName);
  const supplied = accountsOfLastInstruction(transactionBase64);

  expect({ instruction: snakeInstructionName, accounts: supplied.length }).toEqual({
    instruction: snakeInstructionName,
    accounts: declared.accounts.length,
  });

  for (const [index, account] of declared.accounts.entries()) {
    const seeds = account.pda?.seeds;
    // Only PDAs of THIS program, from constant seeds alone — an ATA is derived
    // by the token program and is correct wherever this one is deployed.
    if (!seeds || account.pda?.program || !seeds.every((seed) => seed.kind === 'const')) {
      continue;
    }

    const seedBytes = seeds.map((seed) => new Uint8Array(seed.value ?? []));
    const [underDeployed] = await getProgramDerivedAddress({
      programAddress: deployedProgramAddress,
      seeds: seedBytes,
    });

    expect({ account: account.name, address: supplied[index] }).toEqual({
      account: account.name,
      address: underDeployed,
    });
  }
}
