import { AccountId } from '@modules/chains/ports/caip.types';
import {
  WithheldBucket,
  WithheldEntry,
  reconcileWithheld,
  sumWithheld,
} from '@modules/ledger/domain/withheld';
import { PaymentIntentStatus } from '@modules/payment/ports/payment.types';
import { MoneyUtil } from '@shared/utils/money.util';

import {
  USDC_ASSET,
  USDC_DECIMALS,
  WithheldTestContext,
  createWithheldTestContext,
} from '../helpers/withheld-test-context';

/**
 * **The invariant: `withheld == Σ HOLD_RELEASE`**.
 *
 * The not-charged figure is the single most important thing in the
 * agent-side product, and the reason is that it is the only place the guarantee
 * is visible at all — a refund is a `HOLD_RELEASE`, and a `HOLD_RELEASE` puts
 * the balance back exactly where it started. So the figure has to be right, and
 * "right" here means one specific thing: **the money the product says it did not
 * take must equal the money the ledger says it gave back.** Two records, two
 * routes, one number.
 *
 * That is why this suite runs several thousand intents down randomly chosen
 * lifecycle paths rather than asserting the four paths one at a time. A
 * per-path unit test proves each edge moves the money it says it moves; it
 * cannot catch the failure this is for, which is a *class* of intent that
 * contributes to one side of the identity and not the other. There is exactly
 * one such class and it is included on purpose — see `CREATED → EXPIRED` below.
 *
 * Nothing here is mocked. `SELECT … FOR UPDATE` serialising two hold
 * resolutions, a compare-and-swap reporting zero affected rows, a CHECK
 * constraint refusing a negative bucket — all three are properties of Postgres,
 * and a fake would pass while proving none of them.
 */

/** The lifecycle paths an intent can be sent down, and what each one owes. */
enum Path {
  /** Charged. Contributes to neither side. */
  SETTLED = 'SETTLED',
  /** The guarantee firing. Withheld, released. */
  REFUNDED = 'REFUNDED',
  /** Provider or platform error. Withheld, released. */
  VOIDED = 'VOIDED',
  /** Expired with funds reserved. Withheld, released. */
  EXPIRED_WITH_HOLD = 'EXPIRED_WITH_HOLD',
  /**
   * Expired before funds were ever reserved.
   *
   * **The case the whole invariant turns on.** Priced, terminal, charged
   * nothing — so the plain-English definition of `withheld` includes it — and
   * its edge carries `HoldEffect.NONE`, so there is no `HOLD_RELEASE` in the
   * journal for it to reconcile against. Counting it would break the identity
   * by exactly the price of every abandoned quote, which is why
   * `isWithheldIntent` also requires a hold. If somebody ever "fixes" that rule,
   * this path is what fails.
   */
  EXPIRED_NO_HOLD = 'EXPIRED_NO_HOLD',
  /** Still in flight. Its hold is open, so it is on neither side yet. */
  IN_FLIGHT = 'IN_FLIGHT',
}

const PATHS: readonly Path[] = Object.values(Path);

/**
 * How many intents to drive.
 *
 * The target is "a few thousand random transactions". At
 * this count every path is exercised a few hundred times, which is enough for
 * the random price distribution to produce carries and remainders rather than
 * round numbers that would hide an arithmetic error.
 */
const INTENT_COUNT = 3_000;

/** Bounded by `TEST_POOL_SIZE` — more in flight than connections is queueing, not concurrency. */
const CONCURRENCY = 24;

/** Enough accounts to exercise the per-balance row lock without serialising everything. */
const ACCOUNT_COUNT = 8;

/**
 * A deterministic PRNG, seeded from a constant.
 *
 * "Random" here means *unpatterned*, not *irreproducible*. A failure that
 * cannot be re-run with the same inputs is a failure nobody can debug, and a
 * money invariant is the last place to want a test that fails once a fortnight
 * and never again. mulberry32 — small, uniform, and its state is one integer.
 */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('withheld reconciles to Σ HOLD_RELEASE', () => {
  let context: WithheldTestContext;

  beforeAll(async () => {
    context = await createWithheldTestContext();
  }, 120_000);

  afterAll(async () => {
    await context.close();
  });

  beforeEach(async () => {
    await context.reset();
  });

  it(`holds over ${INTENT_COUNT} intents on randomly chosen lifecycle paths`, async () => {
    const random = seededRandom(0x5f37_5a86);
    const accounts = Array.from({ length: ACCOUNT_COUNT }, (_, index) =>
      context.account(`withheld-agent-${index}`),
    );

    // Funded far beyond what the run spends, so no intent fails for want of
    // balance. An insufficient-funds refusal is a legitimate outcome the ledger
    // handles elsewhere; here it would silently shrink the sample.
    await Promise.all(accounts.map((account) => context.fund(account, 100_000_000_000n)));

    const plan = Array.from({ length: INTENT_COUNT }, (_, index) => ({
      account: accounts[index % accounts.length] as AccountId,
      path: PATHS[Math.floor(random() * PATHS.length)] as Path,
      // 0.001 – 1.000 USDC, never a round number: the platform fee is a tenth
      // floored, so a price that does not divide by ten is what exercises the
      // remainder going to the provider.
      priceAtomic: BigInt(1_000 + Math.floor(random() * 999_000)),
      toolId: TOOL_IDS[index % TOOL_IDS.length] as string,
    }));

    await inChunks(plan, CONCURRENCY, (item) => drive(context, item));

    // ── The two sides, computed by different routes ──────────────────────────

    const rows = await context.allIntents();
    expect(rows).toHaveLength(INTENT_COUNT);

    const withheld = sumWithheld(
      USDC_ASSET,
      USDC_DECIMALS,
      rows.map(
        (row): WithheldEntry => ({
          status: row.status,
          holdId: row.holdId,
          price: MoneyUtil.of(row.priceAmount, USDC_ASSET, USDC_DECIMALS),
        }),
      ),
    );

    const holdReleaseAtomic = await context.holdReleaseTotal();
    const orphans = await context.orphanedReleases();

    const reconciliation = reconcileWithheld({
      withheld,
      holdReleaseTotal: context.usdc(holdReleaseAtomic),
      orphanedReleases: context.usdc(orphans.total),
      orphanedHoldIds: orphans.holdIds,
    });

    // The headline. Reported with the difference so a failure says by how much
    // and in which direction, not merely that it happened.
    expect({
      ok: reconciliation.ok,
      difference: reconciliation.difference,
      withheld: withheld.amount.amount,
      holdReleaseTotal: holdReleaseAtomic.toString(),
      orphanedReleases: orphans.total.toString(),
    }).toEqual({
      ok: true,
      difference: '0',
      withheld: withheld.amount.amount,
      holdReleaseTotal: holdReleaseAtomic.toString(),
      orphanedReleases: orphans.total.toString(),
    });

    // No orphans on this run: nothing here races `secureFunds`, so every
    // release belongs to an intent that recorded its hold. If this ever starts
    // failing, the identity above is being satisfied by a term that should be
    // zero — which is exactly the failure the orphan term exists to expose
    // rather than absorb.
    expect(orphans.holdIds).toEqual([]);
    expect(MoneyUtil.toAtomic(withheld.amount)).toBe(holdReleaseAtomic);

    // ── The decomposition must add up too ────────────────────────────────────

    const bucketSum = withheld.buckets.reduce(
      (total, bucket) => total + MoneyUtil.toAtomic(bucket.amount),
      0n,
    );
    expect(bucketSum).toBe(MoneyUtil.toAtomic(withheld.amount));
    expect(withheld.buckets.reduce((total, bucket) => total + bucket.calls, 0)).toBe(
      withheld.calls,
    );

    // Both buckets present and non-trivial — a run where one never fired would
    // satisfy every assertion above while testing half the definition.
    const byBucket = new Map(withheld.buckets.map((bucket) => [bucket.bucket, bucket]));
    expect(byBucket.get(WithheldBucket.FAILED_VERIFICATION)?.calls).toBeGreaterThan(0);
    expect(byBucket.get(WithheldBucket.PROVIDER_OR_PLATFORM_ERROR)?.calls).toBeGreaterThan(0);

    // ── And the excluded classes must genuinely be excluded ──────────────────

    const settled = rows.filter((row) => row.status === PaymentIntentStatus.SETTLED);
    const expiredNoHold = rows.filter(
      (row) => row.status === PaymentIntentStatus.EXPIRED && row.holdId === null,
    );
    const inFlight = rows.filter((row) => row.status === PaymentIntentStatus.PROVIDER_EXECUTING);

    expect(settled.length).toBeGreaterThan(0);
    // The class the invariant turns on actually occurred. Without this the
    // exclusion rule would be untested by a run that happened not to produce
    // one, and the suite would pass for the wrong reason.
    expect(expiredNoHold.length).toBeGreaterThan(0);
    expect(inFlight.length).toBeGreaterThan(0);

    const excludedValue =
      [...settled, ...expiredNoHold, ...inFlight].reduce(
        (total, row) => total + BigInt(row.priceAmount),
        0n,
      ) > 0n;
    expect(excludedValue).toBe(true);

    // Priced, terminal, charged nothing — and contributing nothing. This is the
    // assertion that documents the rule.
    for (const row of expiredNoHold) {
      expect(BigInt(row.priceAmount)).toBeGreaterThan(0n);
      expect(row.holdReleasedAt).toBeNull();
    }
  }, 600_000);

  it('reports a release that belongs to no intent as an orphan, not as withheld value', async () => {
    const account = context.account('withheld-orphan-agent');
    await context.fund(account, 10_000_000n);

    // Reproduce the `secureFunds` race directly rather than trying to provoke
    // it: open a hold against an intent, then release it without the intent
    // ever recording it. That is precisely the state a lost compare-and-swap
    // leaves behind, and it is the one shape that puts a `HOLD_RELEASE` in the
    // journal with no withheld intent to match.
    const intent = await context.createIntent({
      agentAccount: account,
      toolId: TOOL_IDS[0],
      priceAtomic: 250_000n,
    });

    const hold = await context.ledger.createHold({
      organizationId: context.organizationId,
      accountId: account,
      money: context.usdc(250_000n),
      intentId: intent.id,
    });
    await context.ledger.releaseHold(context.organizationId, hold.id);

    const rows = await context.allIntents();
    const withheld = sumWithheld(
      USDC_ASSET,
      USDC_DECIMALS,
      rows.map((row) => ({
        status: row.status,
        holdId: row.holdId,
        price: MoneyUtil.of(row.priceAmount, USDC_ASSET, USDC_DECIMALS),
      })),
    );

    const holdReleaseAtomic = await context.holdReleaseTotal();
    const orphans = await context.orphanedReleases();

    // The release happened and the intent never claimed it.
    expect(holdReleaseAtomic).toBe(250_000n);
    expect(MoneyUtil.toAtomic(withheld.amount)).toBe(0n);
    expect(orphans.holdIds).toEqual([hold.id]);
    expect(orphans.total).toBe(250_000n);

    // The identity still balances — because the orphan is a *named term*, not
    // slop absorbed into a tolerance. A reconciliation that reported "ok, close
    // enough" here would report the same thing for a genuine double release.
    const reconciliation = reconcileWithheld({
      withheld,
      holdReleaseTotal: context.usdc(holdReleaseAtomic),
      orphanedReleases: context.usdc(orphans.total),
      orphanedHoldIds: orphans.holdIds,
    });
    expect(reconciliation.ok).toBe(true);
    expect(reconciliation.difference).toBe('0');
    expect(reconciliation.orphanedHoldIds).toHaveLength(1);
  }, 120_000);

  it('refuses to balance when a release is unaccounted for', async () => {
    // The negative control for the assertion above. If `reconcileWithheld` can
    // be made to report `ok` with a term missing, then the headline test proves
    // nothing — it would pass on any pair of numbers.
    const withheld = sumWithheld(USDC_ASSET, USDC_DECIMALS, []);

    const reconciliation = reconcileWithheld({
      withheld,
      holdReleaseTotal: context.usdc(250_000n),
      orphanedReleases: context.usdc(0n),
      orphanedHoldIds: [],
    });

    expect(reconciliation.ok).toBe(false);
    expect(reconciliation.difference).toBe('250000');
  });
});

/** A handful of tool ids, so the summary endpoint's grouping has something to group. */
const TOOL_IDS: readonly string[] = Object.freeze([
  '2b0f9d3a-1c4e-4a6b-9f21-7c5d8e0a1b23',
  '7d1e4c88-5a2b-4f3c-8e90-1a2b3c4d5e6f',
  'c4a91f02-8b7d-4e15-a3c6-9d0e1f2a3b4c',
]);

/** Drives one intent down its assigned path, using only the real service methods. */
async function drive(
  context: WithheldTestContext,
  item: { account: AccountId; path: Path; priceAtomic: bigint; toolId: string },
): Promise<void> {
  const { organizationId } = context;
  const intent = await context.createIntent({
    agentAccount: item.account,
    toolId: item.toolId,
    priceAtomic: item.priceAtomic,
  });

  if (item.path === Path.EXPIRED_NO_HOLD) {
    // Never secured. `CREATED → EXPIRED` carries `HoldEffect.NONE`.
    await context.intents.resolve(
      organizationId,
      intent.id,
      PaymentIntentStatus.CREATED,
      PaymentIntentStatus.EXPIRED,
      { reason: 'expiry sweep' },
    );
    return;
  }

  await context.intents.secureFunds(organizationId, intent.id);

  if (item.path === Path.EXPIRED_WITH_HOLD) {
    await context.intents.resolve(
      organizationId,
      intent.id,
      PaymentIntentStatus.FUNDS_SECURED,
      PaymentIntentStatus.EXPIRED,
      { reason: 'expiry sweep' },
    );
    return;
  }

  await context.intents.transition(
    organizationId,
    intent.id,
    PaymentIntentStatus.FUNDS_SECURED,
    PaymentIntentStatus.PROVIDER_EXECUTING,
    { reason: 'forwarded' },
  );

  if (item.path === Path.IN_FLIGHT) {
    return;
  }

  if (item.path === Path.VOIDED) {
    await context.intents.resolve(
      organizationId,
      intent.id,
      PaymentIntentStatus.PROVIDER_EXECUTING,
      PaymentIntentStatus.VOIDED,
      { reason: 'provider error', providerId: item.toolId },
    );
    return;
  }

  await context.intents.resolve(
    organizationId,
    intent.id,
    PaymentIntentStatus.PROVIDER_EXECUTING,
    PaymentIntentStatus.VERIFYING,
    {
      reason: 'data result',
      providerId: item.toolId,
      // `resolve()`'s `COMMIT` branch (the `SETTLED` edge below, for
      // `Path.SETTLED`) now pays the provider, which needs an account to pay
      // — `chk_payment_intents_paying_states_name_payee` only requires
      // `provider_id`, not `provider_account`, so this has to be supplied
      // explicitly rather than assumed. `item.toolId` is already a
      // UUID-shaped string reused as the provider's organization id (see
      // `commitHoldAndCredit`'s `providerOrganizationId`); the account below
      // is an unrelated CAIP-10 id, which is all a ledger-invariant fuzz test
      // needs it to be.
      providerAccount: context.account(`provider-${item.toolId}`),
    },
  );

  await context.intents.resolve(
    organizationId,
    intent.id,
    PaymentIntentStatus.VERIFYING,
    item.path === Path.SETTLED ? PaymentIntentStatus.SETTLED : PaymentIntentStatus.REFUNDED,
    {
      reason: item.path === Path.SETTLED ? 'verification passed' : 'verification failed',
      verificationVerdict: item.path === Path.SETTLED ? 'PASS' : 'FAIL',
    },
  );
}

/**
 * Runs `worker` over `items`, `size` at a time.
 *
 * Bounded rather than `Promise.all` over three thousand: the pool is thirty
 * connections, and each intent holds one for the length of a row lock. Firing
 * them all at once measures connection queueing and calls it throughput.
 */
async function inChunks<T>(
  items: readonly T[],
  size: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  for (let index = 0; index < items.length; index += size) {
    await Promise.all(items.slice(index, index + size).map(worker));
  }
}
