import { randomUUID } from 'node:crypto';

import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { ProviderChainEnrolmentRepository } from '@database/postgres/repositories/provider-chain-enrolment.repository';
import { ProviderSlashHoldRepository } from '@database/postgres/repositories/provider-slash-hold.repository';
import { SlashProposalRepository } from '@database/postgres/repositories/slash-proposal.repository';
import { EvmSlashHoldMonitor } from '@modules/chains/evm/evm-slash-hold.monitor';
import { PaymentIntentService } from '@modules/payment/services/payment-intent.service';
import { MoneyUtil } from '@shared/utils/money.util';

import { blocklistOf } from '../../unit/helpers/blocklist';
import { freshMigratedDatabase } from '../helpers/slash-prorata-context';
import { seedProRataCase } from '../helpers/slash-prorata-seed';

/**
 * The provider slash hold against real Postgres: the monitor reads a stub
 * chain (stakeOf, params) and the real upheld-case query, writes
 * `provider_slash_holds`, and the payment path refuses a held provider. One
 * case per condition, and the release after two clear checks.
 */
const DATABASE = 'assay_provider_slash_hold_test';
const CHAIN = 'eip155:46630';
const ASSET = `${CHAIN}/erc20:0xDbbC156dD414f43f2c952C1Be0f16A0B9a826Cd3`;
const AUTHORITY = '0xA271A3407D3302f4b4Fbe469b9188487cedd7d45';
const AGENT = `${CHAIN}:0x976ea74026e726554db657fa54763abd0c3a0aa9`;
const NOW = new Date('2026-10-15T12:00:00Z');

describe('provider slash hold, against a real database', () => {
  let dataSource: DataSource;
  let holds: ProviderSlashHoldRepository;
  const params = { penaltyAmount: 1_000_000n, minimumStake: 50_000_000n };
  let stake: {
    bonded: bigint;
    unbonding: bigint;
    pendingSlash: bigint;
  };

  beforeAll(async () => {
    dataSource = await freshMigratedDatabase(DATABASE);
    holds = new ProviderSlashHoldRepository(dataSource);
  }, 300_000);
  afterAll(async () => dataSource?.destroy());

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    await dataSource.query(
      `TRUNCATE provider_slash_holds, slash_proposal_parts, slash_proposal_events,
         slash_proposals, sla_strikes, sla_window_calls, sla_windows, tool_bindings,
         payment_intents, provider_chain_enrolments CASCADE`,
    );
    stake = {
      bonded: 100_000_000n,
      unbonding: 0n,
      pendingSlash: 0n,
    };
  });
  afterEach(() => jest.restoreAllMocks());

  async function seed(): Promise<string> {
    const providerOrg = randomUUID();
    await seedProRataCase(dataSource, {
      providerOrg,
      stakeAuthority: `${CHAIN}:${AUTHORITY}`,
      assetId: ASSET,
      penalty: 1_000_000n,
      proposedAt: new Date(NOW.getTime() - 96 * 3_600_000),
      agents: [{ account: AGENT, failed: [100_000n] }],
    });
    return providerOrg;
  }

  function monitor(now = NOW) {
    return new EvmSlashHoldMonitor(
      new Map([
        [
          CHAIN,
          {
            readContract: async ({ functionName }: { functionName: string }) =>
              functionName === 'params' ? params : stake,
          },
        ],
      ]) as never,
      new Map([
        [CHAIN, { config: '0xBF2DE8e24254Cf6f2313Ab4B5CeBE8066bBdb0e5', stake: '0x0aF4' }],
      ]) as never,
      [CHAIN as never],
      new ProviderChainEnrolmentRepository(dataSource),
      new SlashProposalRepository(dataSource),
      holds,
      () => now.getTime(),
    );
  }

  /** The seeded case upheld, its record due, and its last execute refused by `error`. */
  async function upheldAndDue(providerOrg: string, error: string | null) {
    await dataSource.query(
      `UPDATE slash_proposals
          SET status = 'UPHELD', chain_status = 'PENDING', chain_proposed_at = $2,
              chain_executable_at = $3, chain_reserved = 1000000, chain_last_error = $4
        WHERE provider_id = $1`,
      [
        providerOrg,
        new Date(NOW.getTime() - 96 * 3_600_000),
        new Date(NOW.getTime() - 3_600_000),
        error,
      ],
    );
  }

  it('1. holds on an upheld record whose execute was refused SlashWindowNotDrained', async () => {
    const providerOrg = await seed();
    await upheldAndDue(providerOrg, 'SlashWindowNotDrained');
    await monitor().tick();
    expect(await holds.findHeld([providerOrg])).toEqual([
      expect.objectContaining({ chainId: CHAIN, reasons: ['SLASH_WINDOW_FULL'] }),
    ]);
  });

  it('1. holds on a part of the waiting case refused SlashWindowNotDrained', async () => {
    const providerOrg = await seed();
    await upheldAndDue(providerOrg, null);
    await dataSource.query(
      `INSERT INTO slash_proposal_parts
         (organization_id, proposal_id, chain_epoch, window_id, agent_account,
          beneficiary_account, weight_amount, uncapped_share_amount, penalty_amount,
          plan_penalty_amount, plan_capped_total, cap_binding, chain_request_id, chain_status,
          chain_last_error, chain_proposed_at, chain_executable_at)
       SELECT organization_id, id, chain_epoch, window_id, $2, $2, 1, 1, 1, 1, 1, 'NONE',
              repeat('a', 64), 'PENDING', 'SlashWindowNotDrained', chain_proposed_at,
              chain_executable_at
         FROM slash_proposals WHERE provider_id = $1`,
      [providerOrg, AGENT],
    );
    await monitor().tick();
    expect(await holds.isHeld(providerOrg, CHAIN)).toBe(true);
  });

  it('2. holds when the free stake cannot back another penalty', async () => {
    const providerOrg = await seed();
    // Free stake exactly one penalty still backs it (review S-6): one unit less.
    stake.pendingSlash = 99_000_001n;
    await monitor().tick();
    expect(await holds.findHeld([providerOrg])).toEqual([
      expect.objectContaining({ reasons: ['STAKE_FULLY_RESERVED'] }),
    ]);
  });

  it('3. holds when bonded is below the minimum stake, and refuses a new payment intent', async () => {
    const providerOrg = await seed();
    stake.bonded = 10_000_000n;
    await monitor().tick();
    expect(await holds.isHeld(providerOrg, CHAIN)).toBe(true);

    const intents = { insert: jest.fn(), insertAdmittedVoucherIntent: jest.fn() };
    const payments = new PaymentIntentService(
      intents as never,
      {} as never,
      {} as never,
      blocklistOf(),
      null,
      holds,
    );
    await expect(
      payments.create({
        organizationId: randomUUID(),
        agentId: randomUUID(),
        agentAccount: AGENT,
        providerId: providerOrg,
        providerAccount: `${CHAIN}:${AUTHORITY}`,
        toolId: randomUUID(),
        rail: 'RAIL_B_VOUCHER',
        callId: randomUUID(),
        callClass: 'PAID',
        price: MoneyUtil.of('1000', ASSET as never, 6),
        platformFee: MoneyUtil.of('0', ASSET as never, 6),
        requestHash: `sha256:${'ab'.repeat(32)}`,
        chainId: CHAIN,
      } as never),
    ).rejects.toMatchObject({ errorCode: 'PAYMENT_PROVIDER_SLASH_HOLD' });
    expect(intents.insert).not.toHaveBeenCalled();
  });

  it('does not hold a healthy provider, nor one whose waiting record was not refused', async () => {
    const providerOrg = await seed();
    await upheldAndDue(providerOrg, 'SlashNotYetExecutable');
    await monitor().tick();
    expect(await holds.isHeld(providerOrg, CHAIN)).toBe(false);
  });

  it('resumes after two consecutive clear checks', async () => {
    const providerOrg = await seed();
    stake.pendingSlash = 99_000_001n;
    await monitor().tick();
    stake.pendingSlash = 0n;
    await monitor().tick();
    expect(await holds.isHeld(providerOrg, CHAIN)).toBe(true);
    await monitor().tick();
    expect(await holds.isHeld(providerOrg, CHAIN)).toBe(false);
    expect(await holds.findState(providerOrg, CHAIN)).toMatchObject({
      held: false,
      clearChecks: 0,
      releasedAt: NOW,
    });
  });
});
