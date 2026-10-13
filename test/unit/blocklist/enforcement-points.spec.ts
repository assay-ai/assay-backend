import { randomUUID } from 'node:crypto';

import { AccountErrorCode } from '@modules/account/errors/account.errors';
import { AccountBlockStatusService } from '@modules/account/services/account-block-status.service';
import { BlockedRole, BlockSubjectKind } from '@modules/blocklist/domain/account-block';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { AccountId, ChainId, CHAIN_IDS } from '@modules/chains/ports/caip.types';
import { McpCallerKind, McpSession } from '@modules/mcp/ports/mcp-session.port';
import {
  CreatePaymentIntentInput,
  PaymentIntentCallClass,
  PaymentRail,
} from '@modules/payment/ports/payment.types';
import { EscrowSeqService } from '@modules/payment/services/escrow-seq.service';
import { PaymentIntentService } from '@modules/payment/services/payment-intent.service';
import { MoneyUtil } from '@shared/utils/money.util';

import { addBlock, blocklistOf, SeededBlock } from '../helpers/blocklist';
import { createVoucherHarness, PROVIDER } from '../payment/helpers/voucher-harness';

/**
 * The enforcement points that are not a session: every place a payment, a
 * voucher seq or a redemption names a party, refusing a blocked one before
 * anything is written. The session refusals are in
 * `blocklist-session.source.spec.ts`; routing, the catalogue, stake and payout
 * proofs and the redemption worker are tested beside their own services.
 */
const CHAIN = CHAIN_IDS.SOLANA_DEVNET as ChainId;
const ASSET = ASSET_IDS.USDC_SOLANA_DEVNET;
const ORG = '08773f92-21cd-4e53-8348-d3ef1dcc8378';
const PROVIDER_ORG = 'b7c4e1a0-3f28-4d55-9c61-2a8e5f0d4b39';
const PAYER = `${CHAIN}:AgentTestOrgAWalletAddress11111` as AccountId;
const PAYEE = `${CHAIN}:ProviderPayoutWalletAddress2222` as AccountId;
const DELEGATE = `${CHAIN}:DelegateKeyWalletAddress333333` as AccountId;

describe('PaymentIntentService.create, with a party blocked', () => {
  function build(...blocks: SeededBlock[]) {
    const intents = { insert: jest.fn(), insertAdmittedVoucherIntent: jest.fn() };
    const service = new PaymentIntentService(
      intents as never,
      {} as never,
      {} as never,
      blocklistOf(...blocks),
    );
    return { service, intents };
  }

  const input: CreatePaymentIntentInput = {
    organizationId: ORG,
    agentId: randomUUID(),
    agentAccount: PAYER,
    providerId: PROVIDER_ORG,
    providerAccount: PAYEE,
    toolId: randomUUID(),
    rail: PaymentRail.RAIL_B_VOUCHER,
    callId: randomUUID(),
    callClass: PaymentIntentCallClass.PAID,
    price: MoneyUtil.of('1000000', ASSET, 6),
    platformFee: MoneyUtil.of('200000', ASSET, 6),
    requestHash: `sha256:${'ab'.repeat(32)}`,
    chainId: CHAIN,
    voucherDelegate: DELEGATE,
  };

  it.each<[string, SeededBlock, BlockedRole]>([
    [
      'the payer’s organization',
      { kind: BlockSubjectKind.ORGANIZATION, subject: ORG },
      BlockedRole.ORGANIZATION,
    ],
    ['the payer’s account', { kind: BlockSubjectKind.WALLET, subject: PAYER }, BlockedRole.PAYER],
    [
      'the provider',
      { kind: BlockSubjectKind.ORGANIZATION, subject: PROVIDER_ORG },
      BlockedRole.PROVIDER,
    ],
    ['the payout account', { kind: BlockSubjectKind.WALLET, subject: PAYEE }, BlockedRole.PAYEE],
    ['the delegate', { kind: BlockSubjectKind.WALLET, subject: DELEGATE }, BlockedRole.DELEGATE],
  ])('refuses an intent when %s is blocked, and inserts nothing', async (_label, block, role) => {
    const { service, intents } = build(block);

    await expect(service.create(input)).rejects.toMatchObject({
      errorCode: AccountErrorCode.ACCOUNT_BLOCKED,
      statusCode: 403,
      context: { role },
    });
    expect(intents.insert).not.toHaveBeenCalled();
    expect(intents.insertAdmittedVoucherIntent).not.toHaveBeenCalled();
  });
});

describe('EscrowSeqService.allocate, with the payer blocked', () => {
  it.each<[string, SeededBlock]>([
    ['organization', { kind: BlockSubjectKind.ORGANIZATION, subject: ORG }],
    ['account', { kind: BlockSubjectKind.WALLET, subject: PAYER }],
  ])('hands no voucher seq to a blocked %s', async (_label, block) => {
    const escrows = {
      bumpNextSeqTo: jest.fn(),
      peekNextSeq: jest.fn(),
      allocateNextSeq: jest.fn(),
    };
    const service = new EscrowSeqService(escrows as never, {} as never, blocklistOf(block));

    await expect(service.allocate(ORG, PAYER, 5n)).rejects.toMatchObject({
      errorCode: AccountErrorCode.ACCOUNT_BLOCKED,
    });
    expect(escrows.bumpNextSeqTo).not.toHaveBeenCalled();
  });
});

describe('VoucherService.redeem, with a party blocked', () => {
  it('refuses a voucher whose payer is blocked, only AFTER its signature is checked', async () => {
    const blocklist = blocklistOf();
    const harness = createVoucherHarness(blocklist);
    addBlock(blocklist, { kind: BlockSubjectKind.WALLET, subject: harness.payer });
    const verify = jest.spyOn(harness.adapter, 'verifyVoucherSignature');
    const { input } = harness.voucherFor();

    await expect(harness.service.redeem(input)).rejects.toMatchObject({
      errorCode: AccountErrorCode.ACCOUNT_BLOCKED,
      context: { role: BlockedRole.PAYER },
    });
    expect(verify).toHaveBeenCalled();
    expect(harness.intents.created).toHaveLength(0);
  });

  it('AUDIT E-10: is not a blocklist oracle — a bad signature on a blocked wallet says bad signature', async () => {
    const blocklist = blocklistOf();
    const harness = createVoucherHarness(blocklist);
    addBlock(blocklist, { kind: BlockSubjectKind.WALLET, subject: harness.payer });
    const { signed, input } = harness.voucherFor();
    const forged = { ...input, signed: { voucher: signed.voucher, signature: '1'.repeat(88) } };

    const refusal = await harness.service.redeem(forged).catch((error: unknown) => error);
    expect(refusal).toMatchObject({ errorCode: expect.any(String) });
    expect((refusal as { errorCode: string }).errorCode).not.toBe(AccountErrorCode.ACCOUNT_BLOCKED);
  });

  it('AUDIT E-10: a voucher naming someone else’s blocked wallet fails the session binding first', async () => {
    const blocklist = blocklistOf({ kind: BlockSubjectKind.WALLET, subject: PROVIDER });
    const harness = createVoucherHarness(blocklist);
    const { signed, input } = harness.voucherFor();
    // The session's payer is not the wallet the voucher names.
    const probe = {
      ...input,
      signed: { ...signed, voucher: { ...signed.voucher, payer: PROVIDER } },
    };
    const refusal = await harness.service.redeem(probe as never).catch((error: unknown) => error);
    expect((refusal as { errorCode: string }).errorCode).not.toBe(AccountErrorCode.ACCOUNT_BLOCKED);
  });

  it('refuses a voucher that pays a blocked provider account', async () => {
    const harness = createVoucherHarness(
      blocklistOf({ kind: BlockSubjectKind.WALLET, subject: PROVIDER }),
    );
    const { input } = harness.voucherFor();

    await expect(harness.service.redeem(input)).rejects.toMatchObject({
      errorCode: AccountErrorCode.ACCOUNT_BLOCKED,
      context: { role: BlockedRole.PAYEE },
    });
    expect(harness.intents.created).toHaveLength(0);
  });

  it('still redeems when nobody is blocked', async () => {
    const harness = createVoucherHarness(blocklistOf());
    const { input } = harness.voucherFor();

    await expect(harness.service.redeem(input)).resolves.toBeDefined();
  });
});

describe('AccountBlockStatusService', () => {
  const session = (overrides: Partial<McpSession> = {}): McpSession => ({
    credentialId: 'cred',
    organizationId: ORG,
    agentId: 'agent',
    agentAccount: PAYER,
    chainId: CHAIN,
    label: null,
    callerKind: McpCallerKind.HUMAN,
    delegateAccount: DELEGATE,
    ...overrides,
  });

  it('reports every block that applies, without the operator’s note', () => {
    const service = new AccountBlockStatusService(
      blocklistOf(
        { kind: BlockSubjectKind.ORGANIZATION, subject: ORG, reasonCode: 'FRAUD' },
        { kind: BlockSubjectKind.WALLET, subject: DELEGATE, reasonCode: 'LEAKED_KEY' },
      ),
    );

    const status = service.statusOf(session());

    expect(status.blocked).toBe(true);
    expect(status.blocks).toEqual([
      expect.objectContaining({
        role: BlockedRole.ORGANIZATION,
        subjectKind: BlockSubjectKind.ORGANIZATION,
        subject: ORG,
        reasonCode: 'FRAUD',
      }),
      expect.objectContaining({ role: BlockedRole.DELEGATE, reasonCode: 'LEAKED_KEY' }),
    ]);
    expect(Object.keys(status.blocks[0]).sort()).toEqual(
      ['blockedAt', 'reasonCode', 'role', 'subject', 'subjectKind'].sort(),
    );
  });

  it('says not blocked when nothing applies', () => {
    const service = new AccountBlockStatusService(blocklistOf());
    expect(service.statusOf(session())).toEqual({ blocked: false, blocks: [] });
  });
});
