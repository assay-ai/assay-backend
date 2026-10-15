import { Logger } from '@nestjs/common';

import { SlashChainRulingService } from '@modules/slash/services/slash-chain-ruling.service';

/**
 * `SlashDisputed` / `SlashUpheld` (assay-evm D-19) mirrored onto the case. In
 * memory: the two repositories are maps, the timeline and arbitration are spies.
 */
const ID_A = 'a'.repeat(64);
const ID_B = 'b'.repeat(64);
const CHAIN = 'eip155:46630' as never;

function build(caseStatus = 'PROPOSED', chainStatus = 'PENDING') {
  const parts = new Map<string, Record<string, unknown>>([
    [
      ID_A,
      {
        id: 'p-a',
        organizationId: 'org',
        proposalId: 'case',
        chainEpoch: 0,
        chainRequestId: ID_A,
        chainStatus: 'PENDING',
        chainDisputedAt: null,
        chainExecutableAt: new Date('2026-10-17T00:00:00Z'),
      },
    ],
    [
      ID_B,
      {
        id: 'p-b',
        organizationId: 'org',
        proposalId: 'case',
        chainEpoch: 0,
        chainRequestId: ID_B,
        chainStatus: 'PENDING',
        chainDisputedAt: null,
        chainExecutableAt: new Date('2026-10-17T00:00:05Z'),
      },
    ],
  ]);
  const proposal: Record<string, unknown> = {
    id: 'case',
    organizationId: 'org',
    status: caseStatus,
    chainStatus,
    chainEpoch: 0,
    chainDisputedAt: null,
    chainDisputedParts: 0,
    chainExecutableAt: new Date('2026-10-17T00:00:05Z'),
  };
  const events: { kind: string; detail?: Record<string, unknown> }[] = [];
  const reopened: string[] = [];
  const partlyWon: string[] = [];
  const refolded: string[] = [];
  const alerts: { severity: string; name: string }[] = [];
  const filed: string[] = [];
  const closed: string[] = [];
  const mirrored: string[] = [];
  const reconciled: string[] = [];
  const upheld: string[] = [];
  const released: string[] = [];
  const service = new SlashChainRulingService(
    {
      findOneByChainRequestId: async (id: string) => (parts.has(id) ? { ...parts.get(id) } : null),
      updatePart: async (_org: string, id: string, patch: Record<string, unknown>) => {
        const row = [...parts.values()].find((part) => part.id === id)!;
        Object.assign(row, patch);
      },
      findForEpoch: async () => [...parts.values()].map((part) => ({ ...part })),
    } as never,
    {
      findOneScoped: async () => ({ ...proposal }),
      findOneByChainRequestId: async () => null,
      findOpenOnChainPastDoor: async () =>
        ['DISPUTED', 'UNDER_REVIEW', 'AWAITING_SECOND'].includes(proposal.status as string)
          ? [{ organizationId: 'org', id: 'case' }]
          : [],
      findOpenOnChainCases: async () =>
        ['DISPUTED', 'UNDER_REVIEW', 'AWAITING_SECOND'].includes(proposal.status as string)
          ? [{ organizationId: 'org', id: 'case' }]
          : [],
      update: async (_scope: unknown, patch: Record<string, unknown>) =>
        Object.assign(proposal, patch),
    } as never,
    {
      appendEventDirect: async (entry: { kind: string }) => void events.push(entry),
      hasTimelineEntry: async (_org: string, _id: string, kind: string, requestId: string) =>
        events.some((event) => event.kind === kind && event.detail?.requestId === requestId),
    } as never,
    {
      fileDisputeFromChain: async (_org: string, id: string) => {
        // As the real one: only a PROPOSED case without an objection moves.
        if (proposal.status !== 'PROPOSED') return null;
        filed.push(id);
        proposal.status = 'DISPUTED';
        return proposal;
      },
      recordChainUphold: async (_org: string, id: string) => {
        // As the real one: the arbiter's ruling decides an open case.
        if (!['DISPUTED', 'UNDER_REVIEW', 'AWAITING_SECOND'].includes(proposal.status as string)) {
          return false;
        }
        upheld.push(id);
        proposal.status = 'UPHELD';
        return true;
      },
      recordPartialChainWin: async (_org: string, id: string) => void partlyWon.push(id),
      reopenForChainDispute: async (_org: string, id: string) => {
        // As the real one: only a case the platform labelled undisputed.
        if (proposal.status !== 'UPHELD' || proposal.resolutionKind !== 'AUTO_UNDISPUTED') {
          return false;
        }
        reopened.push(id);
        proposal.status = 'DISPUTED';
        proposal.resolutionKind = null;
        return true;
      },
      recordChainStanding: async (_org: string, id: string) => {
        if (!['DISPUTED', 'UNDER_REVIEW', 'AWAITING_SECOND'].includes(proposal.status as string)) {
          return false;
        }
        released.push(id);
        proposal.status = 'UPHELD';
        return true;
      },
    } as never,
    {
      mirrorChainExecution: async (_case: unknown, hash: string | null) =>
        void mirrored.push(hash ?? 'none'),
      refoldLatePart: async (_case: unknown, hash: string | null) =>
        void refolded.push(hash ?? 'none'),
      reconcileRecord: async (entry: { id: string }) => {
        reconciled.push(entry.id);
        // As the real one: the landed record is mirrored onto its part.
        for (const part of parts.values()) {
          if (part.chainStatus === 'REFUSED' && !String(part.chainLastError).startsWith('Record')) {
            Object.assign(part, {
              chainStatus: 'PENDING',
              chainExecutableAt: new Date('2026-10-17T00:10:00Z'),
            });
          }
        }
      },
      closeCancelledOnChain: async (_case: unknown, because: string) => {
        closed.push(because);
        proposal.chainStatus = 'CANCELLED';
        proposal.status = 'CANCELLED';
      },
    } as never,
    { emit: async (alert: { severity: string; name: string }) => void alerts.push(alert) } as never,
  );
  return {
    service,
    parts,
    proposal,
    events,
    filed,
    closed,
    mirrored,
    reconciled,
    upheld,
    released,
    reopened,
    partlyWon,
    refolded,
    alerts,
  };
}

const disputed = (requestId: string, at = '2026-10-15T00:00:00Z') => ({
  chainId: CHAIN,
  requestId,
  provider: '0x1',
  disputedAt: new Date(at),
  executableAt: new Date('2026-10-17T00:00:00Z'),
  transactionHash: '0xabc',
});

describe('SlashChainRulingService', () => {
  // Past every door below (plus the settle margin) unless a test moves it.
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-10-17T01:00:00Z'), doNotFake: ['nextTick'] });
  });
  afterEach(() => jest.useRealTimers());

  it('AUDIT E-4 / N-1: marks only the part DISPUTED; the case stays PROPOSED while another part is undisputed', async () => {
    const { service, parts, proposal, events, filed } = build();
    await expect(service.recordDisputed(disputed(ID_A))).resolves.toBe(true);
    await service.recordDisputed(disputed(ID_A)); // the watcher re-read the range

    expect(parts.get(ID_A)).toMatchObject({ chainStatus: 'DISPUTED' });
    expect(parts.get(ID_B)).toMatchObject({ chainStatus: 'PENDING' });
    expect(proposal).toMatchObject({
      // Part B still executes: the case mirror stays in the execute sweep, and
      // the case stays PROPOSED so the undisputed sweep upholds it at the door.
      chainStatus: 'PENDING',
      chainDisputedParts: 1,
      chainExecutableAt: new Date('2026-10-17T00:00:05Z'),
      chainDisputedAt: new Date('2026-10-15T00:00:00Z'),
      status: 'PROPOSED',
    });
    expect(events.map((event) => event.kind)).toEqual(['CHAIN_DISPUTED']);
    expect(filed).toEqual([]);

    // Every live part disputed: now the case waits for the arbiter, once.
    await service.recordDisputed(disputed(ID_B));
    await service.recordDisputed(disputed(ID_B));
    expect(proposal).toMatchObject({ status: 'DISPUTED', chainStatus: 'DISPUTED' });
    expect(filed).toEqual(['case']);
  });

  it('N-1: a cancel of the only disputed part leaves the undisputed part to execute', async () => {
    const { service, proposal, closed, filed } = build();
    await service.recordDisputed(disputed(ID_A));
    await service.recordCancelled({
      chainId: CHAIN,
      requestId: ID_A,
      reason: 'WITHDRAWN',
      cancelledAt: new Date('2026-10-16T00:00:00Z'),
      transactionHash: '0xdef',
    });
    // Part B stands undisputed: the case is still PROPOSED, in the undisputed
    // sweep's hands at the door, and nothing was closed.
    expect(proposal).toMatchObject({ status: 'PROPOSED', chainStatus: 'PENDING' });
    expect(filed).toEqual([]);
    expect(closed).toEqual([]);
  });

  it('N-1: an open case with a record standing undisputed is upheld for the executor', async () => {
    const { service, proposal, released } = build('DISPUTED');
    await service.recordCancelled({
      chainId: CHAIN,
      requestId: ID_A,
      reason: 'WITHDRAWN',
      cancelledAt: new Date('2026-10-16T00:00:00Z'),
      transactionHash: '0xdef',
    });
    expect(released).toEqual(['case']);
    expect(proposal.status).toBe('UPHELD');
  });

  it('N-1: a case with an executed part closes EXECUTED once its disputed part is cancelled', async () => {
    const { service, parts, proposal, closed, mirrored } = build();
    await service.recordDisputed(disputed(ID_A));
    Object.assign(parts.get(ID_B)!, { chainStatus: 'EXECUTED' });
    await service.recordCancelled({
      chainId: CHAIN,
      requestId: ID_A,
      reason: 'WITHDRAWN',
      cancelledAt: new Date('2026-10-16T00:00:00Z'),
      transactionHash: '0xdef',
    });
    expect(mirrored).toEqual(['0xdef']);
    expect(closed).toEqual([]);
    expect(proposal.status).not.toBe('CANCELLED');
  });

  it('R2-3: a case executed in part and won in part closes its dispute accordingly', async () => {
    const { service, parts, proposal, mirrored, partlyWon } = build('UPHELD');
    await service.recordDisputed(disputed(ID_A));
    Object.assign(parts.get(ID_B)!, { chainStatus: 'EXECUTED' });
    await service.recordCancelled({
      chainId: CHAIN,
      requestId: ID_A,
      reason: 'WITHDRAWN',
      cancelledAt: new Date('2026-10-16T00:00:00Z'),
      transactionHash: '0xdef',
    });
    expect(proposal.chainDisputeWonAt).toEqual(new Date('2026-10-16T00:00:00Z'));
    expect(mirrored).toEqual(['0xdef']);
    expect(partlyWon).toEqual(['case']);
  });

  it('N-1: a re-read of a cancel already mirrored still settles the case', async () => {
    const { service, parts, closed } = build('DISPUTED', 'DISPUTED');
    for (const part of parts.values()) Object.assign(part, { chainStatus: 'CANCELLED' });
    await service.recordCancelled({
      chainId: CHAIN,
      requestId: ID_A,
      reason: 'DISPUTE_UNRESOLVED' as never,
      cancelledAt: new Date('2026-10-16T00:00:00Z'),
      transactionHash: '0xdef',
    });
    expect(closed).toHaveLength(1);
  });

  it('marks the case DISPUTED only when every live part is disputed', async () => {
    const { service, proposal } = build('UPHELD');
    await service.recordDisputed(disputed(ID_A));
    expect(proposal).toMatchObject({ chainStatus: 'PENDING', chainDisputedParts: 1 });
    await service.recordDisputed(disputed(ID_B));
    expect(proposal).toMatchObject({ chainStatus: 'DISPUTED', chainDisputedParts: 2 });
  });

  it('keeps a decided case decided, and a requested cancel requested', async () => {
    const { service, proposal } = build('OVERTURNED', 'CANCEL_REQUESTED');
    await service.recordDisputed(disputed(ID_A));
    expect(proposal).toMatchObject({
      status: 'OVERTURNED',
      chainStatus: 'CANCEL_REQUESTED',
      chainDisputedAt: new Date('2026-10-15T00:00:00Z'),
    });
  });

  it('answers false for a record nobody planned', async () => {
    const { service } = build();
    await expect(service.recordDisputed(disputed('c'.repeat(64)))).resolves.toBe(false);
  });

  it('returns the case to PENDING at the executableAt the event carries, as soon as a part is pending', async () => {
    const { service, parts, proposal, events } = build('UPHELD');
    await service.recordDisputed(disputed(ID_A));
    await service.recordDisputed(disputed(ID_B));

    // Not "now": the arbiter's uphold never moves executableAt earlier.
    const later = new Date('2026-10-17T00:00:00Z');
    await service.recordUpheld({
      chainId: CHAIN,
      requestId: ID_A,
      arbiter: '0x5',
      executableAt: later,
      transactionHash: null,
    });
    expect(parts.get(ID_A)).toMatchObject({ chainStatus: 'PENDING', chainExecutableAt: later });
    // Part A is pending again, so the case is back in the execute sweep.
    expect(proposal).toMatchObject({ chainStatus: 'PENDING', chainDisputedParts: 1 });

    await service.recordUpheld({
      chainId: CHAIN,
      requestId: ID_B,
      arbiter: '0x5',
      executableAt: new Date('2026-10-17T00:00:05Z'),
      transactionHash: null,
    });
    expect(proposal).toMatchObject({
      chainStatus: 'PENDING',
      chainDisputedParts: 0,
      chainExecutableAt: new Date('2026-10-17T00:00:05Z'),
      status: 'UPHELD',
    });
    expect(events.filter((event) => event.kind === 'CHAIN_UPHELD')).toHaveLength(2);
  });

  it("decides a DISPUTED case UPHELD on the arbiter's on-chain uphold, so the executor sends it", async () => {
    const { service, proposal, upheld } = build('PROPOSED');
    await service.recordDisputed(disputed(ID_A));
    await service.recordDisputed(disputed(ID_B));
    expect(proposal.status).toBe('DISPUTED');

    await service.recordUpheld({
      chainId: CHAIN,
      requestId: ID_A,
      arbiter: '0x5',
      executableAt: new Date('2026-10-17T00:00:00Z'),
      transactionHash: '0xabc',
    });

    expect(upheld).toEqual(['case']);
    expect(proposal.status).toBe('UPHELD');
  });

  describe('SlashCancelled (audit E-6)', () => {
    const cancelled = (requestId: string, reason = 'WITHDRAWN' as const) => ({
      chainId: CHAIN,
      requestId,
      reason,
      cancelledAt: new Date('2026-10-16T00:00:00Z'),
      transactionHash: '0xdef',
    });

    it('closes the case at once when the arbiter cancels its last standing parts', async () => {
      const { service, parts, proposal, events, closed } = build('UPHELD');
      await service.recordDisputed(disputed(ID_A));
      await service.recordDisputed(disputed(ID_B));
      expect(proposal.chainStatus).toBe('DISPUTED');

      await expect(service.recordCancelled(cancelled(ID_A))).resolves.toBe(true);
      expect(parts.get(ID_A)).toMatchObject({ chainStatus: 'CANCELLED' });
      expect(closed).toEqual([]);
      expect(proposal).toMatchObject({ chainStatus: 'DISPUTED', chainDisputedParts: 1 });

      await service.recordCancelled(cancelled(ID_B));
      expect(closed).toEqual(['the arbiter ruled for the provider on chain (cancelSlash)']);
      expect(proposal).toMatchObject({ chainStatus: 'CANCELLED', chainDisputedParts: 0 });
      expect(events.filter((event) => event.kind === 'CHAIN_CANCELLED')).toHaveLength(2);

      // The watcher re-reads a range: nothing twice.
      await service.recordCancelled(cancelled(ID_B));
      expect(closed).toHaveLength(1);
      expect(events.filter((event) => event.kind === 'CHAIN_CANCELLED')).toHaveLength(2);
    });

    it('B7: remembers that the provider won the dispute when a DISPUTED part is cancelled', async () => {
      const { service, proposal } = build('UPHELD');
      await service.recordDisputed(disputed(ID_A));
      await service.recordCancelled(cancelled(ID_A));
      expect(proposal.chainDisputeWonAt).toEqual(new Date('2026-10-16T00:00:00Z'));
    });

    it('S-2: the cancel of a downward recalculation leaves the case open, and is no dispute won', async () => {
      const { service, parts, proposal, closed, events } = build('UPHELD', 'CANCEL_REQUESTED');
      await service.recordCancelled(cancelled(ID_A));
      await service.recordCancelled(cancelled(ID_B));

      expect(parts.get(ID_A)).toMatchObject({ chainStatus: 'CANCELLED' });
      expect(parts.get(ID_B)).toMatchObject({ chainStatus: 'CANCELLED' });
      expect(closed).toEqual([]);
      expect(proposal).toMatchObject({
        status: 'UPHELD',
        chainStatus: 'CANCEL_REQUESTED',
        chainDisputedParts: 0,
      });
      expect(proposal.chainDisputeWonAt ?? null).toBeNull();
      expect(events.filter((event) => event.kind === 'CHAIN_CANCELLED')).toHaveLength(2);
    });

    it('S-2: a dispute that ran out unruled is still the provider’s win', async () => {
      const { service, proposal, closed } = build('UPHELD', 'CANCEL_REQUESTED');
      await service.recordDisputed(disputed(ID_A));
      await service.recordCancelled(cancelled(ID_A, 'DISPUTE_UNRESOLVED' as never));
      await service.recordCancelled(cancelled(ID_B, 'DISPUTE_UNRESOLVED' as never));
      expect(proposal.chainDisputeWonAt).toEqual(new Date('2026-10-16T00:00:00Z'));
      expect(closed).toHaveLength(1);
    });

    it("N-9: an arbiter's cancel of a DISPUTED part during a recalculation is the provider's win", async () => {
      const { service, proposal, closed } = build('UPHELD', 'CANCEL_REQUESTED');
      await service.recordDisputed(disputed(ID_A));
      await service.recordDisputed(disputed(ID_B));
      await service.recordCancelled(cancelled(ID_A));
      await service.recordCancelled(cancelled(ID_B));
      expect(proposal.chainDisputeWonAt).toEqual(new Date('2026-10-16T00:00:00Z'));
      expect(closed).toEqual(['the arbiter ruled for the provider on chain (cancelSlash)']);
    });

    it('B7: a cancel of a part nobody disputed is not a dispute won', async () => {
      const { service, proposal } = build('UPHELD');
      await service.recordCancelled(cancelled(ID_A));
      expect(proposal.chainDisputeWonAt ?? null).toBeNull();
    });

    it('leaves the case executing when another part still stands', async () => {
      const { service, parts, proposal, closed } = build('UPHELD');
      await service.recordDisputed(disputed(ID_A));
      await service.recordCancelled(cancelled(ID_A));
      expect(parts.get(ID_A)).toMatchObject({ chainStatus: 'CANCELLED' });
      expect(parts.get(ID_B)).toMatchObject({ chainStatus: 'PENDING' });
      expect(proposal).toMatchObject({ chainStatus: 'PENDING', chainDisputedParts: 0 });
      expect(closed).toEqual([]);
    });

    it('answers false for a record nobody planned', async () => {
      const { service } = build();
      await expect(service.recordCancelled(cancelled('c'.repeat(64)))).resolves.toBe(false);
    });
  });

  describe('SlashExecuted, whoever sent it (BUG-R13-D-03)', () => {
    const executed = (requestId: string) => ({
      chainId: CHAIN,
      requestId,
      appliedMinor: '500',
      agentAmountMinor: '300',
      platformAmountMinor: '150',
      executedAt: new Date('2026-10-18T00:00:00Z'),
      transactionHash: '0xfeed',
    });

    it('mirrors the part EXECUTED with the event’s amounts and hands the case to the executor’s completion', async () => {
      const { service, parts, mirrored } = build('UPHELD');
      // Once nothing else stands, the case completes on what executed.
      Object.assign(parts.get(ID_B)!, { chainStatus: 'EXECUTED' });
      await expect(service.recordExecuted(executed(ID_A))).resolves.toBe(true);
      expect(parts.get(ID_A)).toMatchObject({
        chainStatus: 'EXECUTED',
        appliedAmount: '500',
        agentAmount: '300',
        platformAmount: '150',
        executionSignature: '0xfeed',
      });
      expect(mirrored).toEqual(['0xfeed']);
    });

    it('does not rewrite a part the executor already mirrored', async () => {
      const { service, parts } = build('EXECUTED');
      Object.assign(parts.get(ID_A)!, {
        chainStatus: 'EXECUTED',
        appliedAmount: '400',
        executionSignature: '0xown',
      });
      await service.recordExecuted(executed(ID_A));
      expect(parts.get(ID_A)).toMatchObject({ appliedAmount: '400', executionSignature: '0xown' });
    });

    it('R2-4: a late part paid by somebody else re-sums an already executed case', async () => {
      const { service, parts, refolded } = build('EXECUTED');
      Object.assign(parts.get(ID_B)!, { chainStatus: 'EXECUTED', appliedAmount: '400' });
      await service.recordExecuted(executed(ID_A));
      expect(parts.get(ID_A)).toMatchObject({ chainStatus: 'EXECUTED', appliedAmount: '500' });
      expect(refolded).toEqual(['0xfeed']);
    });

    it('answers false for a record nobody planned', async () => {
      const { service } = build();
      await expect(service.recordExecuted(executed('c'.repeat(64)))).resolves.toBe(false);
    });
  });

  describe('open EVM cases from the in-app objection era (review N-3)', () => {
    it('re-reads the records and upholds a case whose record stands undisputed', async () => {
      const { service, proposal, reconciled, released } = build('UNDER_REVIEW');
      await expect(service.reconcileOpenCases(100)).resolves.toMatchObject({ moved: 1, failed: [] });
      expect(reconciled).toEqual(['case']);
      expect(released).toEqual(['case']);
      expect(proposal.status).toBe('UPHELD');
      // Nothing left to move.
      await expect(service.reconcileOpenCases(100)).resolves.toMatchObject({ moved: 0 });
    });

    it('leaves a case whose every record is disputed on chain to the arbiter', async () => {
      const { service, parts, proposal, released, closed } = build('AWAITING_SECOND');
      for (const part of parts.values()) Object.assign(part, { chainStatus: 'DISPUTED' });
      await expect(service.reconcileOpenCases(100)).resolves.toMatchObject({ moved: 0 });
      expect(proposal.status).toBe('AWAITING_SECOND');
      expect(released).toEqual([]);
      expect(closed).toEqual([]);
    });

    it('R2-5: pages past one page, and hands back the cases whose read failed', async () => {
      const { service, proposal } = build('UNDER_REVIEW');
      const pageOf = (id: string, at: string) => ({
        organizationId: 'org',
        id,
        proposedAt: new Date(at),
      });
      const asked: unknown[] = [];
      Object.assign((service as unknown as { proposals: Record<string, unknown> }).proposals, {
        findOpenOnChainCases: async (limit: number, after: unknown) => {
          asked.push(after ?? null);
          return after ? [] : [pageOf('case', '2026-10-01T00:00:00Z')].slice(0, limit);
        },
      });
      Object.assign((service as unknown as { execution: Record<string, unknown> }).execution, {
        reconcileRecord: async () => {
          throw new Error('rpc down');
        },
      });
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      const first = await service.reconcileOpenCases(1);
      expect(first.failed).toEqual([{ organizationId: 'org', id: 'case' }]);
      expect(first.next).toEqual({ proposedAt: new Date('2026-10-01T00:00:00Z'), id: 'case' });
      expect(proposal.status).toBe('UNDER_REVIEW');

      const second = await service.reconcileOpenCases(1, first.next);
      expect(second.next).toBeNull();
      expect(asked).toEqual([null, first.next]);
      await expect(service.reconcileCases(first.failed)).resolves.toMatchObject({
        failed: [{ organizationId: 'org', id: 'case' }],
      });
    });

    it('closes a case whose records were all cancelled on chain', async () => {
      const { service, parts, proposal, closed } = build('DISPUTED');
      for (const part of parts.values()) Object.assign(part, { chainStatus: 'CANCELLED' });
      await expect(service.reconcileOpenCases(100)).resolves.toMatchObject({ moved: 1 });
      expect(closed).toHaveLength(1);
      expect(proposal.status).toBe('CANCELLED');
    });
  });

  describe('a straggler that landed after it was given up on (review S-5)', () => {
    const late = (requestId: string) => ({
      chainId: CHAIN,
      requestId,
      executableAt: new Date('2026-10-17T00:10:00Z'),
      transactionHash: '0xlate',
    });

    it('re-adopts the part, and the case waits for its door', async () => {
      const { service, parts, proposal, events, reconciled } = build('UPHELD');
      Object.assign(parts.get(ID_B)!, {
        chainStatus: 'REFUSED',
        chainLastError: 'Straggler:transport',
      });
      await expect(service.recordLateProposal(late(ID_B))).resolves.toBe(true);

      expect(reconciled).toEqual(['case']);
      expect(parts.get(ID_B)).toMatchObject({ chainStatus: 'PENDING' });
      expect(proposal).toMatchObject({
        chainStatus: 'PENDING',
        chainExecutableAt: new Date('2026-10-17T00:10:00Z'),
      });
      expect(events.map((event) => event.kind)).toEqual(['CHAIN_PART_READOPTED']);
    });

    it('N-9: refuses a straggler of an earlier epoch and names it for the arbiter’s cancel', async () => {
      const { service, parts, proposal, events, reconciled } = build('UPHELD');
      proposal.chainEpoch = 1;
      Object.assign(parts.get(ID_B)!, { chainStatus: 'REFUSED', chainLastError: 'Straggler:x' });
      await expect(service.recordLateProposal(late(ID_B))).resolves.toBe(true);

      expect(reconciled).toEqual([]);
      expect(parts.get(ID_B)).toMatchObject({
        chainStatus: 'PENDING',
        chainLastError: 'SupersededEpoch',
      });
      expect(events.map((event) => event.kind)).toEqual(['CHAIN_SUPERSEDED_RECORD']);
    });

    it('R2-6: pages a human about a superseded record, and never executes it', async () => {
      const { service, parts, proposal, alerts, mirrored } = build('UPHELD');
      proposal.chainEpoch = 1;
      Object.assign(parts.get(ID_B)!, { chainStatus: 'REFUSED', chainLastError: 'Straggler:x' });
      await service.recordLateProposal(late(ID_B));
      expect(alerts).toEqual([
        expect.objectContaining({ severity: 'CRITICAL', name: 'slash_record_superseded' }),
      ]);
      expect(mirrored).toEqual([]);
    });

    it('leaves a standing part and a mismatched record alone', async () => {
      const { service, parts, reconciled } = build('UPHELD');
      await expect(service.recordLateProposal(late(ID_A))).resolves.toBe(true);
      Object.assign(parts.get(ID_B)!, {
        chainStatus: 'REFUSED',
        chainLastError: 'RecordMismatch:penalty',
      });
      await expect(service.recordLateProposal(late(ID_B))).resolves.toBe(true);
      expect(reconciled).toEqual([]);
    });

    it('answers false for a record nobody planned', async () => {
      const { service } = build();
      await expect(service.recordLateProposal(late('c'.repeat(64)))).resolves.toBe(false);
    });
  });
  describe('labels follow the chain (review R2-2, R2-10)', () => {
    it('R2-2: a dispute mirrored after the platform upheld the case reopens it, with its timeline entry', async () => {
      const { service, parts, proposal, events, reopened } = build('UPHELD');
      proposal.resolutionKind = 'AUTO_UNDISPUTED';
      // The executor's SlashNotPending read mirrored both records DISPUTED
      // (with disputedAt) before the watcher saw the events.
      for (const part of parts.values()) {
        Object.assign(part, {
          chainStatus: 'DISPUTED',
          chainDisputedAt: new Date('2026-10-15T00:00:00Z'),
        });
      }
      await service.recordDisputed(disputed(ID_A));
      await service.recordDisputed(disputed(ID_B));

      expect(reopened).toEqual(['case']);
      expect(proposal.status).toBe('DISPUTED');
      expect(events.filter((event) => event.kind === 'CHAIN_DISPUTED')).toHaveLength(2);
      // A re-read writes nothing twice.
      await service.recordDisputed(disputed(ID_A));
      expect(events.filter((event) => event.kind === 'CHAIN_DISPUTED')).toHaveLength(2);
    });

    it('R2-2: an open case is not upheld before every undisputed record has passed its door', async () => {
      jest.setSystemTime(new Date('2026-10-16T23:00:00Z'));
      const { service, proposal, released } = build('DISPUTED');
      await service.followRecords(proposal as never, { transactionHash: null });
      expect(released).toEqual([]);
      expect(proposal.status).toBe('DISPUTED');

      // Door passed, but a dispute sent just before it may not be confirmed yet.
      jest.setSystemTime(new Date('2026-10-17T00:01:00Z'));
      await service.followRecords(proposal as never, { transactionHash: null });
      expect(released).toEqual([]);

      jest.setSystemTime(new Date('2026-10-17T00:30:00Z'));
      await service.followRecords(proposal as never, { transactionHash: null });
      expect(released).toEqual(['case']);
    });

    it('R2-10: a record standing again after a dispute is the arbiter’s uphold, never AUTO_UNDISPUTED', async () => {
      const { service, parts, proposal, upheld, released } = build('DISPUTED');
      Object.assign(parts.get(ID_A)!, { chainDisputedAt: new Date('2026-10-15T00:00:00Z') });
      Object.assign(parts.get(ID_B)!, { chainStatus: 'CANCELLED' });
      await service.followRecords(proposal as never, { transactionHash: '0xabc' });
      expect(upheld).toEqual(['case']);
      expect(released).toEqual([]);
    });

    it('R2-2: lists open cases past their door on every tick, so a deferred one still moves', async () => {
      const { service, proposal, released } = build('UNDER_REVIEW');
      await expect(service.followOpenCasesPastDoor(new Date(), 50)).resolves.toBe(1);
      expect(released).toEqual(['case']);
      expect(proposal.status).toBe('UPHELD');
    });
  });
});
