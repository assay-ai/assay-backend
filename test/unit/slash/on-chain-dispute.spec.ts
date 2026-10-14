import { DISPUTE_TIMEOUT_MS } from '@modules/slash/constants/slash.constants';
import {
  disputesOnChain,
  OnChainDisputeMirror,
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
});
