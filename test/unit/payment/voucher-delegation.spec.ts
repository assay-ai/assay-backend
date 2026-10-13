import { randomUUID } from 'node:crypto';

import { ChainAdapterRegistry } from '@modules/chains/chain-adapter.registry';
import { EvmChainAdapter } from '@modules/chains/evm/evm-chain.adapter';
import { EVM_CONSTANTS } from '@modules/chains/evm/evm.constants';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { AccountId, CHAIN_IDS } from '@modules/chains/ports/caip.types';
import { Voucher } from '@modules/chains/ports/x402.types';
import { EscrowChainBalance } from '@modules/ledger/ports/escrow-balance-reader.port';
import { computeRequestHash } from '@modules/payment/domain/request-hash';
import { PaymentErrorCode } from '@modules/payment/errors/payment.errors';
import { PaymentIntentStatus } from '@modules/payment/ports/payment.types';
import { RedeemVoucherInput } from '@modules/payment/ports/voucher.types';
import { VOUCHER_MAX_SEQ_GAP } from '@modules/payment/constants/escrow-seq.constants';
import { EscrowSeqService } from '@modules/payment/services/escrow-seq.service';
import { PaymentIntentService } from '@modules/payment/services/payment-intent.service';
import { VoucherService } from '@modules/payment/services/voucher.service';
import { MoneyUtil } from '@shared/utils/money.util';

import { deployment, EvmSigner, generateSigner } from '../chains/evm/evm-fixtures';
import { FakeEscrowSeqService, InMemoryIntentWriter } from './helpers/voucher-harness';
import { noBlocks } from '../helpers/blocklist';

const CHAIN = CHAIN_IDS.ROBINHOOD_TESTNET;
const USDG = ASSET_IDS.USDG_ROBINHOOD_TESTNET;
const DEPLOYMENT = deployment(CHAIN);
const ESCROW = `${CHAIN}:${DEPLOYMENT.escrow}` as AccountId;
const PROVIDER = `${CHAIN}:0xAb8483F64d9C6d1EcF9b849Ae677dD3315835cb2` as AccountId;
const RESOURCE = '/mcp/tools/get_weather';
const usdg = (atomic: bigint) => MoneyUtil.of(atomic, USDG, 6);

interface Grant {
  maxVoucherAmount: bigint;
  maxPerWindow: bigint;
  spentInWindow: bigint;
  windowStartedAt: bigint;
  validUntil: bigint;
  listPosition: number;
  revoked: boolean;
}

/** The EIP-1271 magic value: what a wallet that "accepts" would answer. */
const ERC1271_MAGIC_VALUE = '0x1626ba7e';

/** The chain, as the adapter reads it: delegation records, and a wallet nobody should ask. */
class FakeEvmChain {
  grants = new Map<string, Grant>();
  walletAccepts = false;
  delegationReads = 0;

  async readContract(args: { functionName: string; args: readonly unknown[] }): Promise<unknown> {
    if (args.functionName === 'delegationOf') {
      this.delegationReads += 1;
      const [payer, delegate] = args.args as string[];
      return (
        this.grants.get(`${payer.toLowerCase()}:${delegate.toLowerCase()}`) ?? {
          maxVoucherAmount: 0n,
          maxPerWindow: 0n,
          spentInWindow: 0n,
          windowStartedAt: 0n,
          validUntil: 0n,
          listPosition: 0,
          revoked: false,
        }
      );
    }
    if (args.functionName === 'isValidSignature') {
      return this.walletAccepts ? ERC1271_MAGIC_VALUE : '0xffffffff';
    }
    throw new Error(`unexpected read ${args.functionName}`);
  }

  grant(payer: string, delegate: string, grant: Partial<Grant> = {}): void {
    const now = BigInt(Math.floor(Date.now() / 1000));
    this.grants.set(`${payer.toLowerCase()}:${delegate.toLowerCase()}`, {
      maxVoucherAmount: 400_000n,
      maxPerWindow: 1_000_000n,
      spentInWindow: 0n,
      windowStartedAt: 0n,
      validUntil: now + 86_400n,
      listPosition: 1,
      revoked: false,
      ...grant,
    });
  }
}

/**
 * Rail-B voucher redemption with AGENT PAYMENT DELEGATION, end to end through
 * the real `EvmChainAdapter` and real secp256k1 keys: the payer is a Privy
 * embedded wallet whose key never leaves Privy; its agent holds a DELEGATE key
 * the payer authorised on chain; the voucher is signed by the delegate.
 *
 * The rule under test is the contract's (`X402Escrow._voucherAuthority`):
 * payer key → active delegate within its own caps (and nothing else: no
 * EIP-1271, assay-evm D-18), read from chain state, failing closed — plus the platform's one addition, that the delegate
 * must be the one bound to the calling credential.
 */
describe('VoucherService — agent payment delegation (eip155)', () => {
  let chain: FakeEvmChain;
  let intents: InMemoryIntentWriter;
  let seqs: FakeEscrowSeqService;
  let service: VoucherService;
  let payer: EvmSigner;
  let delegate: EvmSigner;
  let adapter: EvmChainAdapter;
  const organizationId = randomUUID();

  beforeEach(() => {
    chain = new FakeEvmChain();
    adapter = new EvmChainAdapter(
      new Map([[CHAIN, chain as never]]),
      new Map([[CHAIN, DEPLOYMENT]]),
      [CHAIN],
    );
    intents = new InMemoryIntentWriter();
    seqs = new FakeEscrowSeqService();
    service = new VoucherService(
      intents as unknown as PaymentIntentService,
      new ChainAdapterRegistry([adapter], [CHAIN]),
      seqs as unknown as EscrowSeqService,
      noBlocks(),
    );
    payer = generateSigner(CHAIN);
    delegate = generateSigner(CHAIN);
  });

  function input(
    signer: EvmSigner,
    opts: {
      amount?: bigint;
      boundDelegate?: AccountId | null;
      expiresIn?: number;
      payerAccount?: AccountId;
      escrow?: EscrowChainBalance | null;
    } = {},
  ): RedeemVoucherInput {
    const now = Math.floor(Date.now() / 1000);
    const amount = opts.amount ?? 100_000n;
    const payerAccount = opts.payerAccount ?? payer.account;
    const call = {
      method: 'POST',
      path: RESOURCE,
      query: {},
      body: { latitude: 10.8, longitude: 106.6 },
    };
    const toolId = '11111111-1111-4111-8111-111111111111';
    const providerId = '22222222-2222-4222-8222-222222222222';
    const voucher: Voucher = {
      payer: payerAccount,
      payTo: ESCROW,
      provider: PROVIDER,
      amount: usdg(amount),
      resource: RESOURCE,
      requestHash: computeRequestHash({
        ...call,
        toolId,
        providerId,
        amount: amount.toString(),
        asset: USDG,
      }),
      seq: seqs.advance().toString(),
      issuedAt: now - 5,
      expiresAt: now + (opts.expiresIn ?? 240),
    };
    return {
      organizationId,
      signed: { voucher, signature: signer.sign(adapter.buildVoucherMessage(voucher)) },
      call,
      agentId: randomUUID(),
      agentAccount: payerAccount,
      providerId,
      providerAccount: PROVIDER,
      toolId,
      resource: RESOURCE,
      escrowPda: ESCROW,
      price: usdg(amount),
      platformFee: usdg(amount / 10n),
      chainId: CHAIN,
      boundDelegate: opts.boundDelegate === undefined ? delegate.account : opts.boundDelegate,
      escrow: opts.escrow,
    };
  }

  /** The payer's escrow as the MCP path reads it for the call (limits 1 / 10). */
  function escrow(overrides: Partial<EscrowChainBalance> = {}): EscrowChainBalance {
    return {
      balance: usdg(100_000_000n),
      seqHigh: 0n,
      withdrawRequested: 0n,
      withdrawAvailableAt: 0,
      maxVoucherAmount: 1_000_000n,
      maxPerWindow: 10_000_000n,
      spentInWindow: 0n,
      windowStartedAt: 0,
      observedAt: new Date(),
      ...overrides,
    };
  }

  const rejects = async (promise: Promise<unknown>, code: PaymentErrorCode | string) => {
    await expect(promise).rejects.toMatchObject({ errorCode: code });
  };

  describe('(a) the payer’s own key — unchanged', () => {
    it('redeems, records no delegate, and reads nothing from the chain', async () => {
      const intent = await service.redeem(input(payer));
      expect(intent.status).toBe(PaymentIntentStatus.FUNDS_SECURED);
      expect(intents.created[0].voucherDelegate).toBeNull();
      expect(chain.delegationReads).toBe(0);
    });
  });

  /**
   * REGRESSION (BUG-D1-07): while the payer relays a change that tightens its
   * caps, a voucher admitted under the old caps could be stranded by the new
   * ones. The admission is paused for that moment: refused by name, nothing
   * reserved, and the same voucher goes through once the pause is over.
   */
  describe('while the payer tightens its caps', () => {
    it('refuses a voucher retryably, reserves nothing, and admits the same one afterwards', async () => {
      chain.grant(payer.address, delegate.address);
      const call = input(delegate, { escrow: escrow() });
      intents.pausedFor = 10;
      await expect(service.redeem(call)).rejects.toMatchObject({
        errorCode: PaymentErrorCode.PAYMENT_VOUCHER_ADMISSION_PAUSED,
        statusCode: 503,
        // The MCP error carries it as `retryAfter`, like velocity (review finding 4).
        context: { retryAfter: 10 },
      });
      expect(intents.created).toHaveLength(0);

      intents.pausedFor = null;
      await expect(service.redeem(call)).resolves.toMatchObject({
        status: PaymentIntentStatus.FUNDS_SECURED,
      });
    });

    it("pauses the payer's own key too, when the escrow's limits are what is being lowered", async () => {
      intents.pausedFor = 10;
      await rejects(
        service.redeem(input(payer, { escrow: escrow() })),
        PaymentErrorCode.PAYMENT_VOUCHER_ADMISSION_PAUSED,
      );
    });
  });

  /**
   * REGRESSION (review S2-2): a seq rewind between the up-front `wasIssued`
   * read and the locked insert makes this seq not issued any more. The
   * admission re-reads `next_seq` under the payer's lock and refuses it.
   */
  describe('after a seq rewind', () => {
    it('refuses a voucher whose seq is at or above next_seq as re-read under the lock', async () => {
      const call = input(payer, { escrow: escrow() });
      intents.nextSeq = BigInt(call.signed.voucher.seq);
      await rejects(service.redeem(call), PaymentErrorCode.PAYMENT_VOUCHER_SEQ_MISMATCH);
      expect(intents.created).toHaveLength(0);

      intents.nextSeq = BigInt(call.signed.voucher.seq) + 1n;
      await expect(service.redeem(call)).resolves.toMatchObject({
        status: PaymentIntentStatus.FUNDS_SECURED,
      });
    });
  });

  describe('(b) an authorised delegate', () => {
    it('redeems a delegate-signed voucher within its caps and records the delegate', async () => {
      chain.grant(payer.address, delegate.address);
      const intent = await service.redeem(input(delegate));
      expect(intent.status).toBe(PaymentIntentStatus.FUNDS_SECURED);
      expect(intents.created[0].voucherDelegate).toBe(delegate.account);
    });

    it('refuses a key the payer never authorised as an invalid signature', async () => {
      await rejects(
        service.redeem(input(delegate)),
        PaymentErrorCode.PAYMENT_VOUCHER_SIGNATURE_INVALID,
      );
      expect(intents.created).toHaveLength(0);
    });

    it('refuses a revoked delegate by name', async () => {
      chain.grant(payer.address, delegate.address, { revoked: true });
      await rejects(
        service.redeem(input(delegate)),
        PaymentErrorCode.PAYMENT_VOUCHER_DELEGATE_INACTIVE,
      );
    });

    it('refuses a lapsed delegate by name', async () => {
      chain.grant(payer.address, delegate.address, {
        validUntil: BigInt(Math.floor(Date.now() / 1000) - 1),
      });
      await rejects(
        service.redeem(input(delegate)),
        PaymentErrorCode.PAYMENT_VOUCHER_DELEGATE_INACTIVE,
      );
    });

    /**
     * REGRESSION (review S2-1). The delegation used to have to outlive only
     * `expiresAt`; the chain checks `validUntil` at the REDEMPTION block, which
     * the cron reaches after settlement, inside the 1,800 s grace. This is the
     * reviewer's proof, which passed before the fix — accepted — and must now be
     * refused.
     */
    it('refuses a delegate voucher whose expiresAt == validUntil (the chain would refuse it inside the grace)', async () => {
      const now = Math.floor(Date.now() / 1000);
      chain.grant(payer.address, delegate.address, { validUntil: BigInt(now + 240) });
      await rejects(
        service.redeem(input(delegate, { expiresIn: 240 })),
        PaymentErrorCode.PAYMENT_VOUCHER_DELEGATE_LIMIT_EXCEEDED,
      );
      expect(intents.created).toHaveLength(0);
    });

    it('requires the delegation to cover the whole redeemable life: expiresAt + grace, to the second', async () => {
      const now = Math.floor(Date.now() / 1000);
      const expiresAt = now + 240;
      const grace = EVM_CONSTANTS.REDEEM_GRACE_SECONDS;
      chain.grant(payer.address, delegate.address, { validUntil: BigInt(expiresAt + grace - 1) });
      await rejects(
        service.redeem(input(delegate, { expiresIn: 240 })),
        PaymentErrorCode.PAYMENT_VOUCHER_DELEGATE_LIMIT_EXCEEDED,
      );
      chain.grant(payer.address, delegate.address, { validUntil: BigInt(expiresAt + grace) });
      await expect(service.redeem(input(delegate, { expiresIn: 240 }))).resolves.toBeDefined();
    });

    it('refuses a delegation that would lapse before the voucher does', async () => {
      chain.grant(payer.address, delegate.address, {
        validUntil: BigInt(Math.floor(Date.now() / 1000) + 60),
      });
      await rejects(
        service.redeem(input(delegate, { expiresIn: 240 })),
        PaymentErrorCode.PAYMENT_VOUCHER_DELEGATE_LIMIT_EXCEEDED,
      );
    });

    it('applies the per-voucher cap, admitting its own value', async () => {
      chain.grant(payer.address, delegate.address);
      await rejects(
        service.redeem(input(delegate, { amount: 400_001n })),
        PaymentErrorCode.PAYMENT_VOUCHER_DELEGATE_LIMIT_EXCEEDED,
      );
      await expect(service.redeem(input(delegate, { amount: 400_000n }))).resolves.toBeDefined();
    });

    it('counts the chain’s window AND the delegate’s vouchers not yet on chain', async () => {
      // 300k already redeemed on chain (half-decayed from 600k), so 700k remain;
      // two 300k vouchers in flight leave 100k.
      const now = Math.floor(Date.now() / 1000);
      chain.grant(payer.address, delegate.address, {
        spentInWindow: 600_000n,
        windowStartedAt: BigInt(now - EVM_CONSTANTS.SLASH_WINDOW_SECONDS / 2),
      });
      await service.redeem(input(delegate, { amount: 300_000n }));
      await service.redeem(input(delegate, { amount: 300_000n }));
      await rejects(
        service.redeem(input(delegate, { amount: 100_001n })),
        PaymentErrorCode.PAYMENT_VOUCHER_DELEGATE_LIMIT_EXCEEDED,
      );
      await expect(service.redeem(input(delegate, { amount: 100_000n }))).resolves.toBeDefined();
    });

    it('does not count the payer’s own vouchers against the delegate’s window', async () => {
      chain.grant(payer.address, delegate.address, { maxPerWindow: 400_000n });
      await service.redeem(input(payer, { amount: 400_000n }));
      await expect(service.redeem(input(delegate, { amount: 400_000n }))).resolves.toBeDefined();
    });

    it('accepts a delegate only from the credential bound to it', async () => {
      chain.grant(payer.address, delegate.address);
      const other = generateSigner(CHAIN);
      await rejects(
        service.redeem(input(delegate, { boundDelegate: null })),
        PaymentErrorCode.PAYMENT_VOUCHER_DELEGATE_NOT_BOUND,
      );
      await rejects(
        service.redeem(input(delegate, { boundDelegate: other.account })),
        PaymentErrorCode.PAYMENT_VOUCHER_DELEGATE_NOT_BOUND,
      );
    });

    it('never lets one payer’s delegate spend another payer’s escrow', async () => {
      const victim = generateSigner(CHAIN);
      chain.grant(payer.address, delegate.address);
      await rejects(
        service.redeem(input(delegate, { payerAccount: victim.account })),
        PaymentErrorCode.PAYMENT_VOUCHER_SIGNATURE_INVALID,
      );
    });

    it('still refuses a voucher lifted from another agent before reading the chain', async () => {
      chain.grant(payer.address, delegate.address);
      const lifted = { ...input(delegate), agentAccount: generateSigner(CHAIN).account };
      await rejects(service.redeem(lifted), PaymentErrorCode.PAYMENT_VOUCHER_BINDING_MISMATCH);
      expect(chain.delegationReads).toBe(0);
    });
  });

  /**
   * REGRESSION (BUG-D1-03). The escrow's own limits (`setLimits`) bind every
   * voucher at redemption, on top of a delegate's caps. With the escrow at 0.05
   * per voucher and the delegate at 0.5, a 0.10 voucher used to be SERVED and
   * then refused by the chain (`VoucherExceedsPerCallLimit`) until the buyer
   * raised the limit again.
   */
  describe('the escrow’s own limits bind on top of the delegate’s caps', () => {
    it('refuses a delegate voucher above the escrow’s per-voucher limit, before serving', async () => {
      chain.grant(payer.address, delegate.address, {
        maxVoucherAmount: 500_000n,
        maxPerWindow: 2_000_000n,
      });
      await rejects(
        service.redeem(
          input(delegate, { amount: 100_000n, escrow: escrow({ maxVoucherAmount: 50_000n }) }),
        ),
        PaymentErrorCode.PAYMENT_VOUCHER_ESCROW_LIMIT_EXCEEDED,
      );
      expect(intents.created).toHaveLength(0);
      await expect(
        service.redeem(
          input(delegate, { amount: 50_000n, escrow: escrow({ maxVoucherAmount: 50_000n }) }),
        ),
      ).resolves.toBeDefined();
    });

    it('refuses the payer’s own voucher above the escrow’s per-voucher limit too', async () => {
      await rejects(
        service.redeem(
          input(payer, { amount: 100_000n, escrow: escrow({ maxVoucherAmount: 50_000n }) }),
        ),
        PaymentErrorCode.PAYMENT_VOUCHER_ESCROW_LIMIT_EXCEEDED,
      );
    });

    it('applies the escrow’s window: its decayed counter plus every voucher not yet on chain', async () => {
      chain.grant(payer.address, delegate.address, { maxPerWindow: 10_000_000n });
      const now = Math.floor(Date.now() / 1000);
      // 0.6 on chain, anchored in the future of this clock so it does not decay.
      const reading = escrow({
        maxPerWindow: 1_000_000n,
        spentInWindow: 600_000n,
        windowStartedAt: now + 60,
      });
      await service.redeem(input(payer, { amount: 200_000n, escrow: reading }));
      await rejects(
        service.redeem(input(delegate, { amount: 200_001n, escrow: reading })),
        PaymentErrorCode.PAYMENT_VOUCHER_ESCROW_LIMIT_EXCEEDED,
      );
      await expect(
        service.redeem(input(delegate, { amount: 200_000n, escrow: reading })),
      ).resolves.toBeDefined();
    });

    it('gives the window back when the funds could not be secured', async () => {
      intents.failSecureWith = new Error('ledger said no');
      await expect(
        service.redeem(
          input(payer, { amount: 1_000_000n, escrow: escrow({ maxPerWindow: 1_000_000n }) }),
        ),
      ).rejects.toThrow('ledger said no');
      intents.failSecureWith = undefined;
      await expect(
        service.redeem(
          input(payer, { amount: 1_000_000n, escrow: escrow({ maxPerWindow: 1_000_000n }) }),
        ),
      ).resolves.toBeDefined();
    });
  });

  /**
   * There is no wallet path at all: the contract removed its EIP-1271 branch
   * (assay-evm D-18), so neither the chain nor the platform accepts a voucher on
   * a wallet's `isValidSignature`. A contract-wallet payer authorises a
   * delegate instead.
   */
  describe('no EIP-1271 wallet path', () => {
    it.each([true, false])(
      'refuses a voucher only a wallet could vouch for (wallet would answer %p), without asking it',
      async (accepts) => {
        const wallet = generateSigner(CHAIN);
        chain.walletAccepts = accepts;
        const asked = jest.spyOn(chain, 'readContract');
        await rejects(
          service.redeem(input(generateSigner(CHAIN), { payerAccount: wallet.account })),
          PaymentErrorCode.PAYMENT_VOUCHER_SIGNATURE_INVALID,
        );
        expect(
          asked.mock.calls.filter(([args]) => args.functionName === 'isValidSignature'),
        ).toHaveLength(0);
        expect(intents.created).toHaveLength(0);
      },
    );

    it('still serves a contract-wallet payer through an authorised delegate key', async () => {
      const wallet = generateSigner(CHAIN);
      chain.grant(wallet.address, delegate.address);
      await expect(
        service.redeem(input(delegate, { payerAccount: wallet.account })),
      ).resolves.toBeDefined();
    });
  });

  describe('the chain’s seq jump cap (X402Escrow.MAX_SEQ_GAP) at admission', () => {
    const GAP = BigInt(VOUCHER_MAX_SEQ_GAP);

    it('admits a seq exactly MAX_SEQ_GAP above the escrow’s seqHigh', async () => {
      seqs.jumpTo(GAP + 2n);
      await expect(
        service.redeem(input(payer, { escrow: escrow({ seqHigh: 2n }) })),
      ).resolves.toBeDefined();
    });

    it('refuses one above it before recording, even though the seq was issued', async () => {
      seqs.jumpTo(GAP + 2n);
      await rejects(
        service.redeem(input(payer, { escrow: escrow({ seqHigh: 1n }) })),
        PaymentErrorCode.PAYMENT_VOUCHER_SEQ_GAP_TOO_LARGE,
      );
      expect(intents.created).toHaveLength(0);
    });

    it('applies no cap when the call did not read the escrow', async () => {
      seqs.jumpTo(GAP + 2n);
      await expect(service.redeem(input(payer))).resolves.toBeDefined();
    });
  });

  describe('fail closed', () => {
    it('refuses, and charges nothing, when the delegation cannot be read', async () => {
      chain.readContract = async () => {
        throw Object.assign(new Error('fetch failed'), { name: 'HttpRequestError' });
      };
      await rejects(service.redeem(input(delegate)), 'CHAIN_VOUCHER_AUTHORITY_UNAVAILABLE');
      expect(intents.created).toHaveLength(0);
    });
  });
});
