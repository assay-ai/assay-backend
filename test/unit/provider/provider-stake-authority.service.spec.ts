import { generateKeyPairSync, sign } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

import { ProviderChainEnrolmentRepository } from '@database/postgres/repositories/provider-chain-enrolment.repository';
import { ProviderPayoutChallengeRepository } from '@database/postgres/repositories/provider-payout-challenge.repository';
import { ProviderRepository } from '@database/postgres/repositories/provider.repository';
import { getBase58Decoder } from '@solana/kit';

import { BaseError } from '@shared/errors/base.error';

import { ChainAdapterRegistry } from '@modules/chains/chain-adapter.registry';
import { ChainErrorCode } from '@modules/chains/errors/chains.errors';
import { AccountId, CHAIN_IDS, chainIdOf, toAssetId } from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';
import { PayoutProofChallenge } from '@modules/chains/ports/payout-proof.types';
import { StakeAuthorityChallenge } from '@modules/chains/ports/stake-authority.types';
import { SolanaChainAdapter, SolanaRpcClient } from '@modules/chains/solana/solana-chain.adapter';
import {
  PAYOUT_PROOF_MESSAGE_VERSION,
  STAKE_AUTHORITY_MESSAGE_VERSION,
} from '@modules/chains/solana/solana.constants';
import { McpCallerKind, McpSession } from '@modules/mcp/ports/mcp-session.port';
import { ProviderErrorCode } from '@modules/provider/errors/provider.errors';
import {
  OnChainStake,
  OnChainStakeReaderPort,
} from '@modules/provider/ports/onchain-stake-reader.port';
import { ProviderStakeAuthorityService } from '@modules/provider/services/provider-stake-authority.service';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';
import { AccountErrorCode } from '@modules/account/errors/account.errors';
import { BlockedRole, BlockSubjectKind } from '@modules/blocklist/domain/account-block';
import { AccountBlocklistService } from '@modules/blocklist/services/account-blocklist.service';

import { blocklistOf, noBlocks } from '../helpers/blocklist';

const SOLANA_MAINNET = CHAIN_IDS.SOLANA_MAINNET;
const ORG = 'org-11111111-1111-4111-8111-111111111111';
const OTHER_ORG = 'org-22222222-2222-4222-8222-222222222222';
const CREDENTIAL = 'cred-console-1';
const ADDRESS = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

/** A stake authority a provider has already proved — the account a rotation would leave behind. */
const CURRENT_AUTHORITY = `${SOLANA_MAINNET}:${ADDRESS}` as AccountId;

/** The settlement program's stake mint. Only its scale matters to these tests. */
const STAKE_ASSET = toAssetId(
  SOLANA_MAINNET,
  'token',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
);

function money(atomic: bigint): Money {
  return { amount: atomic.toString(), asset: STAKE_ASSET, decimals: 6 };
}

/** One `ProviderStake` account as `OnChainStakeReaderPort` reports it. */
function reading(
  parts: { bonded?: bigint; unbonding?: bigint } = {},
): Omit<OnChainStake, 'account'> {
  return {
    bonded: money(parts.bonded ?? 0n),
    unbonding: money(parts.unbonding ?? 0n),
    // The rotation gate reads the two balances and nothing else; the unbonding
    // clock belongs to the stake screen's countdown, not to this decision.
    unbondingStartedAt: null,
    unbondingCompletesAt: null,
    observedAt: new Date(),
  };
}

function session(overrides: Partial<McpSession> = {}): McpSession {
  return {
    credentialId: CREDENTIAL,
    organizationId: ORG,
    agentId: 'agent-1',
    agentAccount: `${SOLANA_MAINNET}:11111111111111111111111111111112` as AccountId,
    chainId: SOLANA_MAINNET,
    label: null,
    callerKind: McpCallerKind.CONFIG,
    paymentsAllowed: true,
    ...overrides,
  };
}

function stubRpc(): SolanaRpcClient {
  return {
    getTokenAccountBalance: () => ({ send: async () => ({ value: { amount: '0', decimals: 6 } }) }),
    getTransaction: () => ({ send: async () => null }),
    getLatestBlockhash: () => ({
      send: async () => ({
        value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 0n },
      }),
    }),
  } as SolanaRpcClient;
}

/** Real ed25519 keys and real signatures — the whole point is genuine crypto, not a stub. */
function wallet() {
  const keyPair = generateKeyPairSync('ed25519');
  const rawPublicKey = keyPair.publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  const address = getBase58Decoder().decode(rawPublicKey);
  return { keyPair, address, account: `${SOLANA_MAINNET}:${address}` as AccountId };
}

function signBytes(
  bytes: Uint8Array,
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
) {
  return getBase58Decoder().decode(sign(null, Buffer.from(bytes), privateKey));
}

function providerRow(overrides: Partial<Record<string, unknown>> = {}) {
  return { id: 'provider-1', organizationId: ORG, ...overrides };
}

function challengeRow(overrides: Partial<Record<string, unknown>> = {}) {
  const now = Date.now();
  return {
    id: 'challenge-1',
    organizationId: ORG,
    nonce: 'a'.repeat(64),
    accountId: undefined as unknown as string,
    message: '',
    messageVersion: STAKE_AUTHORITY_MESSAGE_VERSION,
    channel: 'CONSOLE',
    expiresAt: new Date(now + 10 * 60 * 1000),
    consumedAt: null as Date | null,
    issuedTo: CREDENTIAL,
    ...overrides,
  };
}

/**
 * A Postgres unique violation shaped the way `pg` hands one to TypeORM — the
 * `constraint` name is what the service is allowed to key on, because mapping
 * *any* 23505 onto "already claimed" would mis-report an unrelated index.
 */
function uniqueViolation(constraint: string): Error & { code: string; constraint: string } {
  const error = new Error(
    `duplicate key value violates unique constraint "${constraint}"`,
  ) as Error & { code: string; constraint: string };
  error.code = '23505';
  error.constraint = constraint;
  return error;
}

/**
 * `manager.createQueryBuilder().update(Entity)...execute()`, keyed by entity name.
 *
 * The challenge UPDATE models the real CAS: `WHERE consumed_at IS NULL` can
 * succeed exactly once, so the fake affects one row the first time and zero
 * every time after. That is what makes the concurrency spec below a test of
 * the service rather than of the fake.
 */
function fakeManager(options: {
  challengeAffected?: number;
  providerAffected?: number;
  providerError?: Error;
}) {
  const calls: Array<{ entity: string; set: unknown; wheres: string[] }> = [];
  let consumed = false;

  const manager = {
    createQueryBuilder() {
      return {
        update(entity: { name: string }) {
          const record = { entity: entity.name, set: undefined as unknown, wheres: [] as string[] };
          calls.push(record);
          const builder: any = {
            set(v: unknown) {
              record.set = v;
              return builder;
            },
            where(sql: string) {
              record.wheres.push(sql);
              return builder;
            },
            andWhere(sql: string) {
              record.wheres.push(sql);
              return builder;
            },
            async execute() {
              if (entity.name === 'ProviderPayoutChallengeEntity') {
                if (options.challengeAffected !== undefined) {
                  return { affected: options.challengeAffected };
                }
                const affected = consumed ? 0 : 1;
                consumed = true;
                return { affected };
              }
              if (options.providerError) {
                throw options.providerError;
              }
              return { affected: options.providerAffected ?? 1 };
            },
          };
          return builder;
        },
      };
    },
  };

  return { manager, calls };
}

function build(
  options: {
    provider?: Record<string, unknown> | null;
    challenge?: Record<string, unknown> | null;
    transactionOptions?: Parameters<typeof fakeManager>[0];
    /**
     * What the chain says about the provider's *current* stake authority.
     * `undefined` means no account at those seeds — the provider has fully
     * exited — which the port reports as an absence, never as a zero.
     */
    onChainStake?: Omit<OnChainStake, 'account'>;
    /** An RPC that cannot be reached. The gate has to fail closed on this. */
    readerError?: Error;
    /** `null` = no enrolment on the proved account's chain (enrolment required). */
    enrolment?: null;
    blocklist?: AccountBlocklistService;
  } = {},
) {
  const providers = {
    findOneBy: jest
      .fn()
      .mockResolvedValue(options.provider === undefined ? providerRow() : options.provider),
  } as unknown as ProviderRepository;

  // The stake authority lives on the ENROLMENT since per-chain stake, so the trio is
  // read and written there. `providerRow({ stakeAuthority })` still says what
  // every one of these tests means — "this provider has already proved this
  // account" — and is routed here rather than restated, so a case that pins the
  // current authority keeps reading the way it did.
  const currentAuthority =
    options.enrolment === undefined
      ? (((
          (options.provider === undefined ? providerRow() : options.provider) as Record<
            string,
            unknown
          > | null
        )?.stakeAuthority as string | null) ?? null)
      : null;
  const enrolments = {
    findOneBy: jest.fn().mockResolvedValue(
      options.enrolment === null
        ? null
        : {
            organizationId: ORG,
            chainId: SOLANA_MAINNET,
            stakeAuthorityAccountId: currentAuthority,
          },
    ),
  } as unknown as ProviderChainEnrolmentRepository;

  const challenges = {
    findOneBy: jest
      .fn()
      .mockResolvedValue(options.challenge === undefined ? null : options.challenge),
    create: jest.fn((v: Record<string, unknown>) => v),
    save: jest.fn(async (v: Record<string, unknown>) => ({ ...v, id: 'challenge-new' })),
  } as unknown as ProviderPayoutChallengeRepository;

  const solana = new SolanaChainAdapter(stubRpc(), [
    CHAIN_IDS.SOLANA_MAINNET,
    CHAIN_IDS.SOLANA_DEVNET,
  ]);
  const chains = new ChainAdapterRegistry([solana], solana.supportedChains);

  const config = { get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService;

  const tx = fakeManager(options.transactionOptions ?? {});
  const dataSource = {
    transaction: jest
      .fn()
      .mockImplementation(async (work: (manager: unknown) => unknown) => work(tx.manager)),
  } as unknown as DataSource;

  const reader = {
    bondedStakeOf: jest.fn(async (accounts: readonly AccountId[]) => {
      if (options.readerError) {
        throw options.readerError;
      }
      const readings = new Map<AccountId, OnChainStake>();
      if (options.onChainStake) {
        for (const account of accounts) {
          readings.set(account, { account, ...options.onChainStake });
        }
      }
      return readings as ReadonlyMap<AccountId, OnChainStake>;
    }),
  } satisfies OnChainStakeReaderPort;

  const service = new ProviderStakeAuthorityService(
    providers,
    enrolments,
    challenges,
    chains,
    config,
    dataSource,
    reader,
    options.blocklist ?? noBlocks(),
  );
  return { service, providers, enrolments, challenges, chains, dataSource, tx, reader };
}

/** Builds a stake challenge row plus the genuine signature that redeems it. */
function provable(overrides: { organizationId?: string; nonce?: string; expiresAt?: number } = {}) {
  const w = wallet();
  const challenge: StakeAuthorityChallenge = {
    account: w.account,
    organizationId: overrides.organizationId ?? ORG,
    nonce: overrides.nonce ?? 'b'.repeat(64),
    expiresAt: overrides.expiresAt ?? Math.floor((Date.now() + 60_000) / 1000),
  };
  const solana = new SolanaChainAdapter(stubRpc(), [
    CHAIN_IDS.SOLANA_MAINNET,
    CHAIN_IDS.SOLANA_DEVNET,
  ]);
  const bytes = solana.buildStakeAuthorityMessage(challenge);
  const message = new TextDecoder().decode(bytes);
  const signature = signBytes(bytes, w.keyPair.privateKey);
  const row = challengeRow({
    accountId: w.account,
    organizationId: challenge.organizationId,
    nonce: challenge.nonce,
    message,
    expiresAt: new Date(challenge.expiresAt * 1000),
  });
  return { wallet: w, challenge, solana, message, signature, row };
}

/**
 * The error `fn` rejects with, so a test can assert on the code, the status and
 * the prose without running the call three times.
 *
 * `expectErrorCodeAsync` covers the code, which is the contract a console
 * branches on, and that is what almost every test here wants. The refusals
 * below are the exception: their whole purpose is to tell a provider a number,
 * and a message nobody asserts on is a message that can quietly start
 * contradicting itself.
 */
async function rejection(fn: () => Promise<unknown>): Promise<BaseError> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(BaseError);
    return error as BaseError;
  }
  throw new Error('Expected the call to reject, but it resolved');
}

describe('ProviderStakeAuthorityService.issueChallenge', () => {
  it('refuses to issue a challenge with no provider row for this organization', async () => {
    const { service } = build({ provider: null });

    await expectErrorCodeAsync(
      () => service.issueChallenge(session(), { chainId: SOLANA_MAINNET, address: ADDRESS }),
      ProviderErrorCode.PROVIDER_NOT_FOUND,
    );
  });

  it('scopes the provider lookup to the caller’s own organization', async () => {
    const { service, providers } = build();

    await service.issueChallenge(session(), { chainId: SOLANA_MAINNET, address: ADDRESS });

    expect(providers.findOneBy).toHaveBeenCalledWith({ organizationId: ORG });
  });

  it('issues a nonce under the stake-authority version tag and persists a CONSOLE-only challenge', async () => {
    const { service, challenges } = build();

    const response = await service.issueChallenge(session(), {
      chainId: SOLANA_MAINNET,
      address: ADDRESS,
    });

    expect(response.nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(response.messageVersion).toBe(STAKE_AUTHORITY_MESSAGE_VERSION);
    expect(response.message.startsWith(STAKE_AUTHORITY_MESSAGE_VERSION)).toBe(true);
    expect(response.expiresAt.getTime()).toBeGreaterThan(Date.now());

    expect(challenges.save).toHaveBeenCalledTimes(1);
    const saved = (challenges.save as jest.Mock).mock.calls[0][0];
    expect(saved.organizationId).toBe(ORG);
    expect(saved.channel).toBe('CONSOLE');
    expect(saved.issuedTo).toBe(CREDENTIAL);
    expect(saved.consumedAt).toBeNull();
    expect(saved.messageVersion).toBe(STAKE_AUTHORITY_MESSAGE_VERSION);
  });

  it('never issues a payout-proof challenge from this path — the discriminator is set at issue', async () => {
    const { service, challenges } = build();

    await service.issueChallenge(session(), { chainId: SOLANA_MAINNET, address: ADDRESS });

    const saved = (challenges.save as jest.Mock).mock.calls[0][0];
    expect(saved.messageVersion).not.toBe(PAYOUT_PROOF_MESSAGE_VERSION);
  });

  /**
   * Debt 1. `uq_providers_stake_authority` is a unique index over a string, so
   * it only blocks byte-identical duplicates — the canonical form has to be
   * produced here, at the single write path, or two spellings of one account
   * both insert and both clear the router's stake gate.
   */
  it('stores the canonical CAIP-10 account id, not the chain-native address it was given', async () => {
    const { service, challenges } = build();

    const response = await service.issueChallenge(session(), {
      chainId: SOLANA_MAINNET,
      address: ADDRESS,
    });

    expect(response.accountId).toBe(`${SOLANA_MAINNET}:${ADDRESS}`);
    const saved = (challenges.save as jest.Mock).mock.calls[0][0];
    expect(saved.accountId).toBe(`${SOLANA_MAINNET}:${ADDRESS}`);
  });

  it('rejects an address that does not validate on the named chain', async () => {
    const { service } = build();

    await expectErrorCodeAsync(
      () =>
        service.issueChallenge(session(), { chainId: SOLANA_MAINNET, address: 'not-an-address' }),
      ChainErrorCode.CHAIN_INVALID_ADDRESS,
    );
  });
});

describe('ProviderStakeAuthorityService.prove', () => {
  it('stores the authority only when the signature verifies', async () => {
    const { row, signature, wallet: w } = provable();
    const { service, enrolments, providers, tx } = build({ challenge: row });

    const result = await service.prove(session(), { challengeId: row.id, signature });

    expect(result.stakeAuthority).toBe(w.account);
    expect(result.proof.challengeId).toBe(row.id);
    expect(result.proof.signature).toBe(signature);
    expect(result.proof.messageVersion).toBe(STAKE_AUTHORITY_MESSAGE_VERSION);

    // Both writes happened, atomically, on the transaction's own manager.
    expect(tx.calls).toHaveLength(2);
    expect(tx.calls[0].entity).toBe('ProviderPayoutChallengeEntity');
    expect(tx.calls[0].wheres).toContain('consumed_at IS NULL');
    expect(tx.calls[1].entity).toBe('ProviderChainEnrolmentEntity');
    expect(tx.calls[1].set).toMatchObject({ stakeAuthorityAccountId: w.account });
    // The trio is written together or not at all —
    // `chk_provider_chain_enrolments_stake_proved_together`.
    expect(tx.calls[1].set).toHaveProperty('stakeProof');
    expect(tx.calls[1].set).toHaveProperty('stakeProvedAt');
    // And it is written for ONE chain — the one the proved account names —
    // never for every enrolment the provider holds. Without this predicate a
    // provider proving a devnet account would overwrite their mainnet
    // authority, which is the collateral a mainnet slash reaches into.
    expect(tx.calls[1].wheres).toContain('chain_id = :chainId');
    // `prove` reads the ENROLMENT for one reason only — the *current* stake
    // authority on this chain, which the challenge row does not carry — and
    // that read is scoped to the caller's own organization like every other.
    //
    // The count is half the assertion, not decoration. `toHaveBeenCalledWith`
    // passes as soon as ANY call matched, so on its own it permits a second,
    // unscoped read being added beside this one later — which is exactly the
    // shape of a cross-tenant leak. Pinning the count back to one restores the
    // "every read is scoped" claim the assertion it replaced used to make.
    // The chain comes off the PROVED ACCOUNT's own CAIP-10 prefix, never from
    // config or a request field — `SOLANA_MAINNET` is the chain this file's
    // wallets are minted on, and a hardcoded devnet here would have been the
    // mistake the assertion exists to catch.
    expect(enrolments.findOneBy).toHaveBeenCalledWith({
      organizationId: ORG,
      chainId: chainIdOf(w.account),
    });
    expect(chainIdOf(w.account)).toBe(SOLANA_MAINNET);
    expect(enrolments.findOneBy).toHaveBeenCalledTimes(1);
    // The `providers` row is not read by `prove` at all any more.
    expect(providers.findOneBy).not.toHaveBeenCalled();
  });

  it('refuses a chain the provider has not enrolled on', async () => {
    // The enrolment-required rule at the write path. The authority is a column on the
    // enrolment, so there is nowhere to put it — but the refusal is the
    // decision, not the schema: staking on a chain with no payout address puts
    // collateral behind calls whose earnings have nowhere to go.
    const { row, signature } = provable();
    const { service, tx, reader } = build({ challenge: row, enrolment: null });

    await expectErrorCodeAsync(
      () => service.prove(session(), { challengeId: row.id, signature }),
      ProviderErrorCode.PROVIDER_CHAIN_NOT_ENROLLED,
    );
    // Before the chain read, and before the nonce is consumed: a refusal is
    // not a spend, and a request that cannot succeed must not generate RPC
    // traffic on this endpoint.
    expect(reader.bondedStakeOf).not.toHaveBeenCalled();
    expect(tx.calls).toHaveLength(0);
  });

  it('rejects a genuine signature from a wallet other than the one the challenge names', async () => {
    const { row, challenge, solana } = provable();
    const attacker = wallet();
    const signature = signBytes(
      solana.buildStakeAuthorityMessage(challenge),
      attacker.keyPair.privateKey,
    );
    const { service } = build({ challenge: row });

    await expectErrorCodeAsync(
      () => service.prove(session(), { challengeId: row.id, signature }),
      ProviderErrorCode.PROVIDER_STAKE_SIGNATURE_INVALID,
    );
  });

  it('refuses a challenge that expired', async () => {
    const w = wallet();
    const row = challengeRow({ accountId: w.account, expiresAt: new Date(Date.now() - 1000) });
    const { service } = build({ challenge: row });

    await expectErrorCodeAsync(
      () => service.prove(session(), { challengeId: row.id, signature: 'whatever' }),
      ProviderErrorCode.PROVIDER_STAKE_CHALLENGE_EXPIRED,
    );
  });

  it('refuses a challenge already consumed', async () => {
    const w = wallet();
    const row = challengeRow({ accountId: w.account, consumedAt: new Date() });
    const { service } = build({ challenge: row });

    await expectErrorCodeAsync(
      () => service.prove(session(), { challengeId: row.id, signature: 'whatever' }),
      ProviderErrorCode.PROVIDER_STAKE_CHALLENGE_ALREADY_USED,
    );
  });

  it('rejects a replay that loses the race at the database — CAS UPDATE affected 0 rows', async () => {
    const { row, signature } = provable();
    const { service } = build({ challenge: row, transactionOptions: { challengeAffected: 0 } });

    await expectErrorCodeAsync(
      () => service.prove(session(), { challengeId: row.id, signature }),
      ProviderErrorCode.PROVIDER_STAKE_CHALLENGE_ALREADY_USED,
    );
  });

  it('lets only one of two concurrent submissions win', async () => {
    const { row, signature } = provable();
    const { service } = build({ challenge: row });
    const body = { challengeId: row.id, signature };

    const [a, b] = await Promise.allSettled([
      service.prove(session(), body),
      service.prove(session(), body),
    ]);

    expect([a.status, b.status].sort()).toEqual(['fulfilled', 'rejected']);
  });

  it('a caller cannot use another organization’s challenge — the lookup is always scoped to the caller’s own', async () => {
    const { service, challenges } = build({ challenge: null });

    await expectErrorCodeAsync(
      () =>
        service.prove(session({ organizationId: OTHER_ORG }), {
          challengeId: 'challenge-1',
          signature: 'x',
        }),
      ProviderErrorCode.PROVIDER_STAKE_CHALLENGE_NOT_FOUND,
    );
    expect(challenges.findOneBy).toHaveBeenCalledWith({
      organizationId: OTHER_ORG,
      id: 'challenge-1',
    });
  });

  /**
   * The two closest messages on the platform. The adapter's own spec proves
   * the *adapter* refuses the crossover; these two prove the *service* does, because the service is
   * where an attacker who already holds a payout proof would aim it.
   */
  it('a signature over a payout-proof message does not verify as a stake-authority proof', async () => {
    const { row, wallet: w, challenge, solana } = provable();
    const asPayout: PayoutProofChallenge = {
      account: challenge.account,
      organizationId: challenge.organizationId,
      nonce: challenge.nonce,
      expiresAt: challenge.expiresAt,
    };
    const payoutSignature = signBytes(
      solana.buildPayoutProofMessage(asPayout),
      w.keyPair.privateKey,
    );
    const { service } = build({ challenge: row });

    await expectErrorCodeAsync(
      () => service.prove(session(), { challengeId: row.id, signature: payoutSignature }),
      ProviderErrorCode.PROVIDER_STAKE_SIGNATURE_INVALID,
    );
  });

  /**
   * The row is a genuine payout-address challenge that happens to sit in the
   * same table, and the signature over its message is genuine too. It is
   * refused on `message_version` alone, before any signature is looked at —
   * which is what makes the discriminator a check rather than a side effect of
   * the version tag differing inside the signed bytes.
   */
  it('a payout challenge row cannot be redeemed here at all — `message_version` is the discriminator', async () => {
    const w = wallet();
    const asPayout: PayoutProofChallenge = {
      account: w.account,
      organizationId: ORG,
      nonce: 'c'.repeat(64),
      expiresAt: Math.floor((Date.now() + 60_000) / 1000),
    };
    const solana = new SolanaChainAdapter(stubRpc(), [
      CHAIN_IDS.SOLANA_MAINNET,
      CHAIN_IDS.SOLANA_DEVNET,
    ]);
    const bytes = solana.buildPayoutProofMessage(asPayout);
    const signature = signBytes(bytes, w.keyPair.privateKey);
    const row = challengeRow({
      accountId: w.account,
      nonce: asPayout.nonce,
      message: new TextDecoder().decode(bytes),
      messageVersion: PAYOUT_PROOF_MESSAGE_VERSION,
      expiresAt: new Date(asPayout.expiresAt * 1000),
    });
    const { service, tx } = build({ challenge: row });

    await expectErrorCodeAsync(
      () => service.prove(session(), { challengeId: row.id, signature }),
      ProviderErrorCode.PROVIDER_STAKE_CHALLENGE_NOT_FOUND,
    );
    // Nothing was consumed: presenting a payout nonce here must not burn it.
    expect(tx.calls).toHaveLength(0);
  });

  it('reports a stake account another provider has already proved as a conflict, not a 500', async () => {
    const { row, signature } = provable();
    const { service } = build({
      challenge: row,
      transactionOptions: {
        providerError: uniqueViolation('uq_provider_chain_enrolments_stake_authority'),
      },
    });

    await expectErrorCodeAsync(
      () => service.prove(session(), { challengeId: row.id, signature }),
      ProviderErrorCode.PROVIDER_STAKE_AUTHORITY_ALREADY_CLAIMED,
    );
  });

  it('does not swallow an unrelated unique violation as "already claimed"', async () => {
    const { row, signature } = provable();
    const { service } = build({
      challenge: row,
      transactionOptions: {
        providerError: uniqueViolation('uq_provider_chain_enrolments_org_chain'),
      },
    });

    await expect(service.prove(session(), { challengeId: row.id, signature })).rejects.toThrow(
      /uq_provider_chain_enrolments_org_chain/,
    );
  });

  it('fails loudly if the enrolment vanished between the check and the write', async () => {
    // `affected === 0` on a row step 6 already read. Enrolments are never
    // deleted, so this cannot happen — and it is guarded anyway rather than
    // trusted, so a future change to that invariant fails here instead of
    // silently discarding a proved signature.
    const { row, signature } = provable();
    const { service } = build({ challenge: row, transactionOptions: { providerAffected: 0 } });

    await expectErrorCodeAsync(
      () => service.prove(session(), { challengeId: row.id, signature }),
      ProviderErrorCode.PROVIDER_CHAIN_NOT_ENROLLED,
    );
  });
});

/**
 * A proved stake authority may only be replaced once the account it
 * names is empty.
 *
 * The hole this closes is not a missing audit trail. The backend derives the
 * stake PDA from `providers.stake_authority` at the moment it needs it,
 * including when it builds a slash attestation, so a provider who saw a verdict
 * forming could re-prove a fresh pubkey whose PDA holds nothing, and the slash
 * would land on the empty account while the real collateral sat untouched in
 * the old one, withdrawable after unbonding. The stake gate's entire premise —
 * that defecting costs more than it earns — is false the moment that works.
 */
describe('ProviderStakeAuthorityService.prove — the old stake account must be empty first', () => {
  it('refuses rotation while the current stake account still holds bonded stake', async () => {
    const { row, signature } = provable();
    const { service } = build({
      provider: providerRow({ stakeAuthority: CURRENT_AUTHORITY }),
      challenge: row,
      onChainStake: reading({ bonded: 500_000_000n }),
    });

    await expectErrorCodeAsync(
      () => service.prove(session(), { challengeId: row.id, signature }),
      ProviderErrorCode.PROVIDER_STAKE_AUTHORITY_STILL_FUNDED,
    );
  });

  /**
   * Unbonding stake is still fully slashable for the whole period — that is the
   * point of the period. An account mid-unbonding is exactly the one a defector
   * wants to walk away from, so `bonded === 0` is not "exited".
   */
  it('refuses rotation while unbonding is non-zero', async () => {
    const { row, signature } = provable();
    const { service } = build({
      provider: providerRow({ stakeAuthority: CURRENT_AUTHORITY }),
      challenge: row,
      onChainStake: reading({ bonded: 0n, unbonding: 500_000_000n }),
    });

    await expectErrorCodeAsync(
      () => service.prove(session(), { challengeId: row.id, signature }),
      ProviderErrorCode.PROVIDER_STAKE_AUTHORITY_STILL_FUNDED,
    );
  });

  /**
   * The common case, and the one that must not regress: a provider proving for
   * the first time has no old account, so there is nothing to check and no RPC
   * to pay for. A gate that made every first-time proof depend on a reachable
   * chain would have turned an RPC outage into "nobody can onboard".
   */
  it('allows the FIRST proof — there is no current authority, so nothing to check', async () => {
    const { row, signature, wallet: w } = provable();
    const { service, reader } = build({
      provider: providerRow({ stakeAuthority: null }),
      challenge: row,
      readerError: new Error('the chain must not be consulted at all here'),
    });

    const result = await service.prove(session(), { challengeId: row.id, signature });

    expect(result.stakeAuthority).toBe(w.account);
    expect(reader.bondedStakeOf).not.toHaveBeenCalled();
  });

  it('allows rotation once the old account is fully exited', async () => {
    const { row, signature, wallet: w } = provable();

    // No account at those seeds — the provider withdrew and closed it. The port
    // reports that as an absence from the map, never as a zero.
    const closed = build({
      provider: providerRow({ stakeAuthority: CURRENT_AUTHORITY }),
      challenge: row,
    });
    await expect(
      closed.service.prove(session(), { challengeId: row.id, signature }),
    ).resolves.toMatchObject({ stakeAuthority: w.account });
    expect(closed.reader.bondedStakeOf).toHaveBeenCalledWith([CURRENT_AUTHORITY]);

    // The account still exists but every balance on it is zero. Same answer.
    const drained = build({
      provider: providerRow({ stakeAuthority: CURRENT_AUTHORITY }),
      challenge: row,
      onChainStake: reading(),
    });
    await expect(
      drained.service.prove(session(), { challengeId: row.id, signature }),
    ).resolves.toMatchObject({ stakeAuthority: w.account });
  });

  /**
   * Fail CLOSED. "We could not read the old PDA" must never resolve to "it was
   * probably empty" — that is the escape hatch reopening itself, and an
   * attacker who can degrade one RPC endpoint would have re-earned free
   * rotation.
   *
   * And fail closed *legibly*. An RPC failure inside the reader is an ordinary
   * `Error`, which the exception filter renders as a bare
   * `500 Internal server error` outside development — a refusal with no cause
   * and no remedy, which the provider cannot act on. The status and the cause
   * are asserted here because they are the difference between "try again in a
   * minute" and a support ticket.
   */
  it('refuses rotation when the chain cannot be read, as a 503 that names the cause', async () => {
    const { row, signature } = provable();
    const { service, tx } = build({
      provider: providerRow({ stakeAuthority: CURRENT_AUTHORITY }),
      challenge: row,
      readerError: new Error('rpc unreachable'),
    });

    const error = await rejection(() =>
      service.prove(session(), { challengeId: row.id, signature }),
    );

    expect(error.errorCode).toBe(ProviderErrorCode.PROVIDER_STAKE_AUTHORITY_CHECK_UNAVAILABLE);
    expect(error.statusCode).toBe(503);
    expect(error.message).toContain('rpc unreachable');
    expect(error.message).toContain(CURRENT_AUTHORITY);
    // Still a refusal: nothing was written and the nonce is still spendable.
    expect(tx.calls).toHaveLength(0);
  });

  /**
   * A refusal is not a spend. The provider exits the old account and retries
   * with the same challenge, as long as it has not expired — burning the nonce
   * on a refusal would make the remedy require a second round trip to the
   * console for no security gain.
   */
  it('does not consume the challenge nonce when the rotation is refused', async () => {
    const { row, signature } = provable();
    const { service, tx, dataSource } = build({
      provider: providerRow({ stakeAuthority: CURRENT_AUTHORITY }),
      challenge: row,
      onChainStake: reading({ bonded: 1n }),
    });

    await expectErrorCodeAsync(
      () => service.prove(session(), { challengeId: row.id, signature }),
      ProviderErrorCode.PROVIDER_STAKE_AUTHORITY_STILL_FUNDED,
    );

    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(tx.calls).toHaveLength(0);
  });

  /**
   * Re-proving the **same** authority is deliberately not carved out: the rule
   * is about the account, not about which key is being written. A same-key
   * re-prove achieves nothing the stored trio does not already record, and the
   * carve-out would be one more branch guarding one more equality on the single
   * path whose whole job is to be hard to get past.
   *
   * Unexercised until now, and invisibly so — `provable()` mints a fresh wallet
   * every call, so the incoming account was never the current one in any of the
   * tests above. The provider row is pointed at this run's own wallet on
   * purpose.
   */
  it('refuses even a re-prove of the SAME authority while that account is funded', async () => {
    const { row, signature, wallet: w } = provable();
    const { service, tx, reader } = build({
      provider: providerRow({ stakeAuthority: w.account }),
      challenge: row,
      onChainStake: reading({ bonded: 1n }),
    });

    await expectErrorCodeAsync(
      () => service.prove(session(), { challengeId: row.id, signature }),
      ProviderErrorCode.PROVIDER_STAKE_AUTHORITY_STILL_FUNDED,
    );
    // The account checked is the one already proved, which here is also the one
    // being proved — the gate does not shortcut on them being equal.
    expect(reader.bondedStakeOf).toHaveBeenCalledWith([w.account]);
    expect(tx.calls).toHaveLength(0);
  });

  /**
   * The refusal's prose, not just its code.
   *
   * A provider reads this while confused about why a key change was rejected,
   * and the balance blocking them is the one fact that turns the message into
   * an action. Asserting only the code would let the number drift, disappear or
   * start naming the wrong thing without a single test noticing.
   */
  it('tells the provider how much is left, naming the asset once and as a symbol', async () => {
    const { row, signature } = provable();
    const { service } = build({
      provider: providerRow({ stakeAuthority: CURRENT_AUTHORITY }),
      challenge: row,
      onChainStake: reading({ bonded: 500_000_000n, unbonding: 1_000_000n }),
    });

    const { message } = await rejection(() =>
      service.prove(session(), { challengeId: row.id, signature }),
    );

    expect(message).toContain('501.000000 USDC remaining');
    expect(message).toContain('bonded 500.000000');
    expect(message).toContain('unbonding 1.000000');
    // Which account to empty, and no raw CAIP-19 anywhere: `token:EPjFWdd5…` is
    // noise in a sentence where `USDC` is the information.
    expect(message).toContain(CURRENT_AUTHORITY);
    expect(message).not.toContain('token:');
  });
});

describe('ProviderStakeAuthorityService.prove, with the wallet blocked', () => {
  it('refuses to make a blocked wallet a stake authority, before checking the signature', async () => {
    const w = wallet();
    const row = challengeRow({ accountId: w.account });
    const { service, tx } = build({
      challenge: row,
      blocklist: blocklistOf({ kind: BlockSubjectKind.WALLET, subject: w.account }),
    });

    await expect(
      service.prove(session(), { challengeId: row.id, signature: 'not-checked' }),
    ).rejects.toMatchObject({
      errorCode: AccountErrorCode.ACCOUNT_BLOCKED,
      context: { role: BlockedRole.STAKE_AUTHORITY },
    });
    expect(tx.calls).toHaveLength(0);
  });
});
