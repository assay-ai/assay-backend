import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { SlashProposalRepository } from '@database/postgres/repositories/slash-proposal.repository';
import {
  OperatorCaseFacts,
  OperatorCaseStatus,
  operatorCaseDeadlineOf,
  operatorCaseStatusOf,
} from '@modules/operator/domain/operator-case-status';
import { DISPUTE_TIMEOUT_MS } from '@modules/slash/constants/slash.constants';

import { CHAIN } from '../../unit/chains/evm/helpers/fake-stake-chain';
import { freshMigratedDatabase } from '../helpers/slash-prorata-context';
import { seedProRataCase } from '../helpers/slash-prorata-seed';

/**
 * The operator Penalties list's SQL (`findOperatorCasePage`) against a real
 * Postgres built from every migration, held to its definition in TypeScript
 * (`operatorCaseStatusOf` / `operatorCaseDeadlineOf`, the console case
 * screen's reading of the same case). Every row is seeded in a state the
 * audit named (D1–D4) or a neighbour of one, and the list must name it, and
 * date it, exactly as the definition does.
 */
const DATABASE = 'assay_operator_case_list_test';
const EVM_ASSET = `${CHAIN}/erc20:0xDbbC156dD414f43f2c952C1Be0f16A0B9a826Cd3`;
const STAKE_AUTHORITY = `${CHAIN}:0xA271A3407D3302f4b4Fbe469b9188487cedd7d45`;
const AGENT = `${CHAIN}:0x976ea74026e726554db657fa54763abd0c3a0aa9`;
const PROPOSED_AT = new Date('2026-10-01T00:00:00Z');
const DISPUTED_AT = new Date('2026-10-02T00:00:00Z');
const CHAIN_DOOR = new Date('2026-10-04T00:00:00Z');
const LATER_DOOR = new Date('2026-10-09T00:00:00Z');
const RESOLVED_AT = new Date('2026-10-03T00:00:00Z');

interface Scenario {
  readonly name: string;
  readonly expected: OperatorCaseStatus;
  readonly patch: Readonly<Record<string, unknown>>;
}

const closed = { resolved_at: RESOLVED_AT };

const SCENARIOS: readonly Scenario[] = [
  {
    name: 'D1: DISPUTED, its only disputed part gone, a part pending',
    expected: OperatorCaseStatus.PROPOSED,
    patch: {
      status: 'DISPUTED',
      chain_status: 'PENDING',
      chain_disputed_at: DISPUTED_AT,
      chain_disputed_parts: 0,
      chain_executable_at: CHAIN_DOOR,
    },
  },
  {
    name: 'D2: PROPOSED on chain, door before the floor',
    expected: OperatorCaseStatus.PROPOSED,
    patch: { chain_status: 'PENDING', chain_executable_at: CHAIN_DOOR },
  },
  {
    name: 'D2: PROPOSED on chain, door after the floor',
    expected: OperatorCaseStatus.PROPOSED,
    patch: { chain_status: 'PENDING', chain_executable_at: LATER_DOOR },
  },
  {
    name: 'D2: PROPOSED, not on chain yet',
    expected: OperatorCaseStatus.PROPOSED,
    patch: {},
  },
  {
    name: 'D4: chain REFUSED on an open case',
    expected: OperatorCaseStatus.PROPOSED,
    patch: { chain_status: 'REFUSED' },
  },
  {
    name: 'D4: chain REFUSED and voided',
    expected: OperatorCaseStatus.CANCELLED,
    patch: {
      ...closed,
      status: 'CANCELLED',
      chain_status: 'REFUSED',
      resolution_kind: 'AUTO_CHAIN_VOIDED',
    },
  },
  {
    name: "D3: the arbiter's cancelSlash after a dispute",
    expected: OperatorCaseStatus.CANCELLED,
    patch: {
      ...closed,
      status: 'CANCELLED',
      chain_status: 'CANCELLED',
      resolution_kind: 'CHAIN_ARBITER',
      chain_disputed_at: DISPUTED_AT,
      chain_executable_at: CHAIN_DOOR,
    },
  },
  {
    name: 'D3: an unruled dispute expired',
    expected: OperatorCaseStatus.EXPIRED,
    patch: {
      ...closed,
      status: 'CANCELLED',
      chain_status: 'CANCELLED',
      resolution_kind: 'AUTO_CHAIN_VOIDED',
      chain_disputed_at: DISPUTED_AT,
      chain_executable_at: CHAIN_DOOR,
    },
  },
  {
    name: 'every part disputed on chain',
    expected: OperatorCaseStatus.CHAIN_DISPUTED,
    patch: {
      status: 'DISPUTED',
      chain_status: 'DISPUTED',
      chain_disputed_at: DISPUTED_AT,
      chain_disputed_parts: 2,
      chain_executable_at: CHAIN_DOOR,
    },
  },
  {
    name: 'partly disputed on chain',
    expected: OperatorCaseStatus.CHAIN_DISPUTED,
    patch: {
      status: 'DISPUTED',
      chain_status: 'PENDING',
      chain_disputed_at: DISPUTED_AT,
      chain_disputed_parts: 1,
      chain_executable_at: CHAIN_DOOR,
    },
  },
  {
    name: 'a cancel waiting under a disputed record',
    expected: OperatorCaseStatus.CANCEL_REQUESTED,
    patch: {
      status: 'CANCELLED',
      chain_status: 'CANCEL_REQUESTED',
      chain_disputed_at: DISPUTED_AT,
      chain_disputed_parts: 1,
      chain_executable_at: CHAIN_DOOR,
    },
  },
  {
    name: 'a cancel waiting under a pending record',
    expected: OperatorCaseStatus.CANCEL_REQUESTED,
    patch: {
      status: 'CANCELLED',
      chain_status: 'CANCEL_REQUESTED',
      chain_executable_at: CHAIN_DOOR,
    },
  },
  {
    name: 'suspended, record cancelled',
    expected: OperatorCaseStatus.CANCELLED,
    patch: { status: 'CANCELLED', chain_status: 'CANCELLED', chain_executable_at: CHAIN_DOOR },
  },
];

describe('the operator case list SQL, against a real database', () => {
  let dataSource: DataSource;
  let repository: SlashProposalRepository;
  const ids = new Map<string, Scenario>();

  beforeAll(async () => {
    dataSource = await freshMigratedDatabase(DATABASE);
    repository = new SlashProposalRepository(dataSource);
    for (const scenario of SCENARIOS) {
      const seeded = await seedProRataCase(dataSource, {
        providerOrg: randomUUID(),
        stakeAuthority: STAKE_AUTHORITY,
        assetId: EVM_ASSET,
        penalty: 1_000_000n,
        agents: [{ account: AGENT, failed: [100_000n] }],
        proposedAt: PROPOSED_AT,
      });
      const patch: Record<string, unknown> = { ...scenario.patch };
      // `chk_slash_proposals_chain_pending_is_whole`: a record on chain was proposed.
      if (patch.chain_status) patch.chain_proposed_at = PROPOSED_AT;
      const columns = Object.keys(patch);
      if (columns.length > 0) {
        await dataSource.query(
          `UPDATE slash_proposals SET ${columns.map((column, i) => `"${column}" = $${i + 2}`).join(', ')} WHERE id = $1`,
          [seeded.proposalId, ...columns.map((column) => patch[column])],
        );
      }
      ids.set(seeded.proposalId, scenario);
    }
  }, 240_000);

  afterAll(async () => {
    await dataSource?.destroy();
  });

  it('names and dates every case as the definition does', async () => {
    const rows = await repository.findOperatorCasePage({ limit: 100 });
    expect(rows).toHaveLength(SCENARIOS.length);

    const stored: Array<Record<string, unknown>> = await dataSource.query(
      `SELECT id, status, chain_status, resolution_kind, chain_disputed_at,
              chain_disputed_parts, chain_executable_at, earliest_execution_at
         FROM slash_proposals`,
    );
    const factsById = new Map<string, OperatorCaseFacts>(
      stored.map((row) => [
        row.id as string,
        {
          status: row.status as string,
          chainStatus: (row.chain_status as string | null) ?? 'NONE',
          resolutionKind: row.resolution_kind as string | null,
          chainDisputedAt: row.chain_disputed_at as Date | null,
          chainDisputedParts: Number(row.chain_disputed_parts ?? 0),
          chainExecutableAt: row.chain_executable_at as Date | null,
          earliestExecutionAt: row.earliest_execution_at as Date | null,
        },
      ]),
    );

    for (const row of rows) {
      const scenario = ids.get(row.id)!;
      const facts = factsById.get(row.id)!;
      const status = operatorCaseStatusOf(facts);
      const deadline = operatorCaseDeadlineOf(facts, status, DISPUTE_TIMEOUT_MS);
      expect({ name: scenario.name, status: row.status }).toEqual({
        name: scenario.name,
        status: scenario.expected,
      });
      expect({ name: scenario.name, status: row.status, deadline: row.nextDeadline }).toEqual({
        name: scenario.name,
        status,
        deadline,
      });
    }
  });

  it('says whether a record was ever written on chain', async () => {
    const rows = await repository.findOperatorCasePage({ limit: 100 });
    for (const row of rows) {
      const scenario = ids.get(row.id)!;
      expect({ name: scenario.name, onChain: row.onChain }).toEqual({
        name: scenario.name,
        onChain: 'chain_status' in scenario.patch,
      });
    }
  });

  it('D1: the case left DISPUTED sorts with the open cases, at its door', async () => {
    const d1 = (await repository.findOperatorCasePage({ limit: 100 })).find((row) =>
      ids.get(row.id)!.name.startsWith('D1'),
    )!;
    expect(d1).toMatchObject({ status: OperatorCaseStatus.PROPOSED, nextDeadline: CHAIN_DOOR });
  });
});
