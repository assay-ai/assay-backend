import { AccountState, findAssociatedTokenPda, getTokenEncoder } from '@solana-program/token';
import {
  Address,
  getAddressDecoder,
  getBase58Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from '@solana/kit';
import {
  DEPOSIT_STAKE_DISCRIMINATOR,
  OPEN_STAKE_DISCRIMINATOR,
  REQUEST_UNSTAKE_DISCRIMINATOR,
  WITHDRAW_STAKE_DISCRIMINATOR,
  findConfigPda,
  findStakePda,
  getConfigEncoder,
  getDepositStakeInstructionDataDecoder,
  getProviderStakeEncoder,
} from '@assay/settlement-client';

import { ProviderChainEnrolmentRepository } from '@database/postgres/repositories/provider-chain-enrolment.repository';
import { UnsignedChainTransactionDto } from '@modules/chains/dto/unsigned-chain-transaction.dto';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import {
  AccountId,
  CHAIN_IDS,
  ChainNamespace,
  parseAssetId,
  toAccountId,
} from '@modules/chains/ports/caip.types';
import { EvmStakeIntentBuilder } from '@modules/chains/evm/evm-stake-intent-builder.service';
import { EvmStakeReader } from '@modules/chains/evm/evm-stake-reader.service';
import { NamespaceStakeIntentBuilder } from '@modules/chains/multiplex/namespace-stake-intent-builder';
import { SolanaSettlementStakeReader } from '@modules/chains/solana/settlement-stake-reader.service';
import {
  ParsedTransactionForDeposit,
  STAKE_INTENT_GAS_LAMPORTS,
  SolanaStakeIntentBuilder,
} from '@modules/chains/solana/stake-intent-builder.service';
import { ProviderErrorCode } from '@modules/provider/errors/provider.errors';
import {
  StakeIntentBuilderPort,
  StakeIntentKind,
} from '@modules/provider/ports/stake-intent-builder.port';
import { ProviderStakeIntentService } from '@modules/provider/services/provider-stake-intent.service';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';
import { deployment as evmDeployment } from '../chains/evm/evm-fixtures';
import { expectSettlementAccountList } from '../chains/solana/helpers/instruction-accounts';
import { AccountErrorCode } from '@modules/account/errors/account.errors';
import { BlockedRole, BlockSubjectKind } from '@modules/blocklist/domain/account-block';
import { AccountBlocklistService } from '@modules/blocklist/services/account-blocklist.service';

import { blocklistOf, noBlocks } from '../helpers/blocklist';

/**
 * The four stake intents, from an HTTP-level request to the
 * bytes a provider's own wallet would be handed.
 *
 * The fake sits at the **RPC**, the structural slice each service already
 * declares, exactly as `onchain-provider-stake.source.spec.ts` does. So the generated encoder, the
 * real PDA derivation, the real `Config` read and the real transaction
 * compilation all run. Faking `StakeIntentBuilderPort` instead would have made
 * every assertion below a restatement of the fake — and the two facts this
 * suite exists to pin down (the transaction is **unsigned**, and it names the
 * provider as its own fee payer) live precisely in the bytes a port fake would
 * have skipped.
 *
 * Nothing here touches a network or a chain.
 */

const PROGRAM_ID = '7C4i9t4sHpMpsqsB91JYBmuvNfnbof2DPN1yZp3KjN2S';
const STAKE_MINT = parseAssetId(ASSET_IDS.USDC_SOLANA_DEVNET).assetReference;
/** 32 zero bytes in base58 — a well-formed blockhash with no other meaning. */
const BLOCKHASH = '11111111111111111111111111111111';

const PROVIDER_ID = '11111111-2222-3333-4444-555555555555';
const UNBONDING_PERIOD_SECONDS = 1_209_600n;

function addressOf(seed: number): Address {
  return getAddressDecoder().decode(new Uint8Array(32).fill(seed));
}

const PROVIDER_ADDRESS = addressOf(7);
const STAKE_AUTHORITY = toAccountId(CHAIN_IDS.SOLANA_DEVNET, PROVIDER_ADDRESS) as AccountId;

function encodeConfig(): string {
  const bytes = getConfigEncoder().encode({
    admin: addressOf(200),
    stakeMint: STAKE_MINT as Address,
    treasury: addressOf(201),
    unbondingPeriodSeconds: UNBONDING_PERIOD_SECONDS,
    takeRateBps: 500,
    slashAgentBps: 6_000,
    slashPlatformBps: 3_000,
    slashCapBps: 1_000,
    minimumStake: 100_000_000n,
    penaltyAmount: 1_000_000n,
    verifierDailyCap: 100_000_000n,
    paused: false,
    totalStaked: 0n,
    totalDeposited: 0n,
    totalWithdrawn: 0n,
    totalSlashed: 0n,
    bump: 255,
    vaultBump: 254,
    // `Config.redeemer` — the only key `redeem_voucher` accepts as `rent_payer`.
    redeemer: addressOf(202),
    reserved: new Uint8Array(32),
  });
  return Buffer.from(bytes).toString('base64');
}

interface StakeAccountFields {
  readonly bonded?: bigint;
  readonly unbonding?: bigint;
  readonly unbondingStartedAt?: bigint;
}

function encodeStake(fields: StakeAccountFields): string {
  const bonded = fields.bonded ?? 0n;
  const unbonding = fields.unbonding ?? 0n;
  const bytes = getProviderStakeEncoder().encode({
    provider: PROVIDER_ADDRESS,
    bonded,
    unbonding,
    unbondingStartedAt: fields.unbondingStartedAt ?? 0n,
    slashedInWindow: 0n,
    slashWindowStartedAt: 0n,
    totalDeposited: bonded + unbonding,
    totalWithdrawn: 0n,
    totalSlashed: 0n,
    pendingSlash: 0n,
    bump: 253,
  });
  return Buffer.from(bytes).toString('base64');
}

function encodeTokenAccount(owner: Address, amount: bigint): string {
  const bytes = getTokenEncoder().encode({
    mint: STAKE_MINT as Address,
    owner,
    amount,
    delegate: null,
    state: AccountState.Initialized,
    isNative: null,
    delegatedAmount: 0n,
    closeAuthority: null,
  });
  return Buffer.from(bytes).toString('base64');
}

/** Every RPC call the three services under test make, and nothing else. */
class FakeRpc {
  readonly accounts = new Map<string, string>();
  readonly lamports = new Map<string, bigint>();
  failing = false;

  getAccountInfo(account: Address) {
    return {
      send: async () => {
        if (this.failing) throw new Error('rpc unavailable');
        const data = this.accounts.get(account);
        return { value: data ? { data: [data, 'base64'] as const, owner: account } : null };
      },
    };
  }

  getMultipleAccounts(accounts: readonly Address[]) {
    return {
      send: async () => {
        if (this.failing) throw new Error('rpc unavailable');
        return {
          value: accounts.map((account) => {
            const data = this.accounts.get(account);
            return data ? { data: [data, 'base64'] as const } : null;
          }),
        };
      },
    };
  }

  getBalance(account: Address) {
    return {
      send: async () => {
        if (this.failing) throw new Error('rpc unavailable');
        return { value: this.lamports.get(account) ?? 0n };
      },
    };
  }

  getLatestBlockhash() {
    return {
      send: async () => ({ value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100n } }),
    };
  }

  /**
   * `confirmedDeposit`'s read. Populated by
   * `stake-compensation-intent.spec.ts`; empty here, because none of these
   * cases asks about a landed transaction.
   */
  readonly transactions = new Map<string, ParsedTransactionForDeposit>();

  getTransaction(signature: string) {
    return {
      send: async (): Promise<ParsedTransactionForDeposit | null> => {
        if (this.failing) throw new Error('rpc unavailable');
        return this.transactions.get(signature) ?? null;
      },
    };
  }

  sendTransaction() {
    return {
      send: async (): Promise<string> => {
        // Nothing under test may ever submit one of these — the provider's own
        // wallet does. Reaching this is the failure, not the assertion.
        throw new Error('the backend must never submit a provider stake transaction');
      },
    };
  }
}

/** The one provider row the service reads, or none. */
/**
 * The enrolments a provider has proved a stake authority on.
 *
 * One entry, or none — which is what `requireStakeAuthority` reads. The service
 * refuses when there is more than one, because the route carries no `chainId`
 * and the bytes it returns are signed against one chain's stake account.
 */
function enrolmentRepository(stakeAuthority: string | null) {
  return {
    findProvedStakeAuthorities: jest.fn(async (organizationId: string) =>
      organizationId === PROVIDER_ID && stakeAuthority !== null
        ? [
            {
              organizationId: PROVIDER_ID,
              chainId: CHAIN_IDS.SOLANA_DEVNET,
              stakeAuthorityAccountId: stakeAuthority,
            },
          ]
        : [],
    ),
  } as unknown as ProviderChainEnrolmentRepository;
}

async function build(options: {
  readonly stakeAuthority?: string | null;
  readonly stake?: StakeAccountFields | null;
  readonly tokenBalance?: bigint | null;
  readonly lamports?: bigint;
  readonly blocklist?: AccountBlocklistService;
}) {
  const rpc = new FakeRpc();
  const [configPda] = await findConfigPda({ programAddress: PROGRAM_ID as Address });
  rpc.accounts.set(configPda, encodeConfig());

  if (options.stake) {
    const [stakePda] = await findStakePda(
      { provider: PROVIDER_ADDRESS },
      { programAddress: PROGRAM_ID as Address },
    );
    rpc.accounts.set(stakePda, encodeStake(options.stake));
  }

  if (options.tokenBalance !== null && options.tokenBalance !== undefined) {
    const [ata] = await findAssociatedTokenPda({
      owner: PROVIDER_ADDRESS,
      mint: STAKE_MINT as Address,
      tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as Address,
    });
    rpc.accounts.set(ata, encodeTokenAccount(PROVIDER_ADDRESS, options.tokenBalance));
  }

  rpc.lamports.set(PROVIDER_ADDRESS, options.lamports ?? 20_000_000n);

  const service = new ProviderStakeIntentService(
    enrolmentRepository(
      options.stakeAuthority === undefined ? STAKE_AUTHORITY : options.stakeAuthority,
    ),
    new SolanaSettlementStakeReader(rpc, PROGRAM_ID),
    new SolanaStakeIntentBuilder(rpc, PROGRAM_ID),
    options.blocklist ?? noBlocks(),
  );

  return { rpc, service };
}

/** The compiled message the response would hand to a wallet. */
function decodeIntent(transactionBase64: string) {
  const bytes = new Uint8Array(getBase64Encoder().encode(transactionBase64));
  const transaction = getTransactionDecoder().decode(bytes);
  const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  if (message.version !== 0) {
    throw new Error(`expected a v0 compiled message, got version ${String(message.version)}`);
  }
  return { transaction, message };
}

function instructionData(transactionBase64: string): Uint8Array {
  const { message } = decodeIntent(transactionBase64);
  const instruction = message.instructions[message.instructions.length - 1];
  return new Uint8Array(instruction.data ?? []);
}

function discriminatorOf(transactionBase64: string): number[] {
  return Array.from(instructionData(transactionBase64).subarray(0, 8));
}

/**
 * Narrow a response's `transaction` to the unsigned-transaction union's **solana** member.
 *
 * A cast would be the easy move and the wrong one: the response type is a
 * three-member union now, and every assertion below reads a field only one of
 * those members has. Throwing on any other member is the loser being asserted —
 * a service that started handing back an `eip155` member, or `null`, fails here
 * rather than reading `undefined` off it and comparing `undefined` to
 * `undefined`.
 */
function solanaMember(transaction: UnsignedChainTransactionDto | null) {
  if (transaction === null) {
    throw new Error('expected a transaction, got null');
  }
  if (transaction.namespace !== 'solana' || transaction.kind !== 'transaction') {
    throw new Error(
      `expected the solana/transaction member, got ${transaction.namespace}/${transaction.kind}`,
    );
  }
  return transaction;
}

describe('ProviderStakeIntentService — stake transactions the provider signs', () => {
  it('builds an open-stake intent for a provider with no stake account yet', async () => {
    const { service } = await build({ stake: null });

    const response = await service.createIntent(PROVIDER_ID, StakeIntentKind.OPEN_STAKE, null);

    expect(response.kind).toBe(StakeIntentKind.OPEN_STAKE);
    expect(response.account).toBe(STAKE_AUTHORITY);
    expect(response.transaction).not.toBeNull();
    expect(discriminatorOf(solanaMember(response.transaction).transactionBase64)).toEqual(
      Array.from(OPEN_STAKE_DISCRIMINATOR),
    );

    // The PROVIDER pays rent for their own account. `exercise-all.ts` uses the
    // admin as payer; that is a smoke script, not the product path.
    expect(solanaMember(response.transaction).feePayer).toBe(PROVIDER_ADDRESS);
    expect(solanaMember(response.transaction).signers).toEqual([PROVIDER_ADDRESS]);
  });

  it('refuses an open-stake intent when the account already exists', async () => {
    const { service } = await build({ stake: { bonded: 50_000_000n } });

    await expectErrorCodeAsync(
      () => service.createIntent(PROVIDER_ID, StakeIntentKind.OPEN_STAKE, null),
      ProviderErrorCode.PROVIDER_STAKE_ACCOUNT_ALREADY_OPEN,
    );
  });

  it('refuses a deposit before the stake account has been opened', async () => {
    const { service } = await build({ stake: null, tokenBalance: 100_000_000n });

    await expectErrorCodeAsync(
      () => service.createIntent(PROVIDER_ID, StakeIntentKind.DEPOSIT, '50000000'),
      ProviderErrorCode.PROVIDER_STAKE_ACCOUNT_NOT_OPEN,
    );
  });

  it('returns an UNSIGNED transaction — the backend never holds the provider key', async () => {
    const { service } = await build({ stake: { bonded: 0n }, tokenBalance: 100_000_000n });

    const response = await service.createIntent(PROVIDER_ID, StakeIntentKind.DEPOSIT, '50000000');
    const { transaction } = decodeIntent(solanaMember(response.transaction).transactionBase64);

    const signatures = Object.entries(transaction.signatures);
    expect(signatures).toHaveLength(1);
    const [signer, signature] = signatures[0];
    expect(signer).toBe(PROVIDER_ADDRESS);
    // Null, or 64 zero bytes — either way nothing in this process signed it.
    expect(signature === null || signature.every((byte) => byte === 0)).toBe(true);

    // And the amount really is the amount, decoded by the generated decoder
    // rather than trusted: a `u64` at the wrong offset is still a number.
    expect(
      getDepositStakeInstructionDataDecoder().decode(
        instructionData(solanaMember(response.transaction).transactionBase64),
      ).amount,
    ).toBe(50_000_000n);
  });

  it('preflights required USDC, required SOL for gas, and both current balances', async () => {
    const { service } = await build({
      stake: { bonded: 0n },
      tokenBalance: 12_000_000n,
      lamports: 3_000_000n,
    });

    const response = await service.createIntent(PROVIDER_ID, StakeIntentKind.DEPOSIT, '50000000');
    const preflight = response.preflight;

    expect(preflight.requiredStakeAsset.amount).toBe('50000000');
    expect(preflight.stakeAssetBalance?.amount).toBe('12000000');
    expect(preflight.requiredGas.amount).toBe(STAKE_INTENT_GAS_LAMPORTS.toString());
    expect(preflight.requiredGas.decimals).toBe(9);
    expect(preflight.gasBalance.amount).toBe('3000000');

    // Both are short, and the response says so rather than leaving a client to
    // compare two `Money`s and guess the scale.
    expect(preflight.hasEnoughStakeAsset).toBe(false);
    expect(preflight.hasEnoughGas).toBe(false);

    // The provider-facing sentence, verbatim on the wire.
    expect(preflight.gasSponsored).toBe(false);
    expect(preflight.gasNotSponsoredReason).toContain(
      'sponsoring an intentional financial act invites griefing',
    );
  });

  it('reports a missing token account as unknown rather than as a zero balance', async () => {
    const { service } = await build({ stake: { bonded: 0n }, tokenBalance: null });

    const response = await service.createIntent(PROVIDER_ID, StakeIntentKind.DEPOSIT, '50000000');

    expect(response.preflight.stakeAssetBalance).toBeNull();
    expect(response.preflight.hasEnoughStakeAsset).toBe(false);
  });

  it('says WHY withdrawable is less than asked, and builds nothing', async () => {
    // Lean v3 leaves one blocker: time. The exposure authority that used to
    // hold back matured stake behind unsettled calls is gone, and with it the
    // second reason a withdrawal could be smaller than asked for.
    const { service } = await build({
      stake: {
        bonded: 0n,
        unbonding: 40_000_000n,
        // Started just now — nowhere near matured.
        unbondingStartedAt: BigInt(Math.floor(Date.now() / 1000)),
      },
      tokenBalance: 0n,
    });

    const res = await service.createIntent(PROVIDER_ID, StakeIntentKind.WITHDRAW, '40000000');

    expect(res.withdrawable?.amount).toBe('0');
    expect(res.blockedBy).toBe('UNBONDING_NOT_MATURED');
    // No transaction the chain would reject: the point of naming the limit is
    // to spare the provider the gas of discovering it.
    expect(res.transaction).toBeNull();
  });

  it('builds the withdrawal when the whole amount is within the limit', async () => {
    const matured = BigInt(Math.floor(Date.now() / 1000)) - UNBONDING_PERIOD_SECONDS - 60n;
    const { service } = await build({
      stake: { bonded: 0n, unbonding: 40_000_000n, unbondingStartedAt: matured },
      tokenBalance: 0n,
    });

    const res = await service.createIntent(PROVIDER_ID, StakeIntentKind.WITHDRAW, '40000000');

    expect(res.blockedBy).toBeNull();
    expect(res.withdrawable?.amount).toBe('40000000');
    expect(discriminatorOf(solanaMember(res.transaction).transactionBase64)).toEqual(
      Array.from(WITHDRAW_STAKE_DISCRIMINATOR),
    );

    // Per-buyer escrows made this eight accounts, not seven: `earnings_vault`, read-only,
    // paired with a `destination != earnings_vault` constraint. Without it a
    // stake withdrawal INTO the earnings vault succeeds — `total_staked`
    // debited, tokens landing in a pool the earnings books do not track. The
    // vault is read-only, so Anchor's duplicate-mutable check does not cover
    // it, and neither the discriminator nor any assertion above moves.
    await expectSettlementAccountList(
      solanaMember(res.transaction).transactionBase64,
      'withdraw_stake',
      PROGRAM_ID as Address,
    );
  });

  it('builds an unstake intent against an open account', async () => {
    const { service } = await build({ stake: { bonded: 50_000_000n } });

    const res = await service.createIntent(PROVIDER_ID, StakeIntentKind.UNSTAKE, '20000000');

    expect(discriminatorOf(solanaMember(res.transaction).transactionBase64)).toEqual(
      Array.from(REQUEST_UNSTAKE_DISCRIMINATOR),
    );
    // Nothing to fund an unstake with — it moves no tokens.
    expect(res.preflight.requiredStakeAsset.amount).toBe('0');
  });

  it('refuses any intent for a provider who has not proved a stake authority', async () => {
    const { service } = await build({ stakeAuthority: null, stake: null });

    for (const kind of [
      StakeIntentKind.OPEN_STAKE,
      StakeIntentKind.DEPOSIT,
      StakeIntentKind.UNSTAKE,
      StakeIntentKind.WITHDRAW,
    ]) {
      await expectErrorCodeAsync(
        () =>
          service.createIntent(
            PROVIDER_ID,
            kind,
            kind === StakeIntentKind.OPEN_STAKE ? null : '1000000',
          ),
        ProviderErrorCode.PROVIDER_STAKE_AUTHORITY_UNPROVEN,
      );
    }
  });

  it('fails closed when the chain cannot be read', async () => {
    const { rpc, service } = await build({ stake: { bonded: 50_000_000n } });
    rpc.failing = true;

    await expectErrorCodeAsync(
      () => service.createIntent(PROVIDER_ID, StakeIntentKind.DEPOSIT, '50000000'),
      ProviderErrorCode.PROVIDER_STAKE_CHAIN_UNAVAILABLE,
    );
  });

  it('never returns a transaction the deposit discriminator does not match', async () => {
    const { service } = await build({ stake: { bonded: 0n }, tokenBalance: 100_000_000n });

    const res = await service.createIntent(PROVIDER_ID, StakeIntentKind.DEPOSIT, '50000000');

    expect(discriminatorOf(solanaMember(res.transaction).transactionBase64)).toEqual(
      Array.from(DEPOSIT_STAKE_DISCRIMINATOR),
    );
  });

  describe('the stake intent transaction is a discriminated UnsignedChainTransaction', () => {
    it('carries namespace, chainId and kind alongside the Solana fields', async () => {
      // This file fakes at the RPC, so the real `SolanaStakeIntentBuilder` runs
      // and the discriminants are the ones it stamped — not a stub's echo. The
      // `chainId` asserted here is the chain of the ACCOUNT the intent was
      // built for, which is what `chainIdOf(request.account)` derives.
      const { service } = await build({ stake: { bonded: 0n }, tokenBalance: 100_000_000n });

      const response = await service.createIntent(PROVIDER_ID, StakeIntentKind.DEPOSIT, '50000000');

      expect(response.transaction).not.toBeNull();
      expect(response.transaction!.namespace).toBe('solana');
      expect(response.transaction!.kind).toBe('transaction');
      expect(response.transaction!.chainId).toBe('solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1');

      // The loser, asserted: the eip155 branch did not run, and a mapper that
      // reached for one would leave these keys behind.
      const keys = Object.keys(response.transaction!);
      expect(keys).not.toContain('nonce');
      expect(keys).not.toContain('gasLimit');
      expect(keys).not.toContain('maxFeePerGas');
      expect(keys).not.toContain('domain');
      expect(keys).toEqual(
        expect.arrayContaining([
          'namespace',
          'chainId',
          'kind',
          'transactionBase64',
          'feePayer',
          'signers',
          'blockhash',
          'lastValidBlockHeight',
        ]),
      );
    });

    it('a blocked withdrawal still returns no transaction at all', async () => {
      // The loser, asserted. Adopting the union must not turn `null` into an
      // empty solana member — a transaction the chain would reject is not
      // returned, and `blockedBy` says why.
      const { service } = await build({
        stake: {
          bonded: 0n,
          unbonding: 40_000_000n,
          unbondingStartedAt: BigInt(Math.floor(Date.now() / 1000)),
        },
        tokenBalance: 0n,
      });

      const res = await service.createIntent(PROVIDER_ID, StakeIntentKind.WITHDRAW, '40000000');

      expect(res.transaction).toBeNull();
      expect(res.blockedBy).not.toBeNull();
    });
  });
});

/**
 * `confirmedDeposit` — the read that turns "somebody says the treasury paid the
 * provider back" into a fact.
 *
 * `S-5`'s compensation is a `deposit_stake` the treasury's multisig signs, and
 * this backend never sees that signature being made. So the only honest way to
 * record it is to go and look, and the three things this check has to get right
 * are the three ways a plausible-looking signature could be wrong: a different
 * instruction, a different provider's stake, or a smaller amount.
 */
describe('SolanaStakeIntentBuilder.confirmedDeposit', () => {
  const SIGNATURE = 'a-confirmed-signature';
  /** The treasury that funds a compensation, and when its transaction landed. */
  const TREASURY = addressOf(300);
  const BLOCK_TIME = 1_790_000_000;
  const EXPECTED = {
    funder: toAccountId(CHAIN_IDS.SOLANA_DEVNET, TREASURY) as AccountId,
    after: new Date((BLOCK_TIME - 3_600) * 1000),
  };

  function depositData(amount: bigint): string {
    const data = new Uint8Array(DEPOSIT_STAKE_DISCRIMINATOR.length + 8);
    data.set(DEPOSIT_STAKE_DISCRIMINATOR, 0);
    new DataView(data.buffer).setBigUint64(DEPOSIT_STAKE_DISCRIMINATOR.length, amount, true);
    return getBase58Decoder().decode(data);
  }

  async function builderWith(
    instructions: readonly { programId: string; accounts?: string[]; data?: string }[],
    meta: { err: unknown } | null = { err: null },
    blockTime: number | null = BLOCK_TIME,
  ) {
    const rpc = new FakeRpc();
    const [configPda] = await findConfigPda({ programAddress: PROGRAM_ID as Address });
    rpc.accounts.set(configPda, encodeConfig());
    rpc.transactions.set(SIGNATURE, {
      meta,
      blockTime,
      transaction: { message: { instructions } },
    });
    return { builder: new SolanaStakeIntentBuilder(rpc, PROGRAM_ID), rpc };
  }

  async function stakePdaOf(): Promise<string> {
    const [pda] = await findStakePda(
      { provider: PROVIDER_ADDRESS },
      { programAddress: PROGRAM_ID as Address },
    );
    return pda;
  }

  it('reads the amount off the instruction, not off what the caller asked for', async () => {
    const { builder } = await builderWith([
      {
        programId: PROGRAM_ID,
        accounts: [TREASURY, 'b', 'c', await stakePdaOf()],
        data: depositData(7_000_000n),
      },
    ]);

    const deposited = await builder.confirmedDeposit(SIGNATURE, STAKE_AUTHORITY, EXPECTED);

    expect(deposited?.amount).toBe('7000000');
    expect(deposited?.asset).toBe(ASSET_IDS.USDC_SOLANA_DEVNET);
  });

  it('sums two deposits into the same stake in one transaction', async () => {
    const stake = await stakePdaOf();
    const { builder } = await builderWith([
      {
        programId: PROGRAM_ID,
        accounts: [TREASURY, 'b', 'c', stake],
        data: depositData(1_000_000n),
      },
      {
        programId: PROGRAM_ID,
        accounts: [TREASURY, 'b', 'c', stake],
        data: depositData(2_000_000n),
      },
    ]);

    expect((await builder.confirmedDeposit(SIGNATURE, STAKE_AUTHORITY, EXPECTED))?.amount).toBe(
      '3000000',
    );
  });

  it('ignores a deposit into somebody else’s stake account', async () => {
    // The check that stops a real, confirmed deposit paying a stranger from
    // counting as this provider's compensation.
    const { builder } = await builderWith([
      {
        programId: PROGRAM_ID,
        accounts: [TREASURY, 'b', 'c', addressOf(200)],
        data: depositData(7_000_000n),
      },
    ]);

    await expect(
      builder.confirmedDeposit(SIGNATURE, STAKE_AUTHORITY, EXPECTED),
    ).resolves.toBeNull();
  });

  it('ignores an instruction of this program that is not a deposit', async () => {
    const other = new Uint8Array(16);
    other.set([9, 9, 9, 9, 9, 9, 9, 9], 0);
    const { builder } = await builderWith([
      {
        programId: PROGRAM_ID,
        accounts: [TREASURY, 'b', 'c', await stakePdaOf()],
        data: getBase58Decoder().decode(other),
      },
    ]);

    await expect(
      builder.confirmedDeposit(SIGNATURE, STAKE_AUTHORITY, EXPECTED),
    ).resolves.toBeNull();
  });

  it('ignores a deposit belonging to some other program entirely', async () => {
    const { builder } = await builderWith([
      {
        programId: '11111111111111111111111111111111',
        accounts: [TREASURY, 'b', 'c', await stakePdaOf()],
        data: depositData(7_000_000n),
      },
    ]);

    await expect(
      builder.confirmedDeposit(SIGNATURE, STAKE_AUTHORITY, EXPECTED),
    ).resolves.toBeNull();
  });

  it('answers null for a transaction that landed and failed', async () => {
    const { builder } = await builderWith(
      [
        {
          programId: PROGRAM_ID,
          accounts: [TREASURY, 'b', 'c', await stakePdaOf()],
          data: depositData(7_000_000n),
        },
      ],
      { err: { InstructionError: [0, 'Custom'] } },
    );

    await expect(
      builder.confirmedDeposit(SIGNATURE, STAKE_AUTHORITY, EXPECTED),
    ).resolves.toBeNull();
  });

  it('answers null for a signature the cluster has never heard of', async () => {
    const { builder } = await builderWith([]);

    await expect(
      builder.confirmedDeposit('unknown', STAKE_AUTHORITY, EXPECTED),
    ).resolves.toBeNull();
  });

  // Review M-3: only a deposit the treasury funded, after the slash executed.
  it('ignores a deposit funded by anyone but the treasury', async () => {
    const stake = await stakePdaOf();
    const { builder } = await builderWith([
      {
        programId: PROGRAM_ID,
        accounts: [addressOf(301), 'b', 'c', stake],
        data: depositData(7_000_000n),
      },
    ]);

    await expect(
      builder.confirmedDeposit(SIGNATURE, STAKE_AUTHORITY, EXPECTED),
    ).resolves.toBeNull();
  });

  it('answers null for a deposit that landed before the slash executed, or with no time', async () => {
    const stake = await stakePdaOf();
    const instructions = [
      {
        programId: PROGRAM_ID,
        accounts: [TREASURY, 'b', 'c', stake],
        data: depositData(7_000_000n),
      },
    ];
    const early = await builderWith(instructions);
    await expect(
      early.builder.confirmedDeposit(SIGNATURE, STAKE_AUTHORITY, {
        ...EXPECTED,
        after: new Date(BLOCK_TIME * 1000),
      }),
    ).resolves.toBeNull();

    const untimed = await builderWith(instructions, { err: null }, null);
    await expect(
      untimed.builder.confirmedDeposit(SIGNATURE, STAKE_AUTHORITY, EXPECTED),
    ).resolves.toBeNull();
  });
});

/**
 * The same service on `eip155`, where there is no stake account to open.
 *
 * `EvmStakeReader` reports a provider only once `totalDeposited > 0`, so a
 * provider who has never staked reads as absent — which on Solana means "open
 * the account first" and here means nothing at all. Before `needsOpenStake`
 * existed, that absence refused the very first deposit with
 * `PROVIDER_STAKE_ACCOUNT_NOT_OPEN`, and `OPEN_STAKE` had no transaction to
 * offer instead: a provider on this chain could not stake at all.
 */
describe('ProviderStakeIntentService — on eip155', () => {
  const EVM_CHAIN = CHAIN_IDS.ROBINHOOD_TESTNET;
  const EVM_PROVIDER = '0x31b1DF6F36ec62075a3BE03a5C0BebB06534bA72';
  const EVM_AUTHORITY = toAccountId(EVM_CHAIN, EVM_PROVIDER);

  function evmService(options: { totalDeposited: bigint }) {
    const client = {
      readContract: jest.fn(async (args: { functionName: string }) => {
        if (args.functionName === 'params') return { unbondingPeriodSeconds: 1_209_600n };
        if (args.functionName === 'balanceOf') return 200_000_000n;
        throw new Error(`unexpected read ${args.functionName}`);
      }),
      multicall: jest.fn(async () => [
        {
          bonded: options.totalDeposited,
          unbonding: 0n,
          unbondingStartedAt: 0n,
          slashedInWindow: 0n,
          slashWindowStartedAt: 0n,
          pendingSlash: 0n,
          __gap: 0n,
          totalDeposited: options.totalDeposited,
          totalWithdrawn: 0n,
          totalSlashed: 0n,
        },
      ]),
      getBalance: jest.fn(async () => 600_000_000_000_000n),
      getTransactionCount: jest.fn(async () => 0),
      estimateFeesPerGas: jest.fn(async () => ({
        maxFeePerGas: 10_000_000n,
        maxPriorityFeePerGas: 0n,
      })),
      getTransactionReceipt: jest.fn(),
      getBlock: jest.fn(),
    };
    const clients = new Map([[EVM_CHAIN, client]]);
    const deployments = new Map([[EVM_CHAIN, evmDeployment(EVM_CHAIN)]]);
    const builder = new NamespaceStakeIntentBuilder(
      new Map<string, StakeIntentBuilderPort>([
        [ChainNamespace.EIP155, new EvmStakeIntentBuilder(clients, deployments)],
      ]),
    );
    const enrolments = {
      findProvedStakeAuthorities: jest.fn(async () => [
        { organizationId: PROVIDER_ID, chainId: EVM_CHAIN, stakeAuthorityAccountId: EVM_AUTHORITY },
      ]),
    } as unknown as ProviderChainEnrolmentRepository;

    return new ProviderStakeIntentService(
      enrolments,
      new EvmStakeReader(clients, deployments, { now: () => Date.now(), paramsTtlMs: 60_000 }),
      builder,
      noBlocks(),
    );
  }

  it('builds the FIRST deposit for a provider who has never staked', async () => {
    const service = evmService({ totalDeposited: 0n });

    const response = await service.createIntent(PROVIDER_ID, StakeIntentKind.DEPOSIT, '50000000');

    expect(response.transaction).toMatchObject({
      namespace: 'eip155',
      kind: 'transaction',
      from: EVM_PROVIDER,
      to: evmDeployment(EVM_CHAIN).stake,
    });
    expect(response.amount).toMatchObject({
      amount: '50000000',
      asset: ASSET_IDS.USDG_ROBINHOOD_TESTNET,
    });
  });

  it('refuses OPEN_STAKE by name: there is no account to open on this chain', async () => {
    const service = evmService({ totalDeposited: 0n });

    await expectErrorCodeAsync(
      () => service.createIntent(PROVIDER_ID, StakeIntentKind.OPEN_STAKE, null),
      ProviderErrorCode.PROVIDER_STAKE_ACCOUNT_NOT_NEEDED,
    );
  });

  it('still refuses an unstake for a provider with nothing staked', async () => {
    const service = evmService({ totalDeposited: 0n });

    await expectErrorCodeAsync(
      () => service.createIntent(PROVIDER_ID, StakeIntentKind.UNSTAKE, '1000000'),
      ProviderErrorCode.PROVIDER_STAKE_ACCOUNT_NOT_OPEN,
    );
  });
});

describe('ProviderStakeIntentService, with the stake authority blocked', () => {
  it.each([StakeIntentKind.DEPOSIT, StakeIntentKind.WITHDRAW])(
    'builds no %s intent for a blocked stake authority',
    async (kind) => {
      const { service, rpc } = await build({
        blocklist: blocklistOf({ kind: BlockSubjectKind.WALLET, subject: STAKE_AUTHORITY }),
      });
      const readsBefore = rpc.accounts.size;

      await expect(service.createIntent(PROVIDER_ID, kind, '1000000')).rejects.toMatchObject({
        errorCode: AccountErrorCode.ACCOUNT_BLOCKED,
        context: { role: BlockedRole.STAKE_AUTHORITY },
      });
      expect(rpc.accounts.size).toBe(readsBefore);
    },
  );
});
