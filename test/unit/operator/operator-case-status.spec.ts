import {
  OperatorCaseFacts,
  OperatorCaseStatus,
  operatorCaseDeadlineOf,
  operatorCaseStatusOf,
} from '@modules/operator/domain/operator-case-status';

/**
 * The list's status and deadline, as the console case screen reads the same
 * case (`case-flow.ts` `caseFacts`). The SQL the list runs is held to these
 * functions by `operator-case-list.integration.spec.ts`.
 */
const EVM = 'eip155:46630/erc20:0xdbbc156dd414f43f2c952c1be0f16a0b9a826cd3';
const SOLANA =
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/spl:EPjFWdd5AufqSSqeM2qJxw2Ny5Mdc1qzE9CzXJqNnLuP';
const TIMEOUT_MS = 30 * 86_400_000;
const DISPUTED_AT = new Date('2026-10-01T00:00:00Z');
const CHAIN_DOOR = new Date('2026-10-04T00:00:00Z');
const FLOOR = new Date('2026-10-05T00:00:00Z');
const PLATFORM_DUE = new Date('2026-10-08T00:00:00Z');

function facts(patch: Partial<OperatorCaseFacts>): OperatorCaseFacts {
  return {
    assetId: EVM,
    status: 'PROPOSED',
    chainStatus: 'PENDING',
    resolutionKind: null,
    chainDisputedAt: null,
    chainDisputedParts: 0,
    chainExecutableAt: CHAIN_DOOR,
    earliestExecutionAt: FLOOR,
    platformDecisionDueAt: null,
    ...patch,
  };
}

function read(patch: Partial<OperatorCaseFacts>) {
  const row = facts(patch);
  const status = operatorCaseStatusOf(row);
  return { status, deadline: operatorCaseDeadlineOf(row, status, TIMEOUT_MS) };
}

describe('operatorCaseStatusOf / operatorCaseDeadlineOf', () => {
  it('D1: an EVM case left DISPUTED with no disputed part reads by its record, window open', () => {
    // Part A was disputed and then cancelled (or expired) while part B stands
    // pending and undisputed: the case status stays DISPUTED, the chain mirror
    // PENDING with 0 disputed parts, and no platform deadline runs on EVM.
    for (const status of ['DISPUTED', 'UNDER_REVIEW', 'AWAITING_SECOND']) {
      expect(read({ status, chainDisputedAt: DISPUTED_AT, platformDecisionDueAt: null })).toEqual({
        status: OperatorCaseStatus.PROPOSED,
        deadline: CHAIN_DOOR,
      });
    }
  });

  it('keeps the off-chain DISPUTED, and its platform deadline, for a non-EVM case', () => {
    expect(
      read({ assetId: SOLANA, status: 'DISPUTED', platformDecisionDueAt: PLATFORM_DUE }),
    ).toEqual({ status: OperatorCaseStatus.DISPUTED, deadline: PLATFORM_DUE });
  });

  it("D2: the PROPOSED deadline is the screen's executableAt: the chain's door, else the floor", () => {
    expect(read({}).deadline).toEqual(CHAIN_DOOR);
    expect(read({ chainExecutableAt: new Date('2026-10-09T00:00:00Z') }).deadline).toEqual(
      new Date('2026-10-09T00:00:00Z'),
    );
    expect(read({ chainStatus: 'NONE', chainExecutableAt: null })).toEqual({
      status: OperatorCaseStatus.PROPOSED,
      deadline: FLOOR,
    });
  });

  it('D4: a chain refusal on an open case is not a cancel; a voided one is', () => {
    expect(read({ chainStatus: 'REFUSED', chainExecutableAt: null }).status).toBe(
      OperatorCaseStatus.PROPOSED,
    );
    expect(
      read({ status: 'CANCELLED', chainStatus: 'REFUSED', resolutionKind: 'AUTO_CHAIN_VOIDED' })
        .status,
    ).toBe(OperatorCaseStatus.CANCELLED);
  });

  it("D3: the arbiter's cancel is CANCELLED; an unruled dispute's expiry is EXPIRED", () => {
    const closed = { status: 'CANCELLED', chainStatus: 'CANCELLED', chainDisputedAt: DISPUTED_AT };
    expect(read({ ...closed, resolutionKind: 'CHAIN_ARBITER' })).toEqual({
      status: OperatorCaseStatus.CANCELLED,
      deadline: null,
    });
    expect(read({ ...closed, resolutionKind: 'AUTO_CHAIN_VOIDED' })).toEqual({
      status: OperatorCaseStatus.EXPIRED,
      deadline: null,
    });
  });

  it('a dispute on chain, whole or in part, runs to its 30-day lapse', () => {
    const lapse = new Date(DISPUTED_AT.getTime() + TIMEOUT_MS);
    expect(
      read({ status: 'DISPUTED', chainStatus: 'DISPUTED', chainDisputedAt: DISPUTED_AT }),
    ).toEqual({ status: OperatorCaseStatus.CHAIN_DISPUTED, deadline: lapse });
    expect(
      read({ status: 'DISPUTED', chainDisputedParts: 1, chainDisputedAt: DISPUTED_AT }),
    ).toEqual({ status: OperatorCaseStatus.CHAIN_DISPUTED, deadline: lapse });
  });

  it('a cancel waiting for its signature: the lapse under a disputed record, else the door', () => {
    const lapse = new Date(DISPUTED_AT.getTime() + TIMEOUT_MS);
    const cancel = { status: 'CANCELLED', chainStatus: 'CANCEL_REQUESTED' };
    expect(read({ ...cancel, chainDisputedAt: DISPUTED_AT, chainDisputedParts: 1 })).toEqual({
      status: OperatorCaseStatus.CANCEL_REQUESTED,
      deadline: lapse,
    });
    expect(read(cancel)).toEqual({
      status: OperatorCaseStatus.CANCEL_REQUESTED,
      deadline: CHAIN_DOOR,
    });
  });

  it('money that moved wins: executed, then compensated', () => {
    expect(read({ status: 'CANCELLED', chainStatus: 'EXECUTED' }).status).toBe(
      OperatorCaseStatus.EXECUTED,
    );
    expect(read({ status: 'REVERSED', chainStatus: 'EXECUTED' }).status).toBe(
      OperatorCaseStatus.COMPENSATED,
    );
  });

  it('an arbiter-upheld case still pending reads PROPOSED (the vocabulary has no UPHELD)', () => {
    expect(
      read({ status: 'UPHELD', resolutionKind: 'CHAIN_ARBITER', chainDisputedAt: DISPUTED_AT }),
    ).toEqual({ status: OperatorCaseStatus.PROPOSED, deadline: CHAIN_DOOR });
  });
});
