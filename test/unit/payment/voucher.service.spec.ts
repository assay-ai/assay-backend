import { ChainErrorCode } from '@modules/chains/errors/chains.errors';
import { AccountId, CHAIN_IDS } from '@modules/chains/ports/caip.types';
import { Voucher } from '@modules/chains/ports/x402.types';
import {
  VOUCHER_CLOCK_SKEW_TOLERANCE_SECONDS,
  VOUCHER_MAX_TTL_SECONDS,
} from '@modules/payment/constants/voucher.constants';
import { PaymentErrorCode } from '@modules/payment/errors/payment.errors';
import { PaymentIntentStatus } from '@modules/payment/ports/payment.types';
import { RedeemVoucherInput } from '@modules/payment/ports/voucher.types';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';
import { offerSolanaRailBInThisSuite } from '../helpers/solana-rail-b';

import {
  OTHER_ESCROW,
  OTHER_PROVIDER,
  RESOURCE,
  VoucherHarness,
  createVoucherHarness,
  usdc,
} from './helpers/voucher-harness';

/**
 * The ways a voucher must fail, and the ones it must not, on voucher v2.
 *
 * The requirement: *an authorization must not be reusable for a different
 * request*. Every case below is a way of trying to reuse one, and every one of
 * them is rejected.
 *
 * The signature check here is the real `SolanaChainAdapter` over real ed25519
 * keys. That is the point of the suite — a test that stubs signature
 * verification passes whether or not the binding works.
 */
describe('VoucherService', () => {
  offerSolanaRailBInThisSuite();

  let harness: VoucherHarness;

  beforeEach(() => {
    harness = createVoucherHarness();
  });

  /** Re-signs a mutated voucher, for cases where the *signature* is not the attack. */
  const resign = (input: RedeemVoucherInput, patch: Partial<Voucher>): RedeemVoucherInput => ({
    ...input,
    signed: harness.sign({ ...input.signed.voucher, ...patch }),
  });

  /**
   * Presents a mutated voucher under the *original* signature, without trying to
   * encode it.
   *
   * The structural cases need this and `resign` cannot serve them: voucher v2 is
   * 239 fixed-width bytes, so a `seq` that is not a number, a `requestHash` that
   * is not a digest or a fractional `expiresAt` cannot be encoded at all —
   * `buildVoucherMessage` throws before a signature could be produced. That is
   * the encoder being strict, and it is exactly why `assertWellFormed` is step 1:
   * a client can put any JSON on the wire, and the shape check has to reject it
   * before anything downstream tries to interpret it as bytes.
   */
  const presentUnsigned = (
    input: RedeemVoucherInput,
    patch: Partial<Voucher>,
  ): RedeemVoucherInput => ({
    ...input,
    signed: {
      voucher: { ...input.signed.voucher, ...patch },
      signature: input.signed.signature,
    },
  });

  describe('the happy path, so the failures below mean something', () => {
    it('redeems a well-formed voucher and secures the funds', async () => {
      const { input } = harness.voucherFor();

      const intent = await harness.service.redeem(input);

      expect(intent.status).toBe(PaymentIntentStatus.FUNDS_SECURED);
      expect(intent.voucherSeq).toBe(input.signed.voucher.seq);
      expect(harness.intents.created).toHaveLength(1);
      expect(harness.intents.secured).toEqual([intent.id]);
    });
  });

  describe('what is recorded for redemption', () => {
    it("records the resource hash in the form the payer's chain signed it", async () => {
      // `redeem_voucher` is handed the STORED hash minutes later, and the chain
      // recomputes nothing: the bytes must be the ones the buyer signed. Solana
      // signs sha256(resource) and eip155 signs keccak256(resource), so a
      // service that hashed for itself recorded the Solana form for an EVM
      // voucher and every such redemption would recover the wrong signer.
      const { input } = harness.voucherFor();
      const hashed = jest
        .spyOn(harness.adapter, 'voucherResourceHash')
        .mockReturnValue('the-chains-own-form');

      await harness.service.redeem(input);

      expect(hashed).toHaveBeenCalledWith(input.signed.voucher.resource);
      expect(harness.intents.created[0].voucherResourceHash).toBe('the-chains-own-form');
    });
  });

  // ── Case 1 ───────────────────────────────────────────────────────────────

  describe('case 1 — the amount is edited after signing', () => {
    it('rejects a voucher whose amount was raised, keeping the signature', async () => {
      const { input } = harness.voucherFor();

      // The wire is attacker-controlled: the struct arrives alongside the
      // signature, and nothing stops an intermediary rewriting a field of it.
      // Under v1's ceiling this fell through to the signature check (a raised
      // amount still satisfied "at least the price"). Under v2's exact match
      // the binding check — cheaper, and run first — catches it on its own:
      // the tampered amount no longer equals `input.price` at all, so the
      // ed25519 verify this would otherwise have cost never runs.
      const tampered: RedeemVoucherInput = {
        ...input,
        signed: {
          voucher: { ...input.signed.voucher, amount: usdc(50_000_000n) },
          signature: input.signed.signature,
        },
      };

      await expectRejectedWith(
        harness.service.redeem(tampered),
        PaymentErrorCode.PAYMENT_VOUCHER_BINDING_MISMATCH,
      );
      expect(harness.intents.created).toHaveLength(0);
    });

    it('rejects a voucher whose amount was lowered below the price', async () => {
      const { input } = harness.voucherFor({ amount: usdc(1n) });

      await expectRejectedWith(
        harness.service.redeem(input),
        PaymentErrorCode.PAYMENT_VOUCHER_BINDING_MISMATCH,
      );
    });

    it('rejects an amount that is not exactly the quoted price, in either direction', async () => {
      // v1 treated `amount` as a CEILING, because the `upto` scheme meters
      // after the fact. v2 does not: `redeem_voucher` moves exactly
      // `voucher.amount`, so a voucher for more than the price would take more
      // than the buyer was quoted, and a voucher for less would fail the
      // chain's own balance maths.
      const over = harness.voucherFor({ amount: usdc(1_000_001n) });
      await expectRejectedWith(
        harness.service.redeem(over.input),
        PaymentErrorCode.PAYMENT_VOUCHER_BINDING_MISMATCH,
      );

      const under = harness.voucherFor({ amount: usdc(999_999n) });
      await expectRejectedWith(
        harness.service.redeem(under.input),
        PaymentErrorCode.PAYMENT_VOUCHER_BINDING_MISMATCH,
      );
    });
  });

  // ── Case 2 ───────────────────────────────────────────────────────────────

  describe("case 2 — resource A's voucher presented for resource B", () => {
    it('rejects a correctly signed voucher naming a different resource', async () => {
      const { input } = harness.voucherFor();

      // Genuinely signed, genuinely unexpired, genuinely the payer's — and for
      // a different tool. This is the cheap-tool-pays-for-expensive-tool attack.
      const elsewhere: RedeemVoucherInput = {
        ...input,
        resource: 'https://api.x402.dev/tools/gpt-inference',
      };

      await expectRejectedWith(
        harness.service.redeem(elsewhere),
        PaymentErrorCode.PAYMENT_VOUCHER_BINDING_MISMATCH,
      );
      expect(harness.intents.created).toHaveLength(0);
    });

    it('rejects it even when both tools publish the same resource string', async () => {
      // The `resource` check alone would pass here, so this is what the
      // requestHash is for: `toolId` is inside the hash, and the hash is inside
      // the signature. Two tools proxying one upstream URL at different prices
      // are still two different purchases.
      const { input } = harness.voucherFor();
      const otherTool: RedeemVoucherInput = {
        ...input,
        toolId: '55555555-5555-4555-8555-555555555555',
      };

      await expectRejectedWith(
        harness.service.redeem(otherTool),
        PaymentErrorCode.PAYMENT_REQUEST_HASH_MISMATCH,
      );
      expect(harness.intents.created).toHaveLength(0);
    });
  });

  // ── Case 3 ───────────────────────────────────────────────────────────────

  describe('case 3 — the same voucher presented twice', () => {
    it('rejects the second presentation of a byte-identical voucher', async () => {
      const { input } = harness.voucherFor();

      await expect(harness.service.redeem(input)).resolves.toBeDefined();

      await expectRejectedWith(
        harness.service.redeem(input),
        PaymentErrorCode.PAYMENT_VOUCHER_SEQ_ALREADY_USED,
      );
      expect(harness.intents.created).toHaveLength(1);
    });

    // E2E (EVM run, E3): the replay used to pass the issued-seq check and be
    // refused only by the unique index, as "sequence 3 was not issued to this
    // account" — the opposite of what happened. It is refused up front now,
    // before the insert, and the message says the seq was already used.
    it('refuses a replay up front as already used, with a message that says so', async () => {
      const { input } = harness.voucherFor();
      await harness.service.redeem(input);
      const attemptedInserts = harness.intents.createAttempts;

      const replay = harness.service.redeem(input);
      await expectRejectedWith(replay, PaymentErrorCode.PAYMENT_VOUCHER_SEQ_ALREADY_USED);
      await expect(harness.service.redeem(input)).rejects.toThrow(
        `Voucher sequence ${input.signed.voucher.seq} was already used`,
      );
      expect(harness.intents.createAttempts).toBe(attemptedInserts);
    });

    it('records the seq on the intent — the durable index refuses the replay on its own', async () => {
      const { input } = harness.voucherFor();
      await harness.service.redeem(input);

      await expectRejectedWith(
        harness.service.redeem(input),
        PaymentErrorCode.PAYMENT_VOUCHER_SEQ_ALREADY_USED,
      );
      expect(harness.intents.created[0].voucherSeq).toBe(input.signed.voucher.seq);
    });
  });

  // ── Case 4 ───────────────────────────────────────────────────────────────

  describe('case 4 — an expired or malformed window', () => {
    it('rejects a voucher whose expiry has passed', async () => {
      const now = Math.floor(Date.now() / 1000);
      const { input } = harness.voucherFor({ issuedAt: now - 60, expiresAt: now - 1 });

      await expectRejectedWith(
        harness.service.redeem(input),
        PaymentErrorCode.PAYMENT_VOUCHER_EXPIRED,
      );
    });

    it('rejects a voucher expiring exactly now — the boundary is not inclusive', async () => {
      const now = Math.floor(Date.now() / 1000);
      const { input } = harness.voucherFor({ issuedAt: now - 60, expiresAt: now });

      await expectRejectedWith(
        harness.service.redeem(input),
        PaymentErrorCode.PAYMENT_VOUCHER_EXPIRED,
      );
    });

    it('never reaches the index, so a dead voucher cannot burn a sequence number', async () => {
      const now = Math.floor(Date.now() / 1000);
      const { input } = harness.voucherFor({ issuedAt: now - 60, expiresAt: now - 1 });

      await harness.service.redeem(input).catch(() => undefined);

      expect(harness.intents.created).toHaveLength(0);
    });

    it('rejects a voucher claiming to live longer than the ceiling', async () => {
      // `expiresAt` is chosen by the agent. Without the ceiling, a voucher
      // captured from a log would stay spendable for as long as it liked.
      const now = Math.floor(Date.now() / 1000);
      const { input } = harness.voucherFor({
        issuedAt: now,
        expiresAt: now + VOUCHER_MAX_TTL_SECONDS + 60,
      });

      await expectRejectedWith(
        harness.service.redeem(input),
        PaymentErrorCode.PAYMENT_VOUCHER_MALFORMED,
      );
    });

    it('rejects a lifetime one second longer than the chain will ever accept', async () => {
      // The precise boundary of `expires_at - issued_at <= MAX_VOUCHER_LIFETIME_SECONDS`
      // is enforced ON CHAIN by the settlement program. Checking it here too means the
      // refusal names the field instead of costing a transaction fee to be told
      // `InvalidVoucherWindow`.
      const now = Math.floor(Date.now() / 1000);
      const { input } = harness.voucherFor({
        issuedAt: now,
        expiresAt: now + VOUCHER_MAX_TTL_SECONDS + 1,
      });

      await expectRejectedWith(
        harness.service.redeem(input),
        PaymentErrorCode.PAYMENT_VOUCHER_MALFORMED,
      );
    });

    it('accepts a lifetime exactly at the ceiling', async () => {
      const now = Math.floor(Date.now() / 1000);
      const { input } = harness.voucherFor({
        issuedAt: now,
        expiresAt: now + VOUCHER_MAX_TTL_SECONDS,
      });

      await expect(harness.service.redeem(input)).resolves.toBeDefined();
    });

    it('rejects a voucher issued further ahead than the clock tolerance', async () => {
      const now = Math.floor(Date.now() / 1000);
      const { input } = harness.voucherFor({
        issuedAt: now + VOUCHER_CLOCK_SKEW_TOLERANCE_SECONDS + 1,
        expiresAt: now + VOUCHER_CLOCK_SKEW_TOLERANCE_SECONDS + 180,
      });

      await expectRejectedWith(
        harness.service.redeem(input),
        PaymentErrorCode.PAYMENT_VOUCHER_MALFORMED,
      );
    });

    it('accepts a voucher issued exactly at the clock-skew boundary', async () => {
      const now = Math.floor(Date.now() / 1000);
      const { input } = harness.voucherFor({
        issuedAt: now + VOUCHER_CLOCK_SKEW_TOLERANCE_SECONDS,
        expiresAt: now + VOUCHER_CLOCK_SKEW_TOLERANCE_SECONDS + 180,
      });

      await expect(harness.service.redeem(input)).resolves.toBeDefined();
    });

    it('rejects an expiry that is not after the issue time', async () => {
      const now = Math.floor(Date.now() / 1000);
      const { input } = harness.voucherFor({ issuedAt: now, expiresAt: now });

      await expectRejectedWith(
        harness.service.redeem(input),
        PaymentErrorCode.PAYMENT_VOUCHER_MALFORMED,
      );
    });
  });

  // ── Case 5 ───────────────────────────────────────────────────────────────

  describe('case 5 — two simultaneous requests carrying the same seq', () => {
    it('lets exactly one through and refuses the other', async () => {
      const { input } = harness.voucherFor();

      // Started in the same tick, so both run every check ahead of the seq
      // claim before either reaches it — the interleaving a sequential `await`
      // would hide.
      const [first, second] = await Promise.allSettled([
        harness.service.redeem(input),
        harness.service.redeem(input),
      ]);

      const outcomes = [first.status, second.status].sort();
      expect(outcomes).toEqual(['fulfilled', 'rejected']);

      const loser = (first.status === 'rejected' ? first : second) as PromiseRejectedResult;
      expect(loser.reason.errorCode).toBe(PaymentErrorCode.PAYMENT_VOUCHER_SEQ_ALREADY_USED);

      // The half that matters: one intent, one hold, one charge.
      expect(harness.intents.created).toHaveLength(1);
      expect(harness.intents.secured).toHaveLength(1);
    });

    it('still lets exactly one through with ten simultaneous copies', async () => {
      const { input } = harness.voucherFor();

      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () => harness.service.redeem(input)),
      );

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(harness.intents.created).toHaveLength(1);
    });

    it('does not serialise two different vouchers against each other', async () => {
      // The lock is per voucher, not global. Two calls paying at the same
      // moment must both succeed, or the store is a throughput ceiling.
      const a = harness.voucherFor();
      const b = harness.voucherFor();

      const results = await Promise.all([
        harness.service.redeem(a.input),
        harness.service.redeem(b.input),
      ]);

      expect(results).toHaveLength(2);
      expect(harness.intents.created).toHaveLength(2);
    });
  });

  // ── Case 6 ───────────────────────────────────────────────────────────────

  describe('case 6 — a field inside requestHash changed, signature untouched', () => {
    /**
     * One case per field the hash covers. Each mutates the *request* while
     * presenting the original voucher and the original signature — the exact
     * shape of "replay this authorization against a different request".
     */
    const mutations: readonly [string, (input: RedeemVoucherInput) => RedeemVoucherInput][] = [
      ['method', (input) => ({ ...input, call: { ...input.call, method: 'DELETE' } })],
      ['path', (input) => ({ ...input, call: { ...input.call, path: '/v1/weather/premium' } })],
      ['query', (input) => ({ ...input, call: { ...input.call, query: { units: 'imperial' } } })],
      [
        'body — a value',
        (input) => ({ ...input, call: { ...input.call, body: { city: 'Paris', days: 30 } } }),
      ],
      [
        'body — an added key',
        (input) => ({
          ...input,
          call: { ...input.call, body: { city: 'Paris', days: 3, premium: true } },
        }),
      ],
      [
        'body — a removed key',
        (input) => ({ ...input, call: { ...input.call, body: { city: 'Paris' } } }),
      ],
      ['toolId', (input) => ({ ...input, toolId: '33333333-3333-4333-8333-333333333333' })],
      ['providerId', (input) => ({ ...input, providerId: '44444444-4444-4444-8444-444444444444' })],
      // No `amount` entry here under v2, unlike v1. `input.price` disagreeing
      // with `voucher.amount` is now caught by the exact-match binding check —
      // run before `requestHash` is even computed — so it is exercised below,
      // not folded into this table's uniform `REQUEST_HASH_MISMATCH` assertion.
    ];

    it.each(mutations)('rejects when %s changed under the signature', async (_name, mutate) => {
      const { input } = harness.voucherFor();

      await expectRejectedWith(
        harness.service.redeem(mutate(input)),
        PaymentErrorCode.PAYMENT_REQUEST_HASH_MISMATCH,
      );
      expect(harness.intents.created).toHaveLength(0);
    });

    it('rejects a re-quoted price via the amount binding, before requestHash is even reached', async () => {
      const { input } = harness.voucherFor();
      const requoted: RedeemVoucherInput = { ...input, price: usdc(999_999n) };

      await expectRejectedWith(
        harness.service.redeem(requoted),
        PaymentErrorCode.PAYMENT_VOUCHER_BINDING_MISMATCH,
      );
      expect(harness.intents.created).toHaveLength(0);
    });

    it('rejects a requestHash edited on the wire, since the signature covers it', async () => {
      const { input } = harness.voucherFor();
      const forged: RedeemVoucherInput = {
        ...input,
        signed: {
          voucher: { ...input.signed.voucher, requestHash: `sha256:${'0'.repeat(64)}` },
          signature: input.signed.signature,
        },
      };

      await expectRejectedWith(
        harness.service.redeem(forged),
        PaymentErrorCode.PAYMENT_REQUEST_HASH_MISMATCH,
      );
    });

    it('accepts the same request assembled with its keys in a different order', async () => {
      // The mirror image of the cases above, and the reason canonicalisation
      // exists: reordering keys is not a different request, and rejecting it
      // would be an availability bug that looks like a security feature.
      const { input } = harness.voucherFor();
      const reordered: RedeemVoucherInput = {
        ...input,
        call: { ...input.call, body: { days: 3, city: 'Paris' } },
      };

      await expect(harness.service.redeem(reordered)).resolves.toBeDefined();
    });
  });

  // ── The other bindings ───────────────────────────────────────────────────

  describe('the remaining bindings, each of which is a way to reuse a voucher', () => {
    it('rejects a voucher whose payer is not the authenticated caller', async () => {
      const { input } = harness.voucherFor();
      const stolen: RedeemVoucherInput = {
        ...input,
        agentAccount: `${CHAIN_IDS.SOLANA_MAINNET}:11111111111111111111111111111112` as AccountId,
      };

      await expectRejectedWith(
        harness.service.redeem(stolen),
        PaymentErrorCode.PAYMENT_VOUCHER_BINDING_MISMATCH,
      );
    });

    it('rejects a voucher paying an escrow other than this session’s own', async () => {
      const { input } = harness.voucherFor();
      const redirected = resign(input, { payTo: OTHER_ESCROW });

      await expectRejectedWith(
        harness.service.redeem(redirected),
        PaymentErrorCode.PAYMENT_VOUCHER_BINDING_MISMATCH,
      );
    });

    it('rejects a provider the router did not choose', async () => {
      // New in v2: the payee is inside the signed bytes, so it is also a
      // binding the server checks. Without it the platform could redirect a
      // signed payment to a provider the buyer never bought from.
      const { input } = harness.voucherFor();
      const redirected = resign(input, { provider: OTHER_PROVIDER });

      await expectRejectedWith(
        harness.service.redeem(redirected),
        PaymentErrorCode.PAYMENT_VOUCHER_BINDING_MISMATCH,
      );
    });

    it('rejects a voucher presenting the price at a different scale', async () => {
      // Same asset, same digits, different `decimals` — "1000000" read as 1
      // USDC or as 0.001. Caught as a binding failure, so the agent-supplied
      // scale never reaches `MoneyUtil`.
      const { input } = harness.voucherFor();
      const rescaled = resign(input, {
        amount: { ...input.signed.voucher.amount, decimals: 9 },
      });

      await expectRejectedWith(
        harness.service.redeem(rescaled),
        PaymentErrorCode.PAYMENT_VOUCHER_BINDING_MISMATCH,
      );
    });

    it('rejects a voucher whose payer is on another chain', async () => {
      // A devnet signature must not authorise mainnet money.
      const { input } = harness.voucherFor();
      const crossChain = resign(input, {
        payer: `${CHAIN_IDS.SOLANA_DEVNET}:11111111111111111111111111111112` as AccountId,
      });

      await expectRejectedWith(
        harness.service.redeem(crossChain),
        PaymentErrorCode.PAYMENT_VOUCHER_BINDING_MISMATCH,
      );
    });

    it('rejects a seq the backend did not issue to this account', async () => {
      // Well past anything `createVoucherHarness()` has issued in a fresh
      // harness — `assertIssuedSeq` refuses it without reaching the signature
      // being otherwise fine.
      const { input } = harness.voucherFor({ seq: '999999' });

      await expectRejectedWith(
        harness.service.redeem(input),
        PaymentErrorCode.PAYMENT_VOUCHER_SEQ_MISMATCH,
      );
    });

    it('rejects a signature produced by a different key', async () => {
      const other = createVoucherHarness();
      const { input } = harness.voucherFor();

      await expectRejectedWith(
        harness.service.redeem({ ...input, signed: other.sign(input.signed.voucher) }),
        PaymentErrorCode.PAYMENT_VOUCHER_SIGNATURE_INVALID,
      );
    });

    it('rejects an absent signature rather than treating it as unsigned-but-fine', async () => {
      const { input } = harness.voucherFor();

      await expectRejectedWith(
        harness.service.redeem({ ...input, signed: { ...input.signed, signature: '' } }),
        PaymentErrorCode.PAYMENT_VOUCHER_SIGNATURE_INVALID,
      );
    });
  });

  // ── Shape ────────────────────────────────────────────────────────────────

  describe('structural checks, before anything is interpreted', () => {
    const malformed: readonly [string, Partial<Voucher>][] = [
      ['a seq that is not a decimal number', { seq: 'not-a-seq' }],
      ['a zero-padded seq', { seq: '007' }],
      ['a padded seq', { seq: ' 7' }],
      ['a seq wider than a u64', { seq: '9'.repeat(21) }],
      ['a requestHash that is not a digest', { requestHash: 'a3f1c0de' }],
      ['a payer that is not CAIP-10', { payer: 'not-an-account' as AccountId }],
      ['a provider that is not CAIP-10', { provider: 'not-an-account' as AccountId }],
      ['a fractional expiry', { expiresAt: 1.5 }],
      ['a fractional issue time', { issuedAt: 1.5 }],
      ['a newline in the resource', { resource: `${RESOURCE}\nsha256:x` }],
    ];

    it.each(malformed)('rejects %s', async (_name, patch) => {
      const { input } = harness.voucherFor();

      await expectRejectedWith(
        harness.service.redeem(presentUnsigned(input, patch)),
        PaymentErrorCode.PAYMENT_VOUCHER_MALFORMED,
      );
      expect(harness.intents.created).toHaveLength(0);
    });
  });

  // ── Failure handling around the sequence number ──────────────────────────

  describe('a failed insert does not consume the voucher', () => {
    it('lets the same voucher be presented again after an unrelated insert failure', async () => {
      // There is nothing to "release" any more — `wasIssued` is a stateless
      // ceiling check and the intent row that would have consumed the seq was
      // never written.
      const { input } = harness.voucherFor();
      harness.intents.failInsertWith = new Error('connection terminated');

      await expect(harness.service.redeem(input)).rejects.toThrow('connection terminated');
      expect(harness.intents.created).toHaveLength(0);

      harness.intents.failInsertWith = undefined;
      await expect(harness.service.redeem(input)).resolves.toBeDefined();
    });

    it('keeps the sequence recorded once the insert succeeds, even if securing funds then fails', async () => {
      const { input } = harness.voucherFor();
      harness.intents.failSecureWith = new Error('insufficient balance');

      await expect(harness.service.redeem(input)).rejects.toThrow('insufficient balance');

      // The intent row exists by then, so the seq is durably spent and cannot
      // be un-spent. Presenting a voucher is spending it.
      expect(harness.intents.created).toHaveLength(1);
      await expectRejectedWith(
        harness.service.redeem(input),
        PaymentErrorCode.PAYMENT_VOUCHER_SEQ_ALREADY_USED,
      );
    });
  });
});

/**
 * Every rejection in this suite is asserted by error *code*, never by message.
 * Delegates to the shared helper, which also insists the thrown value is a real
 * `BaseError` — a plain `Error` carrying the right `errorCode` string would
 * otherwise satisfy the assertion while bypassing the error system.
 */
async function expectRejectedWith(promise: Promise<unknown>, code: PaymentErrorCode) {
  await expectErrorCodeAsync(() => promise, code);
}

describe('VoucherService on Solana, with the real rail table', () => {
  it('refuses a rail-B voucher: rail B is switched off on Solana', async () => {
    const harness = createVoucherHarness();
    const { input } = harness.voucherFor();

    await expectErrorCodeAsync(
      () => harness.service.redeem(input),
      ChainErrorCode.CHAIN_RAIL_NOT_OFFERED,
    );
    expect(harness.intents.created).toHaveLength(0);
  });
});
