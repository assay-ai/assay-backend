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
    } as never,
  );
  return { service, parts, proposal, events, filed };
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
  it('AUDIT E-4: marks only the part DISPUTED; the case stays PENDING with a count, and moves into review once', async () => {
    const { service, parts, proposal, events, filed } = build();
    await expect(service.recordDisputed(disputed(ID_A))).resolves.toBe(true);
    await service.recordDisputed(disputed(ID_A)); // the watcher re-read the range

    expect(parts.get(ID_A)).toMatchObject({ chainStatus: 'DISPUTED' });
    expect(parts.get(ID_B)).toMatchObject({ chainStatus: 'PENDING' });
    expect(proposal).toMatchObject({
      // Part B still executes: the case mirror stays in the execute sweep.
      chainStatus: 'PENDING',
      chainDisputedParts: 1,
      chainExecutableAt: new Date('2026-10-17T00:00:05Z'),
      chainDisputedAt: new Date('2026-10-15T00:00:00Z'),
      status: 'DISPUTED',
    });
    expect(events.map((event) => event.kind)).toEqual(['CHAIN_DISPUTED']);
    expect(filed).toEqual(['case']);
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
});
