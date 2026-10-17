import { createHash, randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { deriveChainRequestId } from '@modules/slash/services/slash-proposal.service';

/**
 * Seed one window-level SLA slash case the way the real path leaves it: a
 * binding, its CLOSED `BREACH_PROPOSED` window, the strike, the `PROPOSED`
 * case, the provider's stake-authority enrolment, and — per agent — the
 * `payment_intents` + `sla_window_calls` rows the pro-rata weights are read
 * from.
 *
 * Raw SQL on purpose: the subject under test is what READS these rows
 * (`sumFailedPriceByAgent`, the parts planner, the execution service), and a
 * seed that went through the services it is testing would be testing itself.
 * Every CHECK on the tables is satisfied rather than bypassed.
 */
export interface SeedAgent {
  /** CAIP-10 — the payer account, and on EVM the beneficiary. */
  readonly account: string;
  /** Prices of this agent's DATA_FAIL calls in the window, minor units. */
  readonly failed: readonly bigint[];
  /** Prices of its PASS calls — counted in the window, never a weight. */
  readonly passed?: readonly bigint[];
  /** Overrides the call asset (to seed a call priced in another asset). */
  readonly assetId?: string;
}

export interface SeedProRataCase {
  readonly providerOrg: string;
  /** CAIP-10 stake authority on the case's chain. */
  readonly stakeAuthority: string;
  readonly assetId: string;
  readonly penalty: bigint;
  readonly agents: readonly SeedAgent[];
  readonly proposedAt: Date;
  /** Defaults to `proposedAt + 48h`. */
  readonly respondByAt?: Date;
  /** Defaults to `proposedAt + 72h`. */
  readonly earliestExecutionAt?: Date;
  readonly label?: string;
}

export interface SeededCase {
  readonly organizationId: string;
  readonly proposalId: string;
  readonly windowId: string;
  readonly bindingId: string;
  readonly toolId: string;
  readonly chainRequestId: string;
}

const HOUR = 3_600_000;

export async function seedProRataCase(
  dataSource: DataSource,
  input: SeedProRataCase,
): Promise<SeededCase> {
  const chainId = input.assetId.split('/')[0];
  const bindingId = randomUUID();
  const toolId = randomUUID();
  const windowId = randomUUID();
  const strikeId = randomUUID();
  const proposalId = randomUUID();
  const org = input.providerOrg;
  const proposedAt = input.proposedAt;

  await dataSource.query(
    `INSERT INTO provider_chain_enrolments
       (organization_id, chain_id, payout_account_id, payout_proof, payout_proved_at,
        stake_authority_account_id, stake_proof, stake_proved_at, status)
     VALUES ($1, $2, $3, '{}'::jsonb, now(), $3, '{}'::jsonb, now(), 'ACTIVE')
     ON CONFLICT DO NOTHING`,
    [org, chainId, input.stakeAuthority],
  );

  // `tool_bindings.tool_id` references `tools` (1761000000000).
  await dataSource.query(
    `INSERT INTO tools (id, name, kind, category, visibility, status)
     VALUES ($1, $2, 'STANDARD', 'testing', 'LISTED', 'ACTIVE')`,
    [toolId, `slash_tool_${toolId.replace(/-/g, '').slice(0, 24)}`],
  );

  await dataSource.query(
    `INSERT INTO tool_bindings
       (id, organization_id, tool_id, endpoint, request_mapping, response_mapping, pricing_mode,
        price_amount, asset_id, sla_failure_rate, timeout_ms, settlement_chains, status)
     VALUES ($1, $2, $3, 'https://example.invalid', '{}'::jsonb, '{}'::jsonb, 'PAID',
             100000, $4, 0.02, 1000, ARRAY[$5]::varchar[], 'DRAFT')`,
    [bindingId, org, toolId, input.assetId, chainId],
  );

  const failedCount = input.agents.reduce((sum, agent) => sum + agent.failed.length, 0);
  const passedCount = input.agents.reduce((sum, agent) => sum + (agent.passed?.length ?? 0), 0);
  const verified = failedCount + passedCount;

  await dataSource.query(
    `INSERT INTO sla_windows
       (id, organization_id, provider_id, binding_id, tool_id, sequence, status, opened_at,
        deadline_at, declared_failure_rate, min_verified_calls, z_score, max_age_ms, warning_ratio,
        warning_min_sample_fraction, penalty_multiplier, asset_id, total_calls, verified_calls,
        failed_calls, closed_at, outcome)
     VALUES ($1, $2, $2, $3, $4, 1, 'CLOSED', $5, $6, 0.02, 1, 1.645, 604800000, 0.8, 0.5, 1,
             $7, $8, $8, $9, $6, 'BREACH_PROPOSED')`,
    [
      windowId,
      org,
      bindingId,
      toolId,
      new Date(proposedAt.getTime() - 24 * HOUR),
      proposedAt,
      input.assetId,
      verified,
      failedCount,
    ],
  );

  await dataSource.query(
    `INSERT INTO sla_strikes
       (id, organization_id, provider_id, binding_id, tool_id, window_id, recorded_at,
        window_opened_at, window_closed_at, total_calls, verified_calls, failed_calls,
        observed_rate, declared_failure_rate, min_verified_calls, z_score, tolerance,
        effective_threshold, excess_rate, estimated_bad_calls, average_price_amount,
        penalty_multiplier, penalty_amount, asset_id, computation, status)
     VALUES ($1, $2, $2, $3, $4, $5, $6, $7, $6, $8, $8, $9, 0.5, 0.02, 1, 1.645, 0.01, 0.03,
             0.47, 1, 100000, 1, $10, $11, '[]'::jsonb, 'PROPOSED')`,
    [
      strikeId,
      org,
      bindingId,
      toolId,
      windowId,
      proposedAt,
      new Date(proposedAt.getTime() - 24 * HOUR),
      verified,
      failedCount,
      input.penalty.toString(),
      input.assetId,
    ],
  );

  const chainRequestId = deriveChainRequestId({ id: proposalId, chainEpoch: 0 });
  await dataSource.query(
    `INSERT INTO slash_proposals
       (id, organization_id, provider_id, binding_id, tool_id, source, strike_id, window_id,
        status, chain_request_id, penalty_amount, asset_id, decimals, proposed_at, notified_at,
        respond_by_at, platform_decision_due_at, earliest_execution_at)
     VALUES ($1, $2, $2, $3, $4, 'SLA_STRIKE', $5, $6, 'PROPOSED', $7, $8, $9, 6, $10, $10,
             $11, $12, $13)`,
    [
      proposalId,
      org,
      bindingId,
      toolId,
      strikeId,
      windowId,
      chainRequestId,
      input.penalty.toString(),
      input.assetId,
      proposedAt,
      input.respondByAt ?? new Date(proposedAt.getTime() + 48 * HOUR),
      new Date(proposedAt.getTime() + 71 * HOUR),
      input.earliestExecutionAt ?? new Date(proposedAt.getTime() + 72 * HOUR),
    ],
  );

  let n = 0;
  for (const agent of input.agents) {
    const agentOrg = uuidFrom(`org:${agent.account}`);
    const calls = [
      ...agent.failed.map((price) => ({ price, failed: true })),
      ...(agent.passed ?? []).map((price) => ({ price, failed: false })),
    ];
    for (const call of calls) {
      n += 1;
      const intentId = randomUUID();
      const assetId = agent.assetId ?? input.assetId;
      await dataSource.query(
        `INSERT INTO payment_intents
           (id, organization_id, status, agent_id, agent_account, provider_id, tool_id, rail,
            asset_id, decimals, price_amount, provider_amount, platform_fee, request_hash,
            chain_id, expires_at, call_id, call_class, provider_account)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'RAIL_A_PER_CALL', $8, 6, $9, $9, 0, $10, $11,
                 now() + interval '1 day', $12, 'PAID', $13)`,
        [
          intentId,
          agentOrg,
          call.failed ? 'REFUNDED' : 'SETTLED',
          uuidFrom(`agent:${agent.account}`),
          agent.account,
          org,
          toolId,
          assetId,
          call.price.toString(),
          `sha256:${createHash('sha256').update(intentId).digest('hex')}`,
          assetId.split('/')[0],
          `call-${intentId}`,
          input.stakeAuthority,
        ],
      );
      await dataSource.query(
        `INSERT INTO sla_window_calls
           (organization_id, window_id, intent_id, agent_id, verdict, reason_code,
            counted_as_quality, counted_as_failure, price_amount, asset_id, posted_at)
         VALUES ($1, $2, $3, $4, $5, $6, true, $7, $8, $9, $10)`,
        [
          org,
          windowId,
          intentId,
          uuidFrom(`agent:${agent.account}`),
          call.failed ? 'FAIL' : 'PASS',
          call.failed ? 'out_of_range' : null,
          call.failed,
          call.price.toString(),
          assetId,
          new Date(proposedAt.getTime() - n * 1000),
        ],
      );
    }
  }

  return { organizationId: org, proposalId, windowId, bindingId, toolId, chainRequestId };
}

function uuidFrom(label: string): string {
  const hash = createHash('sha1').update(label).digest('hex');
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `5${hash.slice(13, 16)}`,
    ((parseInt(hash.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + hash.slice(17, 20),
    hash.slice(20, 32),
  ].join('-');
}
