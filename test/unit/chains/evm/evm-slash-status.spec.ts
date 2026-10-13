import { slashStatusFromEvm, slashStatusToEvm } from '@modules/chains/evm/evm-slash-status';

/**
 * `SlashStatus` is 0/1/2 on Solana and 1/2/3 on EVM, because a Solidity mapping
 * returns a zero-valued struct for a key never written and `None` must BE zero
 * or an unproposed request id reads back as `Pending`.
 *
 * A cast is silently wrong in the worst possible direction: `Executed` on
 * Solana (1) reads as `Pending` on EVM, and `Cancelled` (2) reads as
 * `Executed`. Both are `uint8`, so nothing type-checks.
 */
describe('the EVM slash status map', () => {
  it.each([
    [1, 'PENDING'],
    [2, 'EXECUTED'],
    [3, 'CANCELLED'],
    // The dispute upgrade's appended member (D-19).
    [4, 'DISPUTED'],
  ])('EVM %i is %s', (value, name) => {
    expect(slashStatusFromEvm(value as number)).toBe(name);
  });

  it('EVM 0 is "no record", not PENDING', () => {
    // The whole reason the two enums differ. A reader that returns PENDING here
    // reports a slash proposal that was never made.
    expect(slashStatusFromEvm(0)).toBeNull();
  });

  it('refuses a value outside the enum rather than defaulting', () => {
    expect(() => slashStatusFromEvm(5)).toThrow(/SlashStatus/);
    expect(() => slashStatusFromEvm(-1)).toThrow(/SlashStatus/);
  });

  it('refuses a non-integer rather than reading it through a Record lookup', () => {
    // `1.0` is `1` and fine; `1.5` is not a `uint8` any chain produced, and
    // `value in FROM_EVM` on a fractional key is false — so this is about the
    // refusal being a refusal rather than a `TypeError` further down.
    expect(() => slashStatusFromEvm(1.5)).toThrow(/SlashStatus/);
    expect(() => slashStatusFromEvm(Number.NaN)).toThrow(/SlashStatus/);
  });

  it('round-trips every named status', () => {
    for (const status of ['PENDING', 'EXECUTED', 'CANCELLED', 'DISPUTED'] as const) {
      expect(slashStatusFromEvm(slashStatusToEvm(status))).toBe(status);
    }
  });

  it('the two numbering schemes really do differ by one', () => {
    // Pins the FACT the map exists for. If a future EVM change adds a member
    // and the offset becomes two, this fails and somebody re-reads the enum.
    const SOLANA = { PENDING: 0, EXECUTED: 1, CANCELLED: 2 } as const;
    for (const status of ['PENDING', 'EXECUTED', 'CANCELLED'] as const) {
      expect(slashStatusToEvm(status) - SOLANA[status]).toBe(1);
    }
  });

  it('never maps a named status onto EVM 0', () => {
    // The other direction of the same defect: writing `None` for a real
    // judgement would make an executed slash read back as "there is no record
    // here" on the next poll.
    for (const status of ['PENDING', 'EXECUTED', 'CANCELLED', 'DISPUTED'] as const) {
      expect(slashStatusToEvm(status)).not.toBe(0);
    }
  });
});
