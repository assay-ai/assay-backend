/** One stored withdrawal log, as the history folds it. */
export interface WithdrawalEventFact {
  readonly id: string;
  readonly chainId: string;
  readonly buyerAddress: string;
  readonly kind: 'REQUESTED' | 'CANCELLED' | 'WITHDRAWN';
  readonly amount: bigint;
  readonly requested: bigint | null;
  readonly availableAt: Date | null;
  readonly transactionHash: string;
  readonly blockTime: Date;
}

/**
 * - `PENDING`: requested, neither claimed nor cancelled yet (as far as the
 *   index has read; the live escrow is the authority on whether it stands).
 * - `CLAIMED`: paid out; `received` can be below `requested` when a payment
 *   landed during the hour.
 * - `CANCELLED`: the buyer withdrew the request.
 * - `REPLACED`: a newer request overwrote it before it was claimed.
 */
export type WithdrawalStatus = 'PENDING' | 'CLAIMED' | 'CANCELLED' | 'REPLACED';

export interface WithdrawalRecord {
  readonly id: string;
  readonly chainId: string;
  readonly buyerAddress: string;
  readonly status: WithdrawalStatus;
  /** What was asked for. `null` for a claim whose request predates the index. */
  readonly requested: bigint | null;
  /** What the contract paid. `null` unless `CLAIMED`. */
  readonly received: bigint | null;
  readonly requestedAt: Date | null;
  readonly claimableAt: Date | null;
  /** When it was claimed, cancelled or replaced. */
  readonly closedAt: Date | null;
  readonly requestTransactionHash: string | null;
  readonly closeTransactionHash: string | null;
}

interface Open {
  id: string;
  requested: bigint;
  requestedAt: Date;
  claimableAt: Date | null;
  transactionHash: string;
}

/**
 * Folds one chain-ordered event list into withdrawals, newest first. The
 * contract keeps one request slot per buyer, so per buyer at most one request
 * is open at a time: a new request replaces it, `0` cancels it, a claim
 * closes it.
 */
export function foldWithdrawals(events: readonly WithdrawalEventFact[]): WithdrawalRecord[] {
  const open = new Map<string, Open>();
  const records: WithdrawalRecord[] = [];

  const close = (
    key: string,
    event: WithdrawalEventFact,
    status: WithdrawalStatus,
    received: bigint | null,
  ): void => {
    const current = open.get(key);
    open.delete(key);
    if (!current) {
      // A claim whose request the index never read; a cancel of nothing is noise.
      if (status !== 'CLAIMED') return;
      records.push({
        id: event.id,
        chainId: event.chainId,
        buyerAddress: event.buyerAddress,
        status,
        requested: event.requested,
        received,
        requestedAt: null,
        claimableAt: null,
        closedAt: event.blockTime,
        requestTransactionHash: null,
        closeTransactionHash: event.transactionHash,
      });
      return;
    }
    records.push({
      id: current.id,
      chainId: event.chainId,
      buyerAddress: event.buyerAddress,
      status,
      requested: current.requested,
      received,
      requestedAt: current.requestedAt,
      claimableAt: current.claimableAt,
      closedAt: event.blockTime,
      requestTransactionHash: current.transactionHash,
      closeTransactionHash: event.transactionHash,
    });
  };

  for (const event of events) {
    const key = `${event.chainId}:${event.buyerAddress}`;
    switch (event.kind) {
      case 'REQUESTED':
        if (open.has(key)) close(key, event, 'REPLACED', null);
        open.set(key, {
          id: event.id,
          requested: event.amount,
          requestedAt: event.blockTime,
          claimableAt: event.availableAt,
          transactionHash: event.transactionHash,
        });
        break;
      case 'CANCELLED':
        close(key, event, 'CANCELLED', null);
        break;
      case 'WITHDRAWN':
        close(key, event, 'CLAIMED', event.amount);
        break;
    }
  }

  for (const [key, current] of open) {
    const [chainId, buyerAddress] = splitKey(key);
    records.push({
      id: current.id,
      chainId,
      buyerAddress,
      status: 'PENDING',
      requested: current.requested,
      received: null,
      requestedAt: current.requestedAt,
      claimableAt: current.claimableAt,
      closedAt: null,
      requestTransactionHash: current.transactionHash,
      closeTransactionHash: null,
    });
  }

  return records.sort((left, right) => sortTime(right) - sortTime(left));
}

function sortTime(record: WithdrawalRecord): number {
  return (record.requestedAt ?? record.closedAt ?? new Date(0)).getTime();
}

/** `eip155:46630:0xabc…` → [`eip155:46630`, `0xabc…`]. */
function splitKey(key: string): [string, string] {
  const at = key.lastIndexOf(':');
  return [key.slice(0, at), key.slice(at + 1)];
}
