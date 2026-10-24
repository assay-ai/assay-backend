import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { SlaWindowCallRepository } from '@database/postgres/repositories/sla-window-call.repository';
import { SlashProposalPartRepository } from '@database/postgres/repositories/slash-proposal-part.repository';

import { freshMigratedDatabase } from '../helpers/slash-prorata-context';
import { seedProRataCase, SeededCase } from '../helpers/slash-prorata-seed';

/**
 * Review 2026-10-23 M-1 (self-slashing), the two reads against a real
 * Postgres built from every migration: which payers of a window's failed
 * calls are linked to the provider, and how much has been signed against the
 * provider in the last rolling day.
 */
const DATABASE = 'assay_slash_linked_beneficiary_test';
const CHAIN = 'eip155:46630';
const USDG = `${CHAIN}/erc20:0xDbbC156dD414f43f2c952C1Be0f16A0B9a826Cd3`;
const STAKE = `${CHAIN}:0xA271A3407D3302f4b4Fbe469b9188487cedd7d45`;
const HONEST = `${CHAIN}:0x976ea74026e726554db657fa54763abd0c3a0aa9`;
/** Pays from the provider's own stake wallet (another spelling of it). */
const OWN_WALLET = `${CHAIN}:0xa271a3407d3302f4b4fbe469b9188487cedd7d45`;
/** Paid under the provider's own organization. */
const SAME_ORG = `${CHAIN}:0x64fecbe18e8998cb2990bce631a042f8e2be1659`;
/** An agent of the tool's publishing organization. */
const PUBLISHER_AGENT = `${CHAIN}:0xd30814fd3916fc7fc6ea87d4c429f7b0b7cc4d1d`;
/** The primary wallet of one of the provider organization's agents. */
const MEMBER_WALLET = `${CHAIN}:0x1111111111111111111111111111111111111114`;

describe('M-1: linked beneficiaries and the provider’s daily budget, against a real database', () => {
  let dataSource: DataSource;
  let windowCalls: SlaWindowCallRepository;
  let parts: SlashProposalPartRepository;
  let seeded: SeededCase;
  const providerOrg = randomUUID();
  const publisherOrg = randomUUID();

  async function organization(id: string): Promise<void> {
    await dataSource.query(`INSERT INTO organizations (id, name) VALUES ($1, $2)`, [id, id]);
  }

  async function agentOf(org: string, primary: string | null): Promise<string> {
    const id = randomUUID();
    await dataSource.query(
      `INSERT INTO agents (id, organization_id, privy_user_id, primary_account_id, chain_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, org, `did:privy:${id}`, primary, primary ? CHAIN : null],
    );
    return id;
  }

  beforeAll(async () => {
    dataSource = await freshMigratedDatabase(DATABASE);
    windowCalls = new SlaWindowCallRepository(dataSource);
    parts = new SlashProposalPartRepository(dataSource);
    await organization(providerOrg);
    await organization(publisherOrg);

    seeded = await seedProRataCase(dataSource, {
      providerOrg,
      stakeAuthority: STAKE,
      assetId: USDG,
      penalty: 500_000n,
      proposedAt: new Date(),
      agents: [HONEST, OWN_WALLET, SAME_ORG, PUBLISHER_AGENT, MEMBER_WALLET].map((account) => ({
        account,
        failed: [100_000n],
      })),
    });

    // A provider-published tool: the publisher owns it (`chk_tools_owner`).
    await dataSource.query(
      `UPDATE tools SET kind = 'PROVIDER', owner_org_id = $1, visibility = 'PRIVATE',
                        review_status = 'NONE', name = 'publisher__linked_tool'
        WHERE id = $2`,
      [publisherOrg, seeded.toolId],
    );
    await dataSource.query(
      `UPDATE payment_intents SET organization_id = $1 WHERE agent_account = $2`,
      [providerOrg, SAME_ORG],
    );
    const publisherAgent = await agentOf(publisherOrg, null);
    await dataSource.query(`UPDATE payment_intents SET agent_id = $1 WHERE agent_account = $2`, [
      publisherAgent,
      PUBLISHER_AGENT,
    ]);
    await agentOf(providerOrg, MEMBER_WALLET.replace('0x1111', '0X1111').toUpperCase());
  }, 300_000);
  afterAll(async () => dataSource?.destroy());

  it('names every linked payer, and never the honest one', async () => {
    const linked = await windowCalls.linkedAgentAccounts(
      seeded.windowId,
      USDG,
      providerOrg,
      seeded.toolId,
    );
    expect([...linked].sort()).toEqual(
      [OWN_WALLET, SAME_ORG, PUBLISHER_AGENT, MEMBER_WALLET].sort(),
    );
  });

  it('names nobody for another provider’s calls', async () => {
    await expect(
      windowCalls.linkedAgentAccounts(seeded.windowId, USDG, randomUUID(), seeded.toolId),
    ).resolves.toEqual([]);
  });

  it('sums every standing part of any age, and the parts executed in the last day', async () => {
    const insert = (
      status: string,
      penalty: string,
      proposedAgo: string,
      reserved: string | null,
    ) =>
      dataSource.query(
        `INSERT INTO slash_proposal_parts (organization_id, proposal_id, chain_epoch, window_id,
           agent_account, beneficiary_account, weight_amount, uncapped_share_amount, penalty_amount,
           plan_penalty_amount, plan_capped_total, cap_binding, chain_request_id, chain_status,
           chain_proposed_at, chain_executable_at, chain_reserved, executed_at, applied_amount,
           agent_amount, platform_amount)
         VALUES ($1, $2, 0, $3, $4, $4, 1, $5, $5, $5, $5, 'NONE', $6, $7::varchar,
                 now() - $8::interval, now(), $9,
                 CASE WHEN $7::text = 'EXECUTED' THEN now() - $8::interval END,
                 CASE WHEN $7::text = 'EXECUTED' THEN $5::numeric END,
                 CASE WHEN $7::text = 'EXECUTED' THEN 0 END,
                 CASE WHEN $7::text = 'EXECUTED' THEN 0 END)`,
        [
          seeded.organizationId,
          seeded.proposalId,
          seeded.windowId,
          `${CHAIN}:0x${randomUUID().replace(/-/g, '').padStart(40, '0')}`,
          penalty,
          randomUUID().replace(/-/g, '').padEnd(64, '0'),
          status,
          proposedAgo,
          reserved,
        ],
      );
    await insert('PENDING', '100', '1 hour', '90'); // its reservation counts
    await insert('EXECUTED', '200', '23 hours', null); // executed inside the rolling day
    await insert('EXECUTED', '250', '30 hours', null); // executed before it: released
    await insert('DISPUTED', '300', '2 hours', null);
    await insert('CANCELLED', '400', '1 hour', null); // takes nothing from the window
    await insert('REFUSED', '500', '1 hour', null);
    await insert('PENDING', '600', '25 hours', null); // still standing: counts (F-M1)
    await insert('DISPUTED', '700', '40 days', null); // self-disputed long ago: still counts

    const since = new Date(Date.now() - 86_400_000);
    await expect(parts.committedAgainstProvider(providerOrg, CHAIN, since)).resolves.toEqual({
      standing: 1690n,
      executedSince: 200n,
    });
    await expect(parts.committedAgainstProvider(providerOrg, 'eip155:1', since)).resolves.toEqual({
      standing: 0n,
      executedSince: 0n,
    });
  });
});
