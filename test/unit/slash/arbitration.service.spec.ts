import { DisputeEntity } from '@database/postgres/entities/dispute.entity';
import {
  ARBITRATION_STATE_MAP,
  ArbitrationOutcome,
  ResolutionKind,
} from '@modules/slash/domain/arbitration';
import { SlashProposalStatus } from '@modules/slash/domain/slash-proposal-state';
import { ArbitrationService } from '@modules/slash/services/arbitration.service';
import { SlashProposalService } from '@modules/slash/services/slash-proposal.service';

import {
  FakeNotifications,
  FakeSlashEvents,
  FakeSlashProposals,
  TEST_SLASH_CONFIG,
} from './helpers/fake-slash-repositories';

/**
 * The case's side of the on-chain dispute: what the watcher's mirror of
 * `disputeSlash`, `upholdSlash` and a record standing undisputed does to the
 * case and to its dispute row. There is no off-chain decision to test.
 */
function build() {
  const proposals = new FakeSlashProposals();
  const events = new FakeSlashEvents();
  const notifications = new FakeNotifications();
  const disputes = new Map<string, DisputeEntity>();
  /** Every patch written to a dispute row, for review R3-6's pair check. */
  const disputeWrites: Record<string, unknown>[] = [];

  const disputeRepo = {
    save: async (row: DisputeEntity) => {
      row.id = row.id ?? `d_${disputes.size + 1}`;
      disputes.set(row.id, row);
      return row;
    },
    update: async (criteria: { id: string }, patch: Record<string, unknown>) => {
      const row = disputes.get(criteria.id);
      disputeWrites.push(patch);
      if (row) Object.assign(row, patch);
      return { affected: row ? 1 : 0 };
    },
    findOneBy: async (where: { id: string }) => disputes.get(where.id) ?? null,
  };

  const lifecycle = new SlashProposalService(
    proposals as never,
    events as never,
    notifications as never,
    TEST_SLASH_CONFIG,
  );
  const service = new ArbitrationService(proposals as never, disputeRepo as never, lifecycle);

  return { proposals, events, disputes, disputeWrites, service };
}

function seedDisputed(ctx: ReturnType<typeof build>) {
  const dispute = Object.assign(new DisputeEntity(), {
    id: 'd_1',
    organizationId: 'org_1',
    subjectType: 'SLASH_PROPOSAL',
    subjectId: 'p1',
    state: 'OPEN',
  });
  ctx.disputes.set('d_1', dispute);
  ctx.proposals.seed({
    id: 'p1',
    organizationId: 'org_1',
    status: SlashProposalStatus.DISPUTED,
    disputeId: 'd_1',
    penaltyAmount: '1000000',
  });
  return dispute;
}

describe('ArbitrationService', () => {
  describe('an EVM case: the dispute and the ruling are on chain only', () => {
    const EVM_ASSET = 'eip155:46630/erc20:0xdbbc156dd414f43f2c952c1be0f16a0b9a826cd3';
    const DOOR = new Date('2026-10-18T12:00:00Z');

    function seedEvm(ctx: ReturnType<typeof build>, status: SlashProposalStatus) {
      const dispute = seedDisputed(ctx);
      Object.assign(ctx.proposals.rows.get('p1')!, {
        status,
        assetId: EVM_ASSET,
        chainStatus: 'PENDING',
        chainExecutableAt: DOOR,
        disputeId: status === SlashProposalStatus.PROPOSED ? null : 'd_1',
      });
      return dispute;
    }

    it('moves an on-chain dispute to DISPUTED with no platform deadline', async () => {
      const ctx = build();
      seedEvm(ctx, SlashProposalStatus.PROPOSED);
      ctx.disputes.clear();

      const moved = await ctx.service.fileDisputeFromChain('org_1', 'p1', {
        requestId: 'ab'.repeat(32),
        transactionHash: '0xabc',
      });

      expect(moved?.status).toBe(SlashProposalStatus.DISPUTED);
      expect([...ctx.disputes.values()][0]).toMatchObject({
        platformDueAt: null,
        deadlineAt: null,
        openedBy: 'chain:disputeSlash',
      });
    });

    it("decides the case UPHELD on the arbiter's on-chain uphold and closes its dispute", async () => {
      const ctx = build();
      const dispute = seedEvm(ctx, SlashProposalStatus.DISPUTED);

      expect(
        await ctx.service.recordChainUphold('org_1', 'p1', {
          arbiter: '0xAbC',
          transactionHash: '0xdef',
        }),
      ).toBe(true);

      const row = ctx.proposals.rows.get('p1')!;
      expect(row).toMatchObject({
        status: SlashProposalStatus.UPHELD,
        resolutionKind: ResolutionKind.CHAIN_ARBITER,
        outcome: null,
      });
      expect(dispute).toMatchObject({
        state: 'REJECTED',
        resolutionKind: ResolutionKind.CHAIN_ARBITER,
        resolvedBy: 'chain:upholdSlash:0xabc',
      });
      // Idempotent: a re-read of the same event moves nothing.
      expect(
        await ctx.service.recordChainUphold('org_1', 'p1', {
          arbiter: '0xabc',
          transactionHash: null,
        }),
      ).toBe(false);
    });

    it('N-3: upholds a disputed case whose record stands undisputed on chain, and closes the dispute', async () => {
      const ctx = build();
      const dispute = seedEvm(ctx, SlashProposalStatus.DISPUTED);

      expect(await ctx.service.recordChainStanding('org_1', 'p1')).toBe(true);
      expect(ctx.proposals.rows.get('p1')!).toMatchObject({
        status: SlashProposalStatus.UPHELD,
        resolutionKind: ResolutionKind.AUTO_UNDISPUTED,
        outcome: null,
      });
      expect(dispute).toMatchObject({ state: 'REJECTED', resolvedBy: 'chain:undisputed' });
      expect(await ctx.service.recordChainStanding('org_1', 'p1')).toBe(false);
    });

    it('R4-1: keeps the dispute row open while another record still stands disputed', async () => {
      const ctx = build();
      const dispute = seedEvm(ctx, SlashProposalStatus.DISPUTED);

      expect(await ctx.service.recordChainStanding('org_1', 'p1', { disputeStillOpen: true })).toBe(
        true,
      );
      expect(ctx.proposals.rows.get('p1')!.status).toBe(SlashProposalStatus.UPHELD);
      expect(dispute.resolvedAt ?? null).toBeNull();
      expect(dispute.resolvedBy ?? null).toBeNull();
      expect(dispute.state).not.toBe('REJECTED');
    });

    it('R2-2 / R2-10: relabels an AUTO_UNDISPUTED case CHAIN_ARBITER on the arbiter uphold', async () => {
      const ctx = build();
      seedEvm(ctx, SlashProposalStatus.PROPOSED);
      Object.assign(ctx.proposals.rows.get('p1')!, {
        status: SlashProposalStatus.UPHELD,
        resolutionKind: ResolutionKind.AUTO_UNDISPUTED,
        resolvedAt: new Date('2026-10-18T12:10:00Z'),
      });

      expect(
        await ctx.service.recordChainUphold('org_1', 'p1', {
          arbiter: '0xAbC',
          transactionHash: '0xdef',
        }),
      ).toBe(true);
      expect(ctx.proposals.rows.get('p1')!).toMatchObject({
        status: SlashProposalStatus.UPHELD,
        resolutionKind: ResolutionKind.CHAIN_ARBITER,
      });
      // Idempotent.
      expect(
        await ctx.service.recordChainUphold('org_1', 'p1', {
          arbiter: null,
          transactionHash: null,
        }),
      ).toBe(false);
    });

    it('R2-2: reopens an AUTO_UNDISPUTED case as DISPUTED when a dispute is mirrored after it', async () => {
      const ctx = build();
      seedEvm(ctx, SlashProposalStatus.PROPOSED);
      Object.assign(ctx.proposals.rows.get('p1')!, {
        status: SlashProposalStatus.UPHELD,
        resolutionKind: ResolutionKind.AUTO_UNDISPUTED,
        resolvedAt: new Date('2026-10-18T12:10:00Z'),
        chainStatus: 'DISPUTED',
      });

      const reopened = await ctx.service.reopenForChainDispute('org_1', 'p1', {
        requestId: 'a'.repeat(64),
        transactionHash: '0xabc',
      });

      expect(reopened).toBe(true);
      const row = ctx.proposals.rows.get('p1')!;
      expect(row).toMatchObject({
        status: SlashProposalStatus.DISPUTED,
        resolutionKind: null,
        resolvedAt: null,
      });
      expect(row.disputeId).not.toBeNull();
      expect(ctx.disputes.get(row.disputeId!)).toMatchObject({
        state: 'OPEN',
        openedBy: 'chain:disputeSlash',
      });
      expect(ctx.events.kinds()).toContain('DISPUTE_FILED');
      // Once only.
      expect(
        await ctx.service.reopenForChainDispute('org_1', 'p1', {
          requestId: 'a'.repeat(64),
          transactionHash: null,
        }),
      ).toBe(false);
    });

    it('R3-5: the reopen is a compare-and-set on AUTO_UNDISPUTED, not only a read of it', async () => {
      for (const disputeId of [null, 'd_1']) {
        const ctx = build();
        seedEvm(ctx, SlashProposalStatus.PROPOSED);
        const row = ctx.proposals.rows.get('p1')!;
        Object.assign(row, {
          status: SlashProposalStatus.UPHELD,
          resolutionKind: ResolutionKind.AUTO_UNDISPUTED,
          resolvedAt: new Date('2026-10-18T12:10:00Z'),
          disputeId,
        });
        // The read sees AUTO_UNDISPUTED; a concurrent arbiter relabel lands
        // before the write.
        const stale = { ...row };
        row.resolutionKind = ResolutionKind.CHAIN_ARBITER;
        jest.spyOn(ctx.proposals, 'findOneScoped').mockResolvedValueOnce(stale as never);

        await ctx.service
          .reopenForChainDispute('org_1', 'p1', {
            requestId: 'a'.repeat(64),
            transactionHash: null,
          })
          .catch(() => false);
        expect(row).toMatchObject({
          status: SlashProposalStatus.UPHELD,
          resolutionKind: ResolutionKind.CHAIN_ARBITER,
        });
      }
    });

    it('R3-5: a dispute mirrored while the executor holds the case (EXECUTING) still reopens it', async () => {
      const ctx = build();
      seedEvm(ctx, SlashProposalStatus.PROPOSED);
      Object.assign(ctx.proposals.rows.get('p1')!, {
        status: SlashProposalStatus.EXECUTING,
        resolutionKind: ResolutionKind.AUTO_UNDISPUTED,
        resolvedAt: new Date('2026-10-18T12:10:00Z'),
        chainClaimedAt: new Date('2026-10-18T12:11:00Z'),
        chainStatus: 'DISPUTED',
      });

      expect(
        await ctx.service.reopenForChainDispute('org_1', 'p1', {
          requestId: 'a'.repeat(64),
          transactionHash: null,
        }),
      ).toBe(true);
      expect(ctx.proposals.rows.get('p1')!).toMatchObject({
        status: SlashProposalStatus.DISPUTED,
        resolutionKind: null,
        chainClaimedAt: null,
      });
    });

    it('R2-2: never reopens an arbiter-upheld or executed case', async () => {
      for (const patch of [
        { resolutionKind: ResolutionKind.CHAIN_ARBITER },
        {
          resolutionKind: ResolutionKind.AUTO_UNDISPUTED,
          executedAt: new Date('2026-10-18T12:20:00Z'),
        },
      ]) {
        const ctx = build();
        seedEvm(ctx, SlashProposalStatus.PROPOSED);
        Object.assign(ctx.proposals.rows.get('p1')!, {
          status: SlashProposalStatus.UPHELD,
          resolvedAt: new Date('2026-10-18T12:10:00Z'),
          ...patch,
        });
        expect(
          await ctx.service.reopenForChainDispute('org_1', 'p1', {
            requestId: 'a'.repeat(64),
            transactionHash: null,
          }),
        ).toBe(false);
        expect(ctx.proposals.rows.get('p1')!.status).toBe(SlashProposalStatus.UPHELD);
      }
    });

    it('R2-3: closes the dispute PARTIALLY_UPHELD when a record executed and another was won', async () => {
      const ctx = build();
      const dispute = seedEvm(ctx, SlashProposalStatus.DISPUTED);
      await ctx.service.recordChainUphold('org_1', 'p1', {
        arbiter: '0xabc',
        transactionHash: null,
      });
      expect(dispute.state).toBe('REJECTED');
      // Nothing won yet: nothing to change.
      expect(await ctx.service.recordPartialChainWin('org_1', 'p1')).toBe(false);

      ctx.proposals.rows.get('p1')!.chainDisputeWonAt = new Date('2026-10-19T00:00:00Z');
      expect(await ctx.service.recordPartialChainWin('org_1', 'p1')).toBe(true);
      expect(dispute).toMatchObject({
        state: 'PARTIALLY_UPHELD',
        outcome: ArbitrationOutcome.UPHELD_RECALCULATED,
        resolutionKind: ResolutionKind.CHAIN_ARBITER,
        resolvedBy: 'chain:upholdSlash:0xabc',
      });
      expect(await ctx.service.recordPartialChainWin('org_1', 'p1')).toBe(false);
    });

    it('R3-6: every state/outcome pair the chain paths write is one the outcome map produces', async () => {
      const ctx = build();
      seedEvm(ctx, SlashProposalStatus.DISPUTED);
      await ctx.service.recordChainUphold('org_1', 'p1', {
        arbiter: '0xabc',
        transactionHash: null,
      });
      ctx.proposals.rows.get('p1')!.chainDisputeWonAt = new Date('2026-10-19T00:00:00Z');
      await ctx.service.recordPartialChainWin('org_1', 'p1');

      const other = build();
      seedEvm(other, SlashProposalStatus.DISPUTED);
      await other.service.recordChainStanding('org_1', 'p1');
      await other.service.recordChainUphold('org_1', 'p1', {
        arbiter: '0xabc',
        transactionHash: null,
      });
      other.proposals.rows.get('p1')!.chainDisputeWonAt = new Date('2026-10-19T00:00:00Z');
      await other.service.recordPartialChainWin('org_1', 'p1');

      const rows = [...ctx.disputes.values(), ...other.disputes.values()];
      const pairs = [...ctx.disputeWrites, ...other.disputeWrites, ...rows]
        .filter((row) => row.state != null && row.outcome != null)
        .map((row) => [row.outcome, row.state]);
      expect(pairs.length).toBeGreaterThan(0);
      for (const [outcome, state] of pairs) {
        expect([outcome, ARBITRATION_STATE_MAP[outcome as ArbitrationOutcome]]).toEqual([
          outcome,
          state,
        ]);
      }
    });
  });
});
