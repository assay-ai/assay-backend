import {
  HoldResolutionKind,
  decideHoldTransition,
  isTerminal,
} from '@modules/ledger/domain/hold-transition';
import { LedgerEntryType, LedgerHoldStatus } from '@modules/ledger/ports/ledger.types';
import { LedgerErrorCode } from '@modules/ledger/errors/ledger.errors';
import { expectErrorCode } from '../helpers/expect-error-code';

const RESOLUTIONS: readonly HoldResolutionKind[] = [
  LedgerHoldStatus.RELEASED,
  LedgerHoldStatus.COMMITTED,
];
const STATUSES: readonly LedgerHoldStatus[] = [
  LedgerHoldStatus.OPEN,
  LedgerHoldStatus.RELEASED,
  LedgerHoldStatus.COMMITTED,
];

const CONTEXT = { holdId: 'hold-1', intentId: 'intent-1' };

describe('decideHoldTransition — exhaustive over status x resolution', () => {
  it.each(STATUSES.flatMap((status) => RESOLUTIONS.map((resolution) => [status, resolution])))(
    'from %s, resolving as %s',
    (status: LedgerHoldStatus, resolution: HoldResolutionKind) => {
      if (status === LedgerHoldStatus.OPEN) {
        const decision = decideHoldTransition(status, resolution, CONTEXT);
        expect(decision).toEqual({
          kind: 'APPLY',
          to: resolution,
          entryType:
            resolution === LedgerHoldStatus.RELEASED
              ? LedgerEntryType.HOLD_RELEASE
              : LedgerEntryType.HOLD_COMMIT,
        });
        return;
      }

      if (status === resolution) {
        expect(decideHoldTransition(status, resolution, CONTEXT)).toEqual({ kind: 'NOOP' });
        return;
      }

      // status is a terminal state different from the requested resolution:
      // RELEASED -> COMMITTED or COMMITTED -> RELEASED.
      expectErrorCode(
        () => decideHoldTransition(status, resolution, CONTEXT),
        LedgerErrorCode.LEDGER_HOLD_ALREADY_RESOLVED,
      );
    },
  );

  it('OPEN resolved as RELEASED applies HOLD_RELEASE specifically', () => {
    expect(decideHoldTransition(LedgerHoldStatus.OPEN, LedgerHoldStatus.RELEASED, CONTEXT)).toEqual(
      { kind: 'APPLY', to: LedgerHoldStatus.RELEASED, entryType: LedgerEntryType.HOLD_RELEASE },
    );
  });

  it('OPEN resolved as COMMITTED applies HOLD_COMMIT specifically', () => {
    expect(
      decideHoldTransition(LedgerHoldStatus.OPEN, LedgerHoldStatus.COMMITTED, CONTEXT),
    ).toEqual({
      kind: 'APPLY',
      to: LedgerHoldStatus.COMMITTED,
      entryType: LedgerEntryType.HOLD_COMMIT,
    });
  });

  it('repeating RELEASED is a no-op, not a re-application', () => {
    expect(
      decideHoldTransition(LedgerHoldStatus.RELEASED, LedgerHoldStatus.RELEASED, CONTEXT),
    ).toEqual({ kind: 'NOOP' });
  });

  it('repeating COMMITTED is a no-op, not a re-application', () => {
    expect(
      decideHoldTransition(LedgerHoldStatus.COMMITTED, LedgerHoldStatus.COMMITTED, CONTEXT),
    ).toEqual({ kind: 'NOOP' });
  });

  it('committing an already-released hold is rejected by error CODE, not message', () => {
    expectErrorCode(
      () => decideHoldTransition(LedgerHoldStatus.RELEASED, LedgerHoldStatus.COMMITTED, CONTEXT),
      LedgerErrorCode.LEDGER_HOLD_ALREADY_RESOLVED,
    );
  });

  it('releasing an already-committed hold is rejected by error CODE, not message', () => {
    expectErrorCode(
      () => decideHoldTransition(LedgerHoldStatus.COMMITTED, LedgerHoldStatus.RELEASED, CONTEXT),
      LedgerErrorCode.LEDGER_HOLD_ALREADY_RESOLVED,
    );
  });
});

describe('isTerminal', () => {
  it('OPEN is not terminal — it is the only state value can still move from', () => {
    expect(isTerminal(LedgerHoldStatus.OPEN)).toBe(false);
  });

  it('RELEASED and COMMITTED are both terminal', () => {
    expect(isTerminal(LedgerHoldStatus.RELEASED)).toBe(true);
    expect(isTerminal(LedgerHoldStatus.COMMITTED)).toBe(true);
  });
});
