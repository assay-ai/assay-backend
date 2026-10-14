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
  const events: { kind: string }[] = [];
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
      update: async (_scope: unknown, patch: Record<string, unknown>) =>
        Object.assign(proposal, patch),
    } as never,
    { appendEventDirect: async (entry: { kind: string }) => void events.push(entry) } as never,
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
      await service.recordDisputed(disputed(ID_A));
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

    it('answers false for a record nobody planned', async () => {
      const { service } = build();
      await expect(service.recordExecuted(executed('c'.repeat(64)))).resolves.toBe(false);
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
});
