import { foldWithdrawals, WithdrawalEventFact } from '@modules/ledger/domain/withdrawal-history';

const CHAIN = 'eip155:46630';
const A = '0xaaaa';
const B = '0xbbbb';

let n = 0;
function event(
  kind: WithdrawalEventFact['kind'],
  minute: number,
  amount: bigint,
  overrides: Partial<WithdrawalEventFact> = {},
): WithdrawalEventFact {
  n += 1;
  return {
    id: `e${n}`,
    chainId: CHAIN,
    buyerAddress: A,
    kind,
    amount,
    requested: null,
    availableAt: kind === 'REQUESTED' ? new Date(Date.UTC(2026, 9, 1, 1, minute)) : null,
    transactionHash: `0x${n}`,
    blockTime: new Date(Date.UTC(2026, 9, 1, 0, minute)),
    ...overrides,
  };
}

describe('foldWithdrawals (B7)', () => {
  it('pairs each request with what became of it, newest first', () => {
    const records = foldWithdrawals([
      event('REQUESTED', 1, 5n),
      event('REQUESTED', 2, 7n),
      event('CANCELLED', 3, 0n),
      event('REQUESTED', 4, 10n),
      event('WITHDRAWN', 70, 9n, { requested: 10n }),
      event('REQUESTED', 80, 3n),
    ]);

    expect(records.map((record) => [record.status, record.requested, record.received])).toEqual([
      ['PENDING', 3n, null],
      ['CLAIMED', 10n, 9n],
      ['CANCELLED', 7n, null],
      ['REPLACED', 5n, null],
    ]);
    expect(records[1].closedAt).toEqual(new Date(Date.UTC(2026, 9, 1, 1, 10)));
  });

  it('keeps a claim whose request predates the index, and drops a cancel of nothing', () => {
    const records = foldWithdrawals([
      event('CANCELLED', 1, 0n),
      event('WITHDRAWN', 2, 4n, { requested: 6n }),
    ]);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      status: 'CLAIMED',
      requested: 6n,
      received: 4n,
      requestedAt: null,
      requestTransactionHash: null,
    });
  });

  it('keeps buyers apart', () => {
    const records = foldWithdrawals([
      event('REQUESTED', 1, 5n),
      event('REQUESTED', 2, 8n, { buyerAddress: B }),
      event('WITHDRAWN', 70, 5n, { requested: 5n }),
    ]);

    expect(records.map((record) => [record.buyerAddress, record.status])).toEqual([
      [B, 'PENDING'],
      [A, 'CLAIMED'],
    ]);
  });
});
