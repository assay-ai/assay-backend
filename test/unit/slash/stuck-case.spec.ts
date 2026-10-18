import {
  ChainRecordState,
  classifyRecord,
  StuckCaseAction,
  StuckCaseFacts,
  StuckCaseRead,
  stuckCaseOptions,
  stuckCaseRefusal,
} from '@modules/slash/domain/stuck-case';
import { SlashRecordSnapshot } from '@modules/slash/ports/slash-executor.port';

/**
 * B18: the guard of the three manual actions on a case stuck behind a
 * requested cancel — every live read (STANDING, EXECUTED, GONE, UNKNOWN, and a
 * shape the sweep settles) against every case status, for every action.
 */
const STATUSES = [
  'PROPOSED',
  'DISPUTED',
  'UNDER_REVIEW',
  'AWAITING_SECOND',
  'UPHELD',
  'OVERTURNED',
  'EXECUTING',
  'EXECUTED',
  'REVERSED',
  'WAIVED',
  'CANCELLED',
] as const;

function record(status: SlashRecordSnapshot['status'], extra: Partial<SlashRecordSnapshot> = {}) {
  return { status, appliedMinor: '400000', ...extra } as SlashRecordSnapshot;
}

const READS: Record<string, StuckCaseRead | null> = {
  STANDING: { state: ChainRecordState.STANDING, record: record('PENDING'), unreadable: false },
  'STANDING (disputed)': {
    state: ChainRecordState.STANDING,
    record: record('DISPUTED'),
    unreadable: false,
  },
  EXECUTED: {
    state: ChainRecordState.EXECUTED,
    record: record('EXECUTED'),
    unreadable: false,
    beneficiaryIsAgent: true,
  },
  GONE: { state: ChainRecordState.GONE, record: record('CANCELLED'), unreadable: false },
  // Not found though a record was written: an anomaly, never "gone".
  'UNKNOWN (missing)': { state: ChainRecordState.UNKNOWN, record: null, unreadable: false },
  'UNKNOWN (unreadable)': { state: ChainRecordState.UNKNOWN, record: null, unreadable: true },
  // A single record or a case with parts: the admin-cancel sweep settles it.
  'not a stuck shape': null,
};

function facts(status: string, extra: Partial<StuckCaseFacts> = {}): StuckCaseFacts {
  return {
    status,
    chainStatus: 'CANCEL_REQUESTED',
    penaltyAmount: '1000000',
    executedAt: null,
    chainDisputeWonAt: null,
    ...extra,
  } as StuckCaseFacts;
}

/** What each action allows, by read and status; everything else is refused. */
const ALLOWED: Record<StuckCaseAction, { read: string; statuses: readonly string[] }> = {
  CLOSE_NOTHING_STANDING: { read: 'GONE', statuses: ['OVERTURNED', 'WAIVED', 'CANCELLED'] },
  RECORD_EXECUTION: {
    read: 'EXECUTED',
    statuses: STATUSES.filter((s) => !['EXECUTING', 'EXECUTED', 'REVERSED'].includes(s)),
  },
  REPROPOSE: { read: 'GONE', statuses: ['UPHELD'] },
};

describe('stuckCaseRefusal: the guard matrix', () => {
  for (const action of Object.keys(ALLOWED) as StuckCaseAction[]) {
    describe(action, () => {
      for (const [readName, read] of Object.entries(READS)) {
        it.each(STATUSES)(`read ${readName}, case %s`, (status) => {
          const refusal = stuckCaseRefusal(action, facts(status), read);
          const allowed =
            ALLOWED[action].read === readName && ALLOWED[action].statuses.includes(status);
          if (allowed) {
            expect(refusal).toBeNull();
          } else {
            expect(refusal).not.toBeNull();
          }
        });
      }
    });
  }

  it('names why: unreadable and unknown are refused, never assumed', () => {
    expect(
      stuckCaseRefusal('CLOSE_NOTHING_STANDING', facts('CANCELLED'), READS['UNKNOWN (unreadable)']),
    ).toBe('CHAIN_UNKNOWN');
    expect(
      stuckCaseRefusal('CLOSE_NOTHING_STANDING', facts('CANCELLED'), READS['UNKNOWN (missing)']),
    ).toBe('CHAIN_UNKNOWN');
    expect(stuckCaseRefusal('REPROPOSE', facts('UPHELD'), READS['UNKNOWN (missing)'])).toBe(
      'CHAIN_UNKNOWN',
    );
    expect(
      stuckCaseRefusal('RECORD_EXECUTION', facts('CANCELLED'), READS['UNKNOWN (unreadable)']),
    ).toBe('CHAIN_UNKNOWN');
  });

  it('a standing record is never closed, recorded or re-proposed', () => {
    for (const action of Object.keys(ALLOWED) as StuckCaseAction[]) {
      expect(stuckCaseRefusal(action, facts('CANCELLED'), READS.STANDING)).toBe('STANDING');
      expect(stuckCaseRefusal(action, facts('UPHELD'), READS['STANDING (disputed)'])).toBe(
        'STANDING',
      );
    }
  });

  it('an executed record is never closed as nothing taken, nor re-proposed', () => {
    expect(stuckCaseRefusal('CLOSE_NOTHING_STANDING', facts('CANCELLED'), READS.EXECUTED)).toBe(
      'EXECUTED',
    );
    expect(stuckCaseRefusal('REPROPOSE', facts('UPHELD'), READS.EXECUTED)).toBe('EXECUTED');
  });

  it('an upheld case is pointed at the re-proposal, not closed', () => {
    expect(stuckCaseRefusal('CLOSE_NOTHING_STANDING', facts('UPHELD'), READS.GONE)).toBe(
      'UPHELD_USE_REPROPOSE',
    );
  });

  it('only a CANCEL_REQUESTED mirror is stuck', () => {
    for (const chainStatus of ['NONE', 'PENDING', 'DISPUTED', 'EXECUTED', 'CANCELLED', 'REFUSED']) {
      for (const action of Object.keys(ALLOWED) as StuckCaseAction[]) {
        expect(stuckCaseRefusal(action, facts('UPHELD', { chainStatus }), READS.GONE)).toBe(
          'NOT_CANCEL_REQUESTED',
        );
      }
    }
  });

  it('a shape the sweep settles is never offered', () => {
    for (const action of Object.keys(ALLOWED) as StuckCaseAction[]) {
      expect(stuckCaseRefusal(action, facts('CANCELLED'), null)).toBe('SWEEP_SETTLES');
    }
  });

  it('records an execution once, and never one beyond the decided penalty', () => {
    expect(
      stuckCaseRefusal(
        'RECORD_EXECUTION',
        facts('OVERTURNED', { executedAt: new Date() }),
        READS.EXECUTED,
      ),
    ).toBe('ALREADY_RECORDED');
    const beyond: StuckCaseRead = {
      state: ChainRecordState.EXECUTED,
      record: record('EXECUTED', { appliedMinor: '1000001' }),
      unreadable: false,
      beneficiaryIsAgent: true,
    };
    expect(stuckCaseRefusal('RECORD_EXECUTION', facts('UPHELD'), beyond)).toBe(
      'EXECUTED_BEYOND_DECISION',
    );
  });

  it('m5: never records an execution whose agent share went to anyone but a harmed agent', () => {
    for (const beneficiaryIsAgent of [false, undefined]) {
      const read: StuckCaseRead = { ...(READS.EXECUTED as StuckCaseRead), beneficiaryIsAgent };
      expect(stuckCaseRefusal('RECORD_EXECUTION', facts('OVERTURNED'), read)).toBe(
        'BENEFICIARY_NOT_AN_AGENT',
      );
    }
  });

  it('B7: never re-proposes a record the provider disputed or a case they won', () => {
    const disputed: StuckCaseRead = {
      state: ChainRecordState.GONE,
      record: record('CANCELLED', { disputedAt: new Date() }),
      unreadable: false,
    };
    const unruled: StuckCaseRead = {
      state: ChainRecordState.GONE,
      record: record('CANCELLED', { cancelReason: 'DISPUTE_UNRESOLVED' }),
      unreadable: false,
    };
    expect(stuckCaseRefusal('REPROPOSE', facts('UPHELD'), disputed)).toBe('DISPUTED_ON_CHAIN');
    expect(stuckCaseRefusal('REPROPOSE', facts('UPHELD'), unruled)).toBe('DISPUTED_ON_CHAIN');
    expect(
      stuckCaseRefusal('REPROPOSE', facts('UPHELD', { chainDisputeWonAt: new Date() }), READS.GONE),
    ).toBe('DISPUTED_ON_CHAIN');
  });

  it('a GONE read without a cancelled record (never written) is not a confirmed cancel', () => {
    const neverWritten: StuckCaseRead = {
      state: ChainRecordState.GONE,
      record: null,
      unreadable: false,
    };
    expect(stuckCaseRefusal('CLOSE_NOTHING_STANDING', facts('CANCELLED'), neverWritten)).toBe(
      'NOT_GONE',
    );
    expect(stuckCaseRefusal('REPROPOSE', facts('UPHELD'), neverWritten)).toBe('NOT_GONE');
  });

  it('stuckCaseOptions answers every action at once', () => {
    expect(stuckCaseOptions(facts('UPHELD'), READS.GONE)).toEqual({
      CLOSE_NOTHING_STANDING: 'UPHELD_USE_REPROPOSE',
      RECORD_EXECUTION: 'NOT_EXECUTED',
      REPROPOSE: null,
    });
  });
});

describe('classifyRecord', () => {
  it('reads the record, and a missing one by whether one was written', () => {
    expect(classifyRecord(record('PENDING'), new Date())).toBe(ChainRecordState.STANDING);
    expect(classifyRecord(record('DISPUTED'), new Date())).toBe(ChainRecordState.STANDING);
    expect(classifyRecord(record('EXECUTED'), new Date())).toBe(ChainRecordState.EXECUTED);
    expect(classifyRecord(record('CANCELLED'), new Date())).toBe(ChainRecordState.GONE);
    expect(classifyRecord(null, new Date())).toBe(ChainRecordState.UNKNOWN);
    expect(classifyRecord(null, null)).toBe(ChainRecordState.GONE);
  });
});
