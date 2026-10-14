import { generateKeyPairSync, sign } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

import { ProviderPayoutChallengeRepository } from '@database/postgres/repositories/provider-payout-challenge.repository';
import { ProviderRepository } from '@database/postgres/repositories/provider.repository';
import { getBase58Decoder } from '@solana/kit';

import { ChainAdapterRegistry } from '@modules/chains/chain-adapter.registry';
import { ChainErrorCode } from '@modules/chains/errors/chains.errors';
import { AccountId, CHAIN_IDS, chainIdOf } from '@modules/chains/ports/caip.types';
import { PayoutProofChallenge } from '@modules/chains/ports/payout-proof.types';
import { Voucher } from '@modules/chains/ports/x402.types';
import { SolanaChainAdapter, SolanaRpcClient } from '@modules/chains/solana/solana-chain.adapter';
import { PAYOUT_PROOF_MESSAGE_VERSION } from '@modules/chains/solana/solana.constants';
import { McpCallerKind, McpSession } from '@modules/mcp/ports/mcp-session.port';
import { ProviderErrorCode } from '@modules/provider/errors/provider.errors';
import { ChainEnrolmentStatus } from '@modules/provider/ports/chain-enrolment.port';
import { ProviderPayoutAddressService } from '@modules/provider/services/provider-payout-address.service';
import { AuditLogWriter } from '@shared/audit';
import { MoneyUtil } from '@shared/utils/money.util';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';
import { AccountErrorCode } from '@modules/account/errors/account.errors';
import { BlockedRole, BlockSubjectKind } from '@modules/blocklist/domain/account-block';
import { AccountBlocklistService } from '@modules/blocklist/services/account-blocklist.service';

import { blocklistOf, noBlocks } from '../helpers/blocklist';

const SOLANA_MAINNET = CHAIN_IDS.SOLANA_MAINNET;
const ORG = 'org-11111111-1111-4111-8111-111111111111';
const OTHER_ORG = 'org-22222222-2222-4222-8222-222222222222';
const CREDENTIAL = 'cred-console-1';

const usdc = (amount: string) =>
  MoneyUtil.of(
    amount,
    `${SOLANA_MAINNET}/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` as never,
    6,
  );

function session(overrides: Partial<McpSession> = {}): McpSession {
  return {
    credentialId: CREDENTIAL,
    organizationId: ORG,
    agentId: 'agent-1',
    agentAccount: `${SOLANA_MAINNET}:11111111111111111111111111111112` as AccountId,
    chainId: SOLANA_MAINNET,
    label: null,
    callerKind: McpCallerKind.CONFIG,
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
    messageVersion: PAYOUT_PROOF_MESSAGE_VERSION,
    channel: 'CONSOLE',
    expiresAt: new Date(now + 10 * 60 * 1000),
    consumedAt: null as Date | null,
    issuedTo: CREDENTIAL,
    ...overrides,
  };
}

/**
 * One statement the service issued on the transaction's manager.
 *
 * Both shapes in one type because `prove()` issues one of each: a CAS `UPDATE`
 * on the challenge and an upsert `INSERT` on the enrolment.
 */
interface RecordedStatement {
  entity: string;
  op: 'update' | 'insert';
  set: unknown;
  values: unknown;
  conflict: unknown;
  wheres: string[];
}

/** `manager.createQueryBuilder().update(Entity)|.insert()...execute()`, in issue order. */
function fakeManager(options: { challengeAffected?: number; previousPayoutAccountId?: string }) {
  const calls: RecordedStatement[] = [];

  const manager = {
    // The enrolment as it was before the upsert, read for the audit entry.
    findOne: jest.fn(async () =>
      options.previousPayoutAccountId ? { payoutAccountId: options.previousPayoutAccountId } : null,
    ),
    createQueryBuilder() {
      return {
        update(entity: { name: string }) {
          const record: RecordedStatement = {
            entity: entity.name,
            op: 'update',
            set: undefined,
            values: undefined,
            conflict: undefined,
            wheres: [],
          };
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
              return { affected: options.challengeAffected ?? 1 };
            },
          };
          return builder;
        },
        // The payout address is now UPSERTED onto the enrolment
        // rather than UPDATEd onto `providers`, so the fake has to be able to
        // record an insert. The conflict target and the update list are
        // recorded and asserted: a plain insert would produce a second
        // enrolment for a chain the provider is already on, which is the
        // "two answers to where do I get paid" per-chain enrolment removes.
        insert() {
          const record: RecordedStatement = {
            entity: '',
            op: 'insert',
            set: undefined,
            values: undefined,
            conflict: undefined,
            wheres: [],
          };
          calls.push(record);
          const builder: any = {
            into(entity: { name: string }) {
              record.entity = entity.name;
              return builder;
            },
            values(v: unknown) {
              record.values = v;
              return builder;
            },
            orUpdate(overwrite: string[], conflictTarget: string[]) {
              record.conflict = { overwrite, conflictTarget };
              return builder;
            },
            async execute() {
              return { identifiers: [{ id: 'enrolment-new' }] };
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
    blocklist?: AccountBlocklistService;
  } = {},
) {
  const providers = {
    findOneBy: jest
      .fn()
      .mockResolvedValue(options.provider === undefined ? providerRow() : options.provider),
  } as unknown as ProviderRepository;

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

  const audit = { record: jest.fn(async () => undefined) };

  const service = new ProviderPayoutAddressService(
    providers,
    challenges,
    chains,
    config,
    dataSource,
    options.blocklist ?? noBlocks(),
    audit as unknown as AuditLogWriter,
  );
  return { service, providers, challenges, chains, dataSource, tx, audit };
}

describe('ProviderPayoutAddressService.issueChallenge', () => {
  it('refuses to issue a challenge with no provider row for this organization', async () => {
    const { service } = build({ provider: null });

    await expectErrorCodeAsync(
      () =>
        service.issueChallenge(session(), {
          chainId: SOLANA_MAINNET,
          address: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
        }),
      ProviderErrorCode.PROVIDER_NOT_FOUND,
    );
  });

  it('scopes the provider lookup to the caller’s own organization', async () => {
    const { service, providers } = build();

    await service.issueChallenge(session(), {
      chainId: SOLANA_MAINNET,
      address: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
    });

    expect(providers.findOneBy).toHaveBeenCalledWith({ organizationId: ORG });
  });

  it('issues a nonce, builds the signed message through the adapter, and persists a CONSOLE-only challenge', async () => {
    const { service, challenges } = build();

    const response = await service.issueChallenge(session(), {
      chainId: SOLANA_MAINNET,
      address: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
    });

    expect(response.nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(response.messageVersion).toBe(PAYOUT_PROOF_MESSAGE_VERSION);
    expect(response.message.startsWith(PAYOUT_PROOF_MESSAGE_VERSION)).toBe(true);
    expect(response.accountId).toBe(
      `${SOLANA_MAINNET}:7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU`,
    );
    expect(response.expiresAt.getTime()).toBeGreaterThan(Date.now());

    expect(challenges.save).toHaveBeenCalledTimes(1);
    const saved = (challenges.save as jest.Mock).mock.calls[0][0];
    expect(saved.organizationId).toBe(ORG);
    expect(saved.channel).toBe('CONSOLE');
    expect(saved.issuedTo).toBe(CREDENTIAL);
    expect(saved.consumedAt).toBeNull();
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

describe('ProviderPayoutAddressService.prove', () => {
  it('the headline case: proves a payout address with a genuine signature from the claimed wallet', async () => {
    const w = wallet();
    const challenge: PayoutProofChallenge = {
      account: w.account,
      organizationId: ORG,
      nonce: 'b'.repeat(64),
      expiresAt: Math.floor((Date.now() + 60_000) / 1000),
    };
    const solana = new SolanaChainAdapter(stubRpc(), [
      CHAIN_IDS.SOLANA_MAINNET,
      CHAIN_IDS.SOLANA_DEVNET,
    ]);
    const message = new TextDecoder().decode(solana.buildPayoutProofMessage(challenge));
    const signature = signBytes(solana.buildPayoutProofMessage(challenge), w.keyPair.privateKey);

    const row = challengeRow({
      accountId: w.account,
      nonce: challenge.nonce,
      message,
      expiresAt: new Date(challenge.expiresAt * 1000),
    });
    const { service, providers, tx } = build({ challenge: row });

    const result = await service.prove(session(), { challengeId: row.id, signature });

    expect(result.payoutAccountId).toBe(w.account);
    expect(result.proof.challengeId).toBe(row.id);
    expect(result.proof.signature).toBe(signature);
    expect(result.proof.messageVersion).toBe(row.messageVersion);

    // Both writes happened, atomically, on the transaction's own manager.
    expect(tx.calls).toHaveLength(2);
    expect(tx.calls[0].entity).toBe('ProviderPayoutChallengeEntity');
    // Onto the ENROLMENT, not onto `providers`, and keyed on the
    // chain the proved address is on rather than on a deployment default.
    expect(tx.calls[1].entity).toBe('ProviderChainEnrolmentEntity');
    expect(tx.calls[1].op).toBe('insert');
    expect(tx.calls[1].values).toMatchObject({
      organizationId: ORG,
      chainId: chainIdOf(w.account),
      payoutAccountId: w.account,
      status: ChainEnrolmentStatus.ACTIVE,
    });
    // An upsert, not an insert: re-proving on a chain already enrolled updates
    // that one row. `uq_provider_chain_enrolments_org_chain` is the conflict
    // target, and `status`/`enrolled_at` are deliberately NOT overwritten — a
    // suspended provider must not re-open their own enrolment by signing.
    expect(tx.calls[1].conflict).toEqual({
      overwrite: ['payout_account_id', 'payout_proof', 'payout_proved_at'],
      conflictTarget: ['organization_id', 'chain_id'],
    });
    expect(providers.findOneBy).not.toHaveBeenCalled(); // prove() never re-reads the provider row
  });

  // Review A-1: a payout address that changed without a trace was found only
  // when a payout went missing. The change is recorded in the owner's audit
  // log, in the same transaction as the write, with the address it replaced.
  it('records the change, old and new address, in the audit log on the same transaction', async () => {
    const w = wallet();
    const previous = wallet().account;
    const challenge: PayoutProofChallenge = {
      account: w.account,
      organizationId: ORG,
      nonce: 'c'.repeat(64),
      expiresAt: Math.floor((Date.now() + 60_000) / 1000),
    };
    const solana = new SolanaChainAdapter(stubRpc(), [
      CHAIN_IDS.SOLANA_MAINNET,
      CHAIN_IDS.SOLANA_DEVNET,
    ]);
    const signature = signBytes(solana.buildPayoutProofMessage(challenge), w.keyPair.privateKey);
    const row = challengeRow({
      accountId: w.account,
      nonce: challenge.nonce,
      message: new TextDecoder().decode(solana.buildPayoutProofMessage(challenge)),
      expiresAt: new Date(challenge.expiresAt * 1000),
    });
    const { service, tx, audit } = build({
      challenge: row,
      transactionOptions: { previousPayoutAccountId: previous },
    });

    await service.prove(session(), { challengeId: row.id, signature });

    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(tx.manager, {
      organizationId: ORG,
      actor: { type: 'user', id: session().credentialId },
      action: 'payout_address.updated',
      resourceType: 'provider_chain_enrolment',
      resourceId: chainIdOf(w.account),
      before: { payoutAccountId: previous },
      after: { payoutAccountId: w.account },
    });
  });

  it('the headline test: rejects a genuine signature from a different wallet than the one claimed', async () => {
    const claimed = wallet();
    const attacker = wallet();
    const challenge: PayoutProofChallenge = {
      account: claimed.account,
      organizationId: ORG,
      nonce: 'c'.repeat(64),
      expiresAt: Math.floor((Date.now() + 60_000) / 1000),
    };
    const solana = new SolanaChainAdapter(stubRpc(), [
      CHAIN_IDS.SOLANA_MAINNET,
      CHAIN_IDS.SOLANA_DEVNET,
    ]);
    const message = new TextDecoder().decode(solana.buildPayoutProofMessage(challenge));
    // Signed by the attacker's key, not the claimed wallet's.
    const signature = signBytes(
      solana.buildPayoutProofMessage(challenge),
      attacker.keyPair.privateKey,
    );

    const row = challengeRow({
      accountId: claimed.account,
      nonce: challenge.nonce,
      message,
      expiresAt: new Date(challenge.expiresAt * 1000),
    });
    const { service } = build({ challenge: row });

    await expectErrorCodeAsync(
      () => service.prove(session(), { challengeId: row.id, signature }),
      ProviderErrorCode.PROVIDER_PAYOUT_SIGNATURE_INVALID,
    );
  });

  it('rejects an expired challenge', async () => {
    const w = wallet();
    const row = challengeRow({ accountId: w.account, expiresAt: new Date(Date.now() - 1000) });
    const { service } = build({ challenge: row });

    await expectErrorCodeAsync(
      () => service.prove(session(), { challengeId: row.id, signature: 'whatever' }),
      ProviderErrorCode.PROVIDER_PAYOUT_CHALLENGE_EXPIRED,
    );
  });

  it('rejects a challenge that has already been consumed', async () => {
    const w = wallet();
    const row = challengeRow({ accountId: w.account, consumedAt: new Date() });
    const { service } = build({ challenge: row });

    await expectErrorCodeAsync(
      () => service.prove(session(), { challengeId: row.id, signature: 'whatever' }),
      ProviderErrorCode.PROVIDER_PAYOUT_CHALLENGE_ALREADY_USED,
    );
  });

  it('rejects a replay that loses the race at the database — CAS UPDATE affected 0 rows', async () => {
    const w = wallet();
    const challenge: PayoutProofChallenge = {
      account: w.account,
      organizationId: ORG,
      nonce: 'd'.repeat(64),
      expiresAt: Math.floor((Date.now() + 60_000) / 1000),
    };
    const solana = new SolanaChainAdapter(stubRpc(), [
      CHAIN_IDS.SOLANA_MAINNET,
      CHAIN_IDS.SOLANA_DEVNET,
    ]);
    const message = new TextDecoder().decode(solana.buildPayoutProofMessage(challenge));
    const signature = signBytes(solana.buildPayoutProofMessage(challenge), w.keyPair.privateKey);

    const row = challengeRow({
      accountId: w.account,
      nonce: challenge.nonce,
      message,
      expiresAt: new Date(challenge.expiresAt * 1000),
      consumedAt: null, // the in-memory read still says "open"
    });
    const { service } = build({ challenge: row, transactionOptions: { challengeAffected: 0 } });

    await expectErrorCodeAsync(
      () => service.prove(session(), { challengeId: row.id, signature }),
      ProviderErrorCode.PROVIDER_PAYOUT_CHALLENGE_ALREADY_USED,
    );
  });

  it('a caller cannot use another organization’s challenge — the lookup is always scoped to the caller’s own', async () => {
    const { service, challenges } = build({ challenge: null });

    await expectErrorCodeAsync(
      () =>
        service.prove(session({ organizationId: OTHER_ORG }), {
          challengeId: 'challenge-1',
          signature: 'x',
        }),
      ProviderErrorCode.PROVIDER_PAYOUT_CHALLENGE_NOT_FOUND,
    );
    expect(challenges.findOneBy).toHaveBeenCalledWith({
      organizationId: OTHER_ORG,
      id: 'challenge-1',
    });
  });

  // The "a signature over a withdrawal-authorization message does not verify
  // as a payout proof" cross-check is gone with it: per-buyer escrows deleted the
  // withdrawal-authorization message entirely (`buildWithdrawalMessage` /
  // `verifyWithdrawalSignature`) — the buyer's exit is now a chain
  // transaction the buyer signs directly, with no off-chain message to
  // confuse this one with. See `ChainAdapter`'s class comment on
  // `buildPayoutProofMessage`.

  it('a signature over a voucher message does not verify as a payout proof', async () => {
    const w = wallet();
    const challenge: PayoutProofChallenge = {
      account: w.account,
      organizationId: ORG,
      nonce: 'f'.repeat(64),
      expiresAt: Math.floor((Date.now() + 60_000) / 1000),
    };
    // Voucher v2 signs the DEPLOYED program id at offset 15, so the adapter
    // needs one to build a message at all.
    const solana = new SolanaChainAdapter(
      stubRpc(),
      [CHAIN_IDS.SOLANA_MAINNET, CHAIN_IDS.SOLANA_DEVNET],
      'PR5bEscrowRedep1oyment11111111111111111111z',
    );
    const message = new TextDecoder().decode(solana.buildPayoutProofMessage(challenge));

    const asVoucher: Voucher = {
      payer: w.account,
      payTo: w.account,
      provider: w.account,
      amount: usdc('1'),
      resource: 'https://api.platform.io/tools/search_web',
      requestHash: `sha256:${'a3f1c0de'.repeat(8)}`,
      seq: '1',
      issuedAt: challenge.expiresAt - 200,
      expiresAt: challenge.expiresAt,
    };
    const voucherSignature = signBytes(solana.buildVoucherMessage(asVoucher), w.keyPair.privateKey);

    const row = challengeRow({
      accountId: w.account,
      nonce: challenge.nonce,
      message,
      expiresAt: new Date(challenge.expiresAt * 1000),
    });
    const { service } = build({ challenge: row });

    await expectErrorCodeAsync(
      () => service.prove(session(), { challengeId: row.id, signature: voucherSignature }),
      ProviderErrorCode.PROVIDER_PAYOUT_SIGNATURE_INVALID,
    );
  });
});

describe('ProviderPayoutAddressService.prove, with the wallet blocked', () => {
  it('refuses to make a blocked wallet a payout address, before checking the signature', async () => {
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
      context: { role: BlockedRole.PAYEE },
    });
    expect(tx.calls).toHaveLength(0);
  });
});
