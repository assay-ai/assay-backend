/**
 * The minimum price of a paid call (owner decision 2026-10-30).
 *
 * Every paid rail-B call costs the platform two on-chain sends — the redeem
 * (about 121k gas per transaction + 81k per voucher batched) and the collect
 * (about 80k + 40k per item) — which at mainnet fees is about $0.0055 per call
 * in large batches and $0.009–0.014 in small ones. The platform keeps only its
 * fee (`takeRateBps`, 10 %), so a call priced at $0.001–$0.02 loses money on
 * every send. A floor of $0.10 makes the fee ($0.01) cover the gas.
 *
 * Applied in three places, with ONE function ({@link paidPriceBelowFloor}):
 *
 * - the binding editor refuses to create or update a PAID or FREEMIUM binding
 *   priced below it (`PROVIDER_BINDING_PRICE_BELOW_MINIMUM`);
 * - rail-B admission refuses a paid call to an existing binding priced below
 *   it (`PAYMENT_PRICE_BELOW_MINIMUM`), before any seq, voucher or hold.
 *
 * - the router, offering a paid rail-B call, draws among the bindings at or
 *   above it while any of them can serve (`RoutingContext.belowPaidPriceFloor`),
 *   so a call is refused only when every candidate is below it.
 *
 * The editor judges a create, and an update that sets a NEW price (amount,
 * asset, or a switch from FREE to a charging mode). Other edits of a binding
 * priced below it before the floor existed are allowed.
 *
 * Free calls (FREE bindings, and the free tier of a FREEMIUM one) never reach
 * either check.
 *
 * **Rail A is not checked** (owner decision 2026-10-30). A rail-A call is
 * settled against the ledger and the provider is credited there: it sends no
 * per-call redeem or collect on chain, so it costs the platform none of the
 * gas the floor exists to cover.
 *
 * ## Exempt providers
 *
 * `MIN_PAID_PRICE_EXEMPT_PROVIDER_IDS` lists the provider organizations the
 * floor does not apply to: the platform's own internal tools. Their provider is
 * the platform itself, so the whole price — not just the 10 % fee — comes back
 * to it, and the floor's purpose (no call may cost the platform more gas than
 * it earns) does not apply. Matched against the BINDING's provider id — the
 * row's `organization_id` in the editor, the router's offered provider at
 * admission — never against anything the caller sends.
 */

/** Read when nothing overrides it: $0.10. */
export const DEFAULT_MIN_PAID_PRICE_USD = '0.10';

/** Injection token: the floor a service enforces. Unprovided, the env value below is used. */
export const PAID_PRICE_FLOOR = 'PAID_PRICE_FLOOR';

export interface PaidPriceFloor {
  /** The minimum, as a decimal number of US dollars (`'0.10'`). `'0'` turns the floor off. */
  readonly minUsd: string;
  /** Provider organization ids the floor does not apply to, lower-case. */
  readonly exemptProviderIds: ReadonlySet<string>;
}

/** A floor that admits every price — what a test of something else wants. */
export const NO_PAID_PRICE_FLOOR: PaidPriceFloor = Object.freeze({
  minUsd: '0',
  exemptProviderIds: new Set<string>(),
});

const USD_PATTERN = /^\d{1,6}(\.\d{1,18})?$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `MIN_PAID_PRICE_USD` (default `0.10`) and `MIN_PAID_PRICE_EXEMPT_PROVIDER_IDS`
 * (comma-separated UUIDs, default none). A malformed value refuses to boot: a
 * silently different floor changes which calls lose money.
 */
export function loadPaidPriceFloor(env: NodeJS.ProcessEnv = process.env): PaidPriceFloor {
  const raw = env.MIN_PAID_PRICE_USD;
  const minUsd = raw === undefined || raw === '' ? DEFAULT_MIN_PAID_PRICE_USD : raw.trim();
  if (!USD_PATTERN.test(minUsd)) {
    throw new Error(`MIN_PAID_PRICE_USD must be a decimal number of dollars, got "${raw}"`);
  }
  const exemptProviderIds = new Set<string>();
  for (const part of (env.MIN_PAID_PRICE_EXEMPT_PROVIDER_IDS ?? '').split(',')) {
    const id = part.trim();
    if (id === '') continue;
    if (!UUID_PATTERN.test(id)) {
      throw new Error(`MIN_PAID_PRICE_EXEMPT_PROVIDER_IDS must list UUIDs, got "${id}"`);
    }
    exemptProviderIds.add(id.toLowerCase());
  }
  return { minUsd, exemptProviderIds };
}

/** The floor this process enforces, read once at import. */
export const PAID_PRICE_FLOOR_FROM_ENV: PaidPriceFloor = loadPaidPriceFloor();

/**
 * The floor in atomic units of an asset with `decimals`, rounded UP (a floor
 * finer than the asset's scale must not round below itself).
 *
 * Every asset the platform settles in is a USD stablecoin (USDC, USDG), so a
 * dollar amount converts with the asset's decimals alone: `0.10` at 6 decimals
 * is `100000`. An asset that is not pegged to the dollar would need a rate
 * here, and none is registered.
 */
export function minPaidPriceAtomic(floor: PaidPriceFloor, decimals: number): bigint {
  const [whole, fraction = ''] = floor.minUsd.split('.');
  const kept = fraction.slice(0, decimals).padEnd(decimals, '0');
  const dropped = fraction.slice(decimals);
  const atomic = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(kept === '' ? '0' : kept);
  return /[1-9]/.test(dropped) ? atomic + 1n : atomic;
}

/** Whether the floor applies to a binding of `providerId` at all. */
export function isFloorExempt(floor: PaidPriceFloor, providerId: string | null): boolean {
  return providerId !== null && floor.exemptProviderIds.has(providerId.toLowerCase());
}

/**
 * The minimum a binding of `providerId` must charge per paid call, in atomic
 * units: `0n` when the provider is exempt or the floor is off.
 */
export function minPaidPriceFor(
  floor: PaidPriceFloor,
  providerId: string | null,
  decimals: number,
): bigint {
  return isFloorExempt(floor, providerId) ? 0n : minPaidPriceAtomic(floor, decimals);
}

/**
 * The minimum, when a paid price of `priceAmount` (atomic) charged by
 * `providerId` is below it; `null` when the price is allowed. Exactly the
 * minimum is allowed.
 */
export function paidPriceBelowFloor(
  floor: PaidPriceFloor,
  providerId: string | null,
  priceAmount: string | bigint,
  decimals: number,
): bigint | null {
  const minimum = minPaidPriceFor(floor, providerId, decimals);
  return BigInt(priceAmount) < minimum ? minimum : null;
}

/** `100000` at 6 decimals reads `0.10`: at least two places, trailing zeros past them trimmed. */
export function formatAtomicUsd(atomic: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const whole = atomic / scale;
  const fraction = (atomic % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${whole}.${fraction.padEnd(2, '0')}`;
}
