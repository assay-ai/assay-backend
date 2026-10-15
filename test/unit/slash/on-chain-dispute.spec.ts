import { DISPUTE_TIMEOUT_MS } from '@modules/slash/constants/slash.constants';
import {
  disputeByOf,
  disputesOnChain,
  OnChainDisputeMirror,
  OnChainRecordMirror,
  OnChainDisputeState,
  onChainDisputeState,
} from '@modules/slash/domain/on-chain-dispute';

const EVM = 'eip155:46630/erc20:0xdbbc156dd414f43f2c952c1be0f16a0b9a826cd3';
const SOLANA =
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/spl:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const DISPUTED_AT = new Date('2026-10-01T00:00:00Z');

function mirror(patch: Partial<OnChainDisputeMirror>): OnChainDisputeMirror {
  return {
    assetId: EVM,
    chainStatus: 'PENDING',
    chainDisputedAt: null,
    chainDisputeWonAt: null,
    chainDisputedParts: 0,
    ...patch,
  };
}

const state = (patch: Partial<OnChainDisputeMirror>) =>
  onChainDisputeState(mirror(patch), DISPUTE_TIMEOUT_MS);

describe('the on-chain dispute', () => {
  it('is the dispute on EVM only', () => {
    expect(disputesOnChain(EVM)).toBe(true);
    expect(disputesOnChain(SOLANA)).toBe(false);
  });

  describe('the record state, from the mirror', () => {
    it('is null off EVM and before a record stands', () => {
      expect(state({ assetId: SOLANA })).toBeNull();
      expect(state({ chainStatus: 'NONE' })).toBeNull();
      expect(state({ chainStatus: 'PROPOSING' })).toBeNull();
    });

    it.each([
      ['PENDING, never disputed', { chainStatus: 'PENDING' }, OnChainDisputeState.PENDING],
      [
        'DISPUTED',
        { chainStatus: 'DISPUTED', chainDisputedAt: DISPUTED_AT },
        OnChainDisputeState.DISPUTED,
      ],
      [
        'PENDING with a part disputed',
        { chainStatus: 'PENDING', chainDisputedAt: DISPUTED_AT, chainDisputedParts: 1 },
        OnChainDisputeState.DISPUTED,
      ],
      [
        'PENDING again after a dispute (the arbiter upheld)',
        { chainStatus: 'PENDING', chainDisputedAt: DISPUTED_AT },
        OnChainDisputeState.UPHELD,
      ],
      [
        'EXECUTED',
        { chainStatus: 'EXECUTED', chainDisputedAt: DISPUTED_AT },
        OnChainDisputeState.EXECUTED,
      ],
      [
        'CANCELLED by the arbiter',
        {
          chainStatus: 'CANCELLED',
          chainDisputedAt: DISPUTED_AT,
          chainDisputeWonAt: new Date(DISPUTED_AT.getTime() + 60_000),
        },
        OnChainDisputeState.CANCELLED,
      ],
      ['CANCELLED undisputed', { chainStatus: 'CANCELLED' }, OnChainDisputeState.CANCELLED],
      [
        'CANCELLED 30 days after the dispute (expired unruled)',
        {
          chainStatus: 'CANCELLED',
          chainDisputedAt: DISPUTED_AT,
          chainDisputeWonAt: new Date(DISPUTED_AT.getTime() + DISPUTE_TIMEOUT_MS),
        },
        OnChainDisputeState.EXPIRED,
      ],
    ])('reads %s', (_name, patch, expected) => {
      expect(state(patch)).toBe(expected);
    });
  });

  describe('per record (review N-4)', () => {
    const DOOR = new Date('2026-10-20T00:00:00Z');
    const record = (patch: Partial<OnChainRecordMirror>): OnChainRecordMirror => ({
      chainStatus: 'PENDING',
      chainDisputedAt: null,
      chainExecutableAt: DOOR,
      cancelReason: null,
      ...patch,
    });
    const of = (records: OnChainRecordMirror[]) =>
      onChainDisputeState(mirror({ records }), DISPUTE_TIMEOUT_MS);

    it('is not UPHELD after the arbiter cancelled one part while the others stand undisputed', () => {
      const records = [
        record({
          chainStatus: 'CANCELLED',
          chainDisputedAt: DISPUTED_AT,
          cancelReason: 'WITHDRAWN',
        }),
        record({}),
      ];
      // The case mirror says PENDING with a dispute date behind it.
      expect(
        onChainDisputeState(mirror({ chainDisputedAt: DISPUTED_AT, records }), DISPUTE_TIMEOUT_MS),
      ).toBe(OnChainDisputeState.PENDING);
    });

    it('reads DISPUTED while any part is disputed, UPHELD only when every pending part was', () => {
      expect(
        of([record({ chainStatus: 'DISPUTED', chainDisputedAt: DISPUTED_AT }), record({})]),
      ).toBe(OnChainDisputeState.DISPUTED);
      expect(of([record({ chainDisputedAt: DISPUTED_AT })])).toBe(OnChainDisputeState.UPHELD);
    });

    it('reads EXECUTED when every record executed and nothing stands', () => {
      expect(of([record({ chainStatus: 'EXECUTED' }), record({ chainStatus: 'EXECUTED' })])).toBe(
        OnChainDisputeState.EXECUTED,
      );
    });

    it('R2-3: reads PARTIALLY_EXECUTED when a record executed and another was cancelled', () => {
      expect(
        of([
          record({ chainStatus: 'EXECUTED' }),
          record({
            chainStatus: 'CANCELLED',
            chainDisputedAt: DISPUTED_AT,
            cancelReason: 'WITHDRAWN',
          }),
        ]),
      ).toBe(OnChainDisputeState.PARTIALLY_EXECUTED);
    });

    it('tells an undisputed record that lapsed from a cancel and from an unruled dispute', () => {
      expect(of([record({ chainStatus: 'CANCELLED', cancelReason: 'EXPIRED' })])).toBe(
        OnChainDisputeState.LAPSED,
      );
      expect(of([record({ chainStatus: 'CANCELLED', cancelReason: 'VERIFIER_UNAVAILABLE' })])).toBe(
        OnChainDisputeState.LAPSED,
      );
      expect(of([record({ chainStatus: 'CANCELLED', cancelReason: 'WITHDRAWN' })])).toBe(
        OnChainDisputeState.CANCELLED,
      );
      expect(
        of([
          record({
            chainStatus: 'CANCELLED',
            chainDisputedAt: DISPUTED_AT,
            cancelReason: 'DISPUTE_UNRESOLVED',
          }),
        ]),
      ).toBe(OnChainDisputeState.EXPIRED);
    });

    it('can still be disputed while any part stands pending and was never disputed', () => {
      const earlier = new Date('2026-10-19T00:00:00Z');
      expect(
        disputeByOf([
          record({
            chainStatus: 'DISPUTED',
            chainDisputedAt: DISPUTED_AT,
            chainExecutableAt: earlier,
          }),
          record({}),
        ]),
      ).toEqual(DOOR);
      expect(disputeByOf([record({ chainDisputedAt: DISPUTED_AT })])).toBeNull();
      expect(disputeByOf([record({ chainStatus: 'EXECUTED' })])).toBeNull();
    });
  });
});
