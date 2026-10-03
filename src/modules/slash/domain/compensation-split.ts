/**
 * Dividing the agent share of a penalty across the agents it is owed to.
 *
 * A window-level penalty is paid **once** on chain, into the platform's
 * settlement vault, and split **in the ledger** afterwards. This
 * is that split, and it is deliberately pure: no repository, no clock, no
 * money type — just the arithmetic, so its tests prove the arithmetic and
 * nothing else. The database facts it depends on get their own integration
 * test rather than being faked here, because a suite over an in-memory double
 * cannot see a constraint the database enforces.
 *
 * ## The property that matters is exactness, not fairness
 *
 * The vault gains exactly `agentAmount` on chain. If the credits do not sum to
 * exactly `agentAmount`, the ledger and the vault disagree by the difference,
 * and proof of reserves reports a surplus or a shortfall that is attributable
 * to nothing. Flooring each share loses dust; scaling it up invents money.
 *
 * So shares are floored and the remainder is then handed out one unit at a
 * time, largest fractional part first — the largest-remainder method. Ties
 * break on `agentAccount` ascending so two runs over the same window produce
 * the same answer regardless of row order.
 *
 * ## `bigint` throughout, never `number`
 *
 * Minor units of a 6-decimal asset exceed `Number.MAX_SAFE_INTEGER` long before
 * they exceed anything else, and this codebase has already lost money once to a
 * float conversion. There is no `Number(...)` in this file.
 */

/** One agent's spend inside the window a penalty was raised for. */
export interface WindowSpend {
  /** The agent's own organization — the ledger is scoped by it. */
  readonly organizationId: string;
  /** CAIP-10, and the ledger `accountId` the credit is written against. */
  readonly agentAccount: string;
  /** Minor units. */
  readonly spend: bigint;
}

/** One ledger credit to write. Never zero — see {@link splitCompensation}. */
export interface CompensationCredit {
  readonly organizationId: string;
  readonly agentAccount: string;
  readonly amount: bigint;
}

/**
 * Split `agentAmount` across `spends`, in proportion to spend.
 *
 * Returns an empty list — rather than throwing — when there is nothing to
 * share or nobody to share it with. Both are ordinary: a penalty can be capped
 * to nothing by the stake, and a window can close with no paid calls in it.
 *
 * Credits of zero are **omitted**. A zero-amount journal entry is a liability
 * of nothing, and it would also raise a "you were compensated" notification
 * about no money.
 */
export function splitCompensation(
  agentAmount: bigint,
  spends: readonly WindowSpend[],
): readonly CompensationCredit[] {
  if (agentAmount <= 0n) return [];

  const total = spends.reduce((sum, row) => sum + row.spend, 0n);
  if (total <= 0n) return [];

  // Floor first, and keep each row's remainder as a numerator over `total` so
  // the comparison below stays in integers. `(spend * amount) % total` is that
  // numerator exactly; dividing it out would reintroduce the float this file
  // exists to avoid.
  const allocated = spends.map((row) => {
    const scaled = row.spend * agentAmount;
    return {
      organizationId: row.organizationId,
      agentAccount: row.agentAccount,
      amount: scaled / total,
      remainder: scaled % total,
    };
  });

  let distributed = allocated.reduce((sum, row) => sum + row.amount, 0n);

  // At most `spends.length - 1` units are ever left over, so this terminates
  // without a guard: each pass hands out one unit to a distinct row.
  const byRemainder = [...allocated].sort(
    (left, right) =>
      compareBigInt(right.remainder, left.remainder) ||
      left.agentAccount.localeCompare(right.agentAccount),
  );

  for (const row of byRemainder) {
    if (distributed >= agentAmount) break;
    row.amount += 1n;
    distributed += 1n;
  }

  return allocated
    .filter((row) => row.amount > 0n)
    .map(({ organizationId, agentAccount, amount }) => ({
      organizationId,
      agentAccount,
      amount,
    }));
}

function compareBigInt(left: bigint, right: bigint): number {
  if (left === right) return 0;
  return left > right ? 1 : -1;
}
