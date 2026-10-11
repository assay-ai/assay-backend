import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';

import { getBase58Decoder } from '@solana/kit';

import { ChainAdapterRegistry } from '@modules/chains/chain-adapter.registry';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { AccountId, CHAIN_IDS } from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';
import { Voucher } from '@modules/chains/ports/x402.types';
import { SolanaChainAdapter } from '@modules/chains/solana/solana-chain.adapter';
import { computeRequestHash } from '@modules/payment/domain/request-hash';
import { PaymentErrors } from '@modules/payment/errors/payment.errors';
import {
  CreatePaymentIntentInput,
  PaymentIntent,
  PaymentIntentStatus,
} from '@modules/payment/ports/payment.types';
import { RedeemVoucherInput, SignedVoucher } from '@modules/payment/ports/voucher.types';
import { EscrowSeqService } from '@modules/payment/services/escrow-seq.service';
import {
  PaymentIntentService,
  VoucherAdmission,
} from '@modules/payment/services/payment-intent.service';
import { VoucherService } from '@modules/payment/services/voucher.service';
import { MoneyUtil } from '@shared/utils/money.util';

export const SOLANA_MAINNET = CHAIN_IDS.SOLANA_MAINNET;
export const USDC = ASSET_IDS.USDC_SOLANA_MAINNET;
export const USDC_DECIMALS = 6;

export const usdc = (atomic: bigint | string): Money => MoneyUtil.of(atomic, USDC, USDC_DECIMALS);

/** The escrow PDA the platform advertises as `payTo` for this harness's payer. */
export const ESCROW_PDA: AccountId =
  `${SOLANA_MAINNET}:H9ityXJKWiwTni6DD5kEA1Hrqi4CSkBU4RyPx1FyHqPp` as AccountId;

/** A different escrow PDA — never this session's — for the redirection cases. */
export const OTHER_ESCROW: AccountId =
  `${SOLANA_MAINNET}:11111111111111111111111111111112` as AccountId;

export const PROVIDER: AccountId =
  `${SOLANA_MAINNET}:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM` as AccountId;

/** A provider the router did not choose, for the redirection case. */
export const OTHER_PROVIDER: AccountId =
  `${SOLANA_MAINNET}:5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1` as AccountId;

export const RESOURCE = 'https://api.x402.dev/tools/weather-now';

/**
 * The address the settlement program is deployed to for this harness.
 *
 * Voucher v2 signs the program id at offset 15, and `buildVoucherMessage`
 * refuses to build without one — deliberately, because a default to the
 * client's compiled-in `declare_id!()` would have every buyer sign for a
 * program that is not the one about to check the signature.
 */
export const DEPLOYED_PROGRAM_ID = 'PR5bEscrowRedep1oyment11111111111111111111z';

/**
 * A whole rail-B redemption path assembled out of real parts, with exactly two
 * substitutions.
 *
 * The signature check is the **real** `SolanaChainAdapter` over **real**
 * ed25519 keys, because a fake that returns `true` would make every test in the
 * suite pass while proving nothing about binding. The seq allocator and the
 * intent writer are in-memory, because what they stand in for — the
 * `buyer_escrows.next_seq` high-water mark and a Postgres unique index — are
 * properties of those systems and are tested against the real ones in
 * `test/integration/payment/voucher.integration.spec.ts`.
 */
export interface VoucherHarness {
  readonly service: VoucherService;
  /** The real adapter behind the registry, for a test that spies on what it was asked. */
  readonly adapter: SolanaChainAdapter;
  readonly seqs: FakeEscrowSeqService;
  readonly intents: InMemoryIntentWriter;
  readonly payer: AccountId;
  /** Signs whatever voucher it is handed, however malformed. */
  sign(voucher: Voucher): SignedVoucher;
  /** A well-formed voucher for `input`, signed correctly. */
  voucherFor(overrides?: Partial<RedeemArgs>): { signed: SignedVoucher; input: RedeemVoucherInput };
  redeemInput(overrides?: Partial<RedeemArgs>): RedeemVoucherInput;
}

export interface RedeemArgs {
  readonly method: string;
  readonly path: string;
  readonly query: unknown;
  readonly body: unknown;
  readonly toolId: string;
  readonly providerId: string;
  readonly resource: string;
  readonly price: Money;
  readonly escrowPda: AccountId;
  readonly agentAccount: AccountId;
  readonly provider: AccountId;
  readonly seq: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly amount: Money;
}

/**
 * Stands in for `EscrowSeqService.wasIssued` — the allocator's high-water mark,
 * without a database.
 *
 * `advance()` is what `nextSeq()` below calls to mint each voucher's default
 * `seq`, so the two stay in lockstep exactly the way `buyer_escrows.next_seq`
 * and `GET /escrow/next-seq` do for real: a seq is "issued" the moment it is
 * handed out, and stays issued forever after — `wasIssued` never goes back to
 * `false` for a number once it has been true, matching `EscrowSeqService`'s own
 * doc comment.
 */
export class FakeEscrowSeqService {
  private issuedHighWater = 0n;
  readonly realigned: { account: AccountId; seqHigh: bigint }[] = [];

  advance(): bigint {
    this.issuedHighWater += 1n;
    return this.issuedHighWater;
  }

  async wasIssued(_organizationId: string, _account: AccountId, seq: bigint): Promise<boolean> {
    // Interleaves two concurrent `redeem()` calls at this point, the same way
    // the deleted `VoucherNonceStore`'s `reserve` used to — see
    // `InMemoryIntentWriter.create` for why the LAST synchronous check is the
    // one that actually arbitrates a race.
    await Promise.resolve();
    return seq >= 1n && seq <= this.issuedHighWater;
  }

  async realignTo(organizationId: string, account: AccountId, seqHigh: bigint): Promise<boolean> {
    this.realigned.push({ account, seqHigh });
    return true;
  }
}

/**
 * Stands in for `PaymentIntentService` over Postgres.
 *
 * `create` reproduces the one behaviour that matters here:
 * `uq_payment_intents_account_voucher_seq` refuses a second intent for an
 * `(account, seq)` pair already recorded, and raises
 * `PAYMENT_VOUCHER_SEQ_ALREADY_USED` when it does — exactly what
 * `PaymentIntentService.create`'s own unique-violation branch does for the
 * real index. `isVoucherSeqUsed` is the up-front read of the same rows.
 */
export class InMemoryIntentWriter {
  readonly created: PaymentIntent[] = [];
  readonly secured: string[] = [];
  private readonly seqKeys = new Set<string>();
  /** Set by a test that wants the insert to fail for an unrelated reason. */
  failInsertWith?: Error;
  /** Set by a test that wants `secureFunds` to fail. */
  failSecureWith?: Error;

  /** How many times `create` was reached, refused or not. */
  createAttempts = 0;

  /** Set by a test: the payer's admission is paused for that many seconds (BUG-D1-07). */
  pausedFor: number | null = null;

  async isVoucherSeqUsed(
    _organizationId: string,
    account: AccountId,
    seq: string,
  ): Promise<boolean> {
    return this.seqKeys.has(`${account}#${seq}`);
  }

  /** Intents `abandonUnsecuredVoucher` took out of the window count. */
  readonly abandoned = new Set<string>();

  /**
   * Every intent this fake created and did not abandon is holding money: none
   * has been redeemed. The admission runs synchronously with the push below,
   * as the real one runs under the payer's lock with the insert.
   */
  private openTotals(scope: VoucherAdmission['scope']): { escrow: bigint; delegate: bigint } {
    const open = this.created.filter(
      (intent) =>
        intent.agentAccount === scope.payer &&
        intent.price.asset === scope.assetId &&
        !this.abandoned.has(intent.id),
    );
    const sum = (rows: PaymentIntent[]) =>
      rows.reduce((total, intent) => total + BigInt(intent.price.amount), 0n);
    return {
      escrow: sum(open),
      delegate:
        scope.delegate === null
          ? 0n
          : sum(open.filter((intent) => intent.voucherDelegate === scope.delegate)),
    };
  }

  async abandonUnsecuredVoucher(_organizationId: string, intentId: string): Promise<void> {
    this.abandoned.add(intentId);
  }

  async create(
    input: CreatePaymentIntentInput,
    admission?: VoucherAdmission,
  ): Promise<PaymentIntent> {
    this.createAttempts += 1;
    if (this.failInsertWith) {
      throw this.failInsertWith;
    }
    if (admission) {
      admission.admit({ ...this.openTotals(admission.scope), pausedFor: this.pausedFor });
    }

    // No `await` between the check and the claim — see the class comment on
    // `FakeEscrowSeqService.wasIssued` for why that is what makes this the
    // point two concurrent calls actually arbitrate at.
    const key = input.voucherSeq ? `${input.agentAccount}#${input.voucherSeq}` : null;
    if (key && this.seqKeys.has(key)) {
      throw PaymentErrors.voucherSeqAlreadyUsed({
        account: input.agentAccount,
        actual: input.voucherSeq,
      });
    }
    if (key) {
      this.seqKeys.add(key);
    }

    const intent = {
      id: randomUUID(),
      organizationId: input.organizationId,
      status: PaymentIntentStatus.CREATED,
      statusReason: null,
      agentId: input.agentId,
      agentAccount: input.agentAccount,
      providerId: input.providerId,
      providerAccount: input.providerAccount,
      toolId: input.toolId,
      // Rail B knows its provider before the intent exists; it still does not
      // know which binding will serve, and this path never routes.
      bindingId: null,
      rail: input.rail,
      callId: input.callId,
      callClass: input.callClass,
      price: input.price,
      providerAmount: MoneyUtil.subtract(input.price, input.platformFee),
      platformFee: input.platformFee,
      settledAmount: null,
      requestHash: input.requestHash,
      chainId: input.chainId,
      expiresAt: input.expiresAt ?? new Date(),
      idempotencyKey: input.idempotencyKey ?? null,
      voucherNonce: input.voucherNonce ?? null,
      voucherSeq: input.voucherSeq ?? null,
      voucherSignature: input.voucherSignature ?? null,
      voucherResourceHash: input.voucherResourceHash ?? null,
      voucherIssuedAt: input.voucherIssuedAt ?? null,
      voucherDelegate: input.voucherDelegate ?? null,
      holdId: null,
      holdReleasedAt: null,
      classification: null,
      verificationVerdict: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } satisfies PaymentIntent;

    this.created.push(intent);
    return intent;
  }

  async secureFunds(_organizationId: string, intentId: string): Promise<PaymentIntent> {
    if (this.failSecureWith) {
      throw this.failSecureWith;
    }
    this.secured.push(intentId);
    const intent = this.created.find((candidate) => candidate.id === intentId);
    return { ...(intent as PaymentIntent), status: PaymentIntentStatus.FUNDS_SECURED };
  }
}

export function createVoucherHarness(): VoucherHarness {
  const keyPair = generateKeyPairSync('ed25519');
  const rawPublicKey = keyPair.publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  const payer = `${SOLANA_MAINNET}:${getBase58Decoder().decode(rawPublicKey)}` as AccountId;

  // No RPC call is reachable from anything under test — signature verification
  // is pure — so the client is a token that would throw if it were ever used.
  const adapter = new SolanaChainAdapter(
    {
      getTokenAccountBalance: () => {
        throw new Error('the voucher path must not touch the chain');
      },
    } as never,
    [CHAIN_IDS.SOLANA_MAINNET, CHAIN_IDS.SOLANA_DEVNET],
    DEPLOYED_PROGRAM_ID,
  );

  const registry = new ChainAdapterRegistry([adapter], adapter.supportedChains);
  const seqs = new FakeEscrowSeqService();
  const intents = new InMemoryIntentWriter();
  const service = new VoucherService(
    intents as unknown as PaymentIntentService,
    registry,
    seqs as unknown as EscrowSeqService,
  );

  const organizationId = randomUUID();
  const agentId = randomUUID();

  /**
   * The allocator `GET /escrow/next-seq` stands in for.
   *
   * A counter rather than a random value, because that is what a `seq` is: the
   * chain's replay guard is a bitmap keyed on distance from the highest
   * redeemed number, which a random value cannot index. Each harness gets its
   * own, so a test that wants a fresh voucher does not have to name a number —
   * and every number this mints is also recorded as issued in `seqs`, so
   * `assertIssuedSeq` accepts it without a test having to wire that up itself.
   */
  const nextSeq = () => seqs.advance().toString();

  const defaults = (): RedeemArgs => {
    const now = Math.floor(Date.now() / 1000);
    return {
      method: 'POST',
      path: '/v1/weather',
      query: { units: 'metric' },
      body: { city: 'Paris', days: 3 },
      toolId: '11111111-1111-4111-8111-111111111111',
      providerId: '22222222-2222-4222-8222-222222222222',
      resource: RESOURCE,
      price: usdc(1_000_000n),
      escrowPda: ESCROW_PDA,
      agentAccount: payer,
      provider: PROVIDER,
      seq: nextSeq(),
      // Issued a few seconds in the past, on purpose: a default that landed
      // exactly on `now` would make every test that overrides only
      // `expiresAt` collide with the new `expiresAt > issuedAt` rule instead
      // of exercising the rule it meant to test.
      issuedAt: now - 5,
      expiresAt: now + 120,
      amount: usdc(1_000_000n),
    };
  };

  const redeemInput = (overrides: Partial<RedeemArgs> = {}): RedeemVoucherInput => {
    const args = { ...defaults(), ...overrides };
    return {
      organizationId,
      // Overwritten by `voucherFor`; a placeholder so the type is satisfied.
      signed: { voucher: undefined as never, signature: '' },
      call: { method: args.method, path: args.path, query: args.query, body: args.body },
      agentId,
      agentAccount: args.agentAccount,
      providerId: args.providerId,
      providerAccount: PROVIDER,
      toolId: args.toolId,
      resource: args.resource,
      escrowPda: args.escrowPda,
      price: args.price,
      platformFee: usdc(100_000n),
      chainId: SOLANA_MAINNET,
    };
  };

  const signVoucher = (voucher: Voucher): SignedVoucher => ({
    voucher,
    signature: getBase58Decoder().decode(
      sign(null, Buffer.from(adapter.buildVoucherMessage(voucher)), keyPair.privateKey),
    ),
  });

  return {
    service,
    adapter,
    seqs,
    intents,
    payer,
    sign: signVoucher,
    redeemInput,

    voucherFor(overrides: Partial<RedeemArgs> = {}) {
      const args = { ...defaults(), ...overrides };
      const input = redeemInput(overrides);

      const voucher: Voucher = {
        payer,
        payTo: args.escrowPda,
        provider: args.provider,
        amount: args.amount,
        resource: args.resource,
        requestHash: computeRequestHash({
          method: args.method,
          path: args.path,
          query: args.query,
          body: args.body,
          toolId: args.toolId,
          providerId: args.providerId,
          amount: args.price.amount,
          asset: args.price.asset,
        }),
        seq: args.seq,
        issuedAt: args.issuedAt,
        expiresAt: args.expiresAt,
      };

      const signed = signVoucher(voucher);
      return { signed, input: { ...input, signed } };
    },
  };
}
