import { Logger } from '@nestjs/common';

import { SlashProposalEntity } from '@database/postgres/entities/slash-proposal.entity';
import { SlashProposalPartEntity } from '@database/postgres/entities/slash-proposal-part.entity';
import { ChainId } from '@modules/chains/ports/caip.types';
import { SlashCaps } from '@modules/slash/ports/slash-caps-reader.port';
import {
  oneByOne,
  SlashExecutionRequest,
  SlashProposalRequest,
  SlashProposalResult,
} from '@modules/slash/ports/slash-executor.port';
import { SlashPartsService } from '@modules/slash/services/slash-parts.service';

/**
 * Review 2026-10-24 wave 3 N-1: the provider's slash window is metered around
 * the NEW record's own door (proposal time + slash delay), and the pending
 * backlog is capped at what the chain can execute before the records expire.
 *
 * A small simulation of the chain against the service: cases arrive far
 * faster than one window a day; a keeper executes every due record it can
 * (one window per rolling 24 h, all-or-wait, a record expires 7 days after its
 * door). No record this platform signed may expire unpaid, and no rolling day
 * of doors may hold more than one window.
 */

const CHAIN = 'eip155:46630' as ChainId;
const ASSET = `${CHAIN}/erc20:0xDbbC156dD414f43f2c952C1Be0f16A0B9a826Cd3`;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const GRACE = 7 * DAY;
const DELAY_SECONDS = 72 * 3600;
const T0 = new Date('2026-10-11T10:00:00Z').getTime();
const agent = (n: number) => `${CHAIN}:0x${n.toString(16).padStart(40, '0')}`;

const WINDOW = 20_000_000n;
const CAPS: SlashCaps = {
  penaltyCeilingMinor: 1_000_000n,
  windowAllowanceMinor: WINDOW,
  freeStakeMinor: 199_000_000n,
  pendingSlashMinor: 0n,
  verifierDailyCapMinor: 500_000_000n,
  agentBps: 6000,
  platformBps: 3000,
};

/** `committedAgainstProvider` exactly as its SQL computes it, over shared rows. */
class SqlFaithfulParts {
  rows: SlashProposalPartEntity[] = [];
  async committedAgainstProvider(_p: string, _c: string, windowOpensAfter: Date) {
    let pendingInWindow = 0n;
    let executedInWindow = 0n;
    let pendingTotal = 0n;
    for (const row of this.rows) {
      const amount = BigInt(row.chainReserved ?? row.penaltyAmount);
      if (row.chainStatus === 'PENDING') {
        pendingTotal += amount;
        if (row.chainExecutableAt! > windowOpensAfter) pendingInWindow += amount;
      }
      if (
        row.chainStatus === 'EXECUTED' &&
        (row.executedAt ?? row.chainProposedAt)! > windowOpensAfter
      ) {
        executedInWindow += amount;
      }
    }
    return { pendingInWindow, executedInWindow, pendingTotal };
  }
  async findForEpoch(_organizationId: string, proposalId: string, chainEpoch: number) {
    return this.rows
      .filter((row) => row.proposalId === proposalId && row.chainEpoch === chainEpoch)
      .sort((a, b) => (a.agentAccount < b.agentAccount ? -1 : 1))
      .map((row) => ({ ...row }) as SlashProposalPartEntity);
  }
  async insertPlan(organizationId: string, proposalId: string, chainEpoch: number, rows: object[]) {
    if (this.rows.some((row) => row.proposalId === proposalId && row.chainEpoch === chainEpoch)) {
      return this.findForEpoch(organizationId, proposalId, chainEpoch);
    }
    rows.forEach((row, i) =>
      this.rows.push({
        id: `part-${this.rows.length + i}`,
        organizationId,
        proposalId,
        chainEpoch,
        chainProposedAt: null,
        chainExecutableAt: null,
        chainReserved: null,
        executedAt: null,
        chainLastError: null,
        proposeAttempts: 0,
        ...row,
      } as unknown as SlashProposalPartEntity),
    );
    return this.findForEpoch(organizationId, proposalId, chainEpoch);
  }
  async updatePart(_organizationId: string, id: string, patch: object) {
    Object.assign(this.rows.find((candidate) => candidate.id === id)!, patch);
  }
}

/** Proposals land at the simulated clock, with the door the chain would freeze. */
class ClockExecutor {
  now = T0;
  proposed = 0;
  async slashDelaySeconds() {
    return DELAY_SECONDS;
  }
  async propose(request: SlashProposalRequest): Promise<SlashProposalResult> {
    return {
      signature: 'tx',
      status: 'PENDING',
      proposedAt: new Date(this.now),
      executableAt: new Date(this.now + DELAY_SECONDS * 1000),
      reservedMinor: request.penaltyMinor,
      adopted: false,
    };
  }
  async proposeBatch(requests: readonly SlashProposalRequest[]) {
    this.proposed += 1;
    return oneByOne(requests, (request) => this.propose(request));
  }
  async executeBatch(requests: readonly SlashExecutionRequest[]) {
    return oneByOne(requests, async () => {
      throw new Error('unused');
    });
  }
  async readRecord() {
    return null;
  }
}

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

describe('review 2026-10-24 wave 3 N-1: no honest record is signed only to expire', () => {
  it('signs a burst of cases no faster than the chain can execute them', async () => {
    const parts = new SqlFaithfulParts();
    const executor = new ClockExecutor();
    const agents: [string, string][] = Array.from({ length: 20 }, (_, i) => [
      agent(i + 1),
      '1000000',
    ]);
    const windowCalls = {
      linkedAgentAccounts: async () => [],
      sumFailedPriceByAgent: async () =>
        agents.map(([agentAccount, spend]) => ({ organizationId: 'o', agentAccount, spend })),
      failedCallPaymentsByAgent: async () =>
        agents.map(([agentAccount, paid]) => ({
          agentAccount,
          failedCalls: '1',
          paid,
          redeemed: '0',
        })),
    };
    const pending = () =>
      parts.rows
        .filter((row) => row.chainStatus === 'PENDING')
        .reduce((sum, row) => sum + BigInt(row.chainReserved ?? row.penaltyAmount), 0n);
    const service = new SlashPartsService(
      parts as never,
      windowCalls as never,
      executor as never,
      { dustReportBelowMinor: 0n, stragglerMaxAttempts: 3, stragglerDeadlineMs: DAY },
      // Free stake shrinks with every standing record, as the chain's pendingSlash grows.
      {
        readCaps: async () => ({
          ...CAPS,
          freeStakeMinor: CAPS.freeStakeMinor - pending(),
          pendingSlashMinor: pending(),
        }),
      },
    );

    // A case every 2 h for 3 days (36 cases of up to a window each: far more
    // than one window a day), retried each tick until signed; the run goes on
    // until every case is signed and every door and grace has passed.
    const open: SlashProposalEntity[] = [];
    let expired = 0n;
    let executed = 0n;
    for (let tick = 0; tick < 60 * 12; tick += 1) {
      executor.now = T0 + tick * 2 * HOUR;
      if (tick < 36) {
        open.push({
          id: `case-${tick}`,
          organizationId: 'provider-org',
          assetId: ASSET,
          windowId: `6f1c9b2e-0000-4000-8000-${String(tick).padStart(12, '0')}`,
          chainEpoch: 0,
          chainRequestId: tick.toString(16).padStart(64, '0'),
          penaltyAmount: '20000000',
          toolId: 'tool-1',
          providerId: 'provider-1',
        } as SlashProposalEntity);
      }
      for (const proposal of [...open]) {
        const signed = await service
          .propose(proposal, '0xprovider', new Date(executor.now))
          .then(() => true)
          .catch(() => false);
        if (signed) open.splice(open.indexOf(proposal), 1);
      }

      // The keeper, as the chain admits it.
      const due = parts.rows
        .filter((row) => row.chainStatus === 'PENDING')
        .sort((a, b) => a.chainExecutableAt!.getTime() - b.chainExecutableAt!.getTime());
      for (const row of due) {
        const door = row.chainExecutableAt!.getTime();
        const amount = BigInt(row.chainReserved!);
        if (executor.now > door + GRACE) {
          row.chainStatus = 'CANCELLED' as never;
          expired += amount;
          continue;
        }
        if (executor.now < door) continue;
        const used = parts.rows
          .filter(
            (other) =>
              other.chainStatus === 'EXECUTED' && other.executedAt!.getTime() > executor.now - DAY,
          )
          .reduce((sum, other) => sum + BigInt(other.chainReserved!), 0n);
        if (used + amount > WINDOW) continue;
        row.chainStatus = 'EXECUTED' as never;
        row.executedAt = new Date(executor.now);
        executed += amount;
      }
    }

    expect(expired).toBe(0n);
    expect(open).toEqual([]);
    expect(executor.proposed).toBeGreaterThan(1);
    expect(executed).toBeGreaterThan(WINDOW);
    // No rolling day of doors holds more than one window.
    const landed = parts.rows.filter((row) => row.chainExecutableAt !== null);
    for (const row of landed) {
      const from = row.chainExecutableAt!.getTime();
      const inDay = landed
        .filter((other) => {
          const door = other.chainExecutableAt!.getTime();
          return door >= from && door < from + DAY;
        })
        .reduce((sum, other) => sum + BigInt(other.chainReserved!), 0n);
      expect(inDay).toBeLessThanOrEqual(WINDOW);
    }
  });
});
