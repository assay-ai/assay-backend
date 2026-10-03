import { randomUUID } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';

import { VerificationPolicyEntity } from '@database/postgres/entities/verification-policy.entity';
import { CreateVerificationPolicies1755700000000 } from '@database/postgres/migrations/1755700000000-create-verification-policies';
import { VerificationPolicyRepository } from '@database/postgres/repositories/verification-policy.repository';
import {
  DecisionPolicy,
  DecisionTrigger,
  PolicyMode,
  VerdictStatus,
  VerificationPolicy,
  VerificationRuleType,
  VerifierOutcome,
  VerifierResult,
} from '@modules/verification/domain';
import { DecisionPolicyService } from '@modules/verification/services/decision-policy.service';
import {
  KillSwitchConfig,
  RedisPolicyKillSwitchService,
} from '@modules/verification/services/redis-policy-kill-switch.service';
import { VerificationAggregatorService } from '@modules/verification/services/verification-aggregator.service';

import { ensureTestDatabase, testConnectionOptions } from './test-database';

loadEnv();

const DATABASE = 'x402_verification_test';

/**
 * Two policy-lifecycle mechanisms only exist across a boundary, so they are only
 * meaningful when tested across one:
 *
 * - **the promote gate** is enforced by a CHECK constraint, which a unit test
 *   against the pure `evaluatePromotion` cannot reach;
 * - **the kill switch** is a claim about one process learning what another one
 *   wrote, which is not a claim a single in-memory object can make.
 *
 * So this context runs the real migration against Postgres and gives out **two
 * independent kill-switch instances** sharing one Redis — `operator` and
 * `serving` — standing in for the console pod and an API pod. A test that
 * killed and read through the same instance would prove nothing about the
 * mechanism being tested.
 */
export interface VerificationTestContext {
  /** The console's side: registers, promotes, withdraws. */
  readonly operator: DecisionPolicyService;
  /** A different process: resolves policies and judges calls. */
  readonly serving: VerificationAggregatorService;
  /** The serving process's own kill-switch instance. */
  readonly servingKillSwitch: RedisPolicyKillSwitchService;
  readonly operatorKillSwitch: RedisPolicyKillSwitchService;
  readonly policies: VerificationPolicyRepository;
  readonly dataSource: DataSource;
  /** Milliseconds between polls in the serving process. The SLA under test. */
  readonly pollIntervalMs: number;
  /** Drop pub/sub delivery to the serving process, leaving only the poll. */
  silenceBroadcasts(): void;
  /**
   * Wipe the Redis kill list without touching the database.
   *
   * Stands in for the entry being flushed or evicted after a withdrawal was
   * already recorded, which is the case the durable row exists to cover.
   */
  forgetKillSwitchState(): Promise<void>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export interface CreateVerificationTestContextOptions {
  readonly pollIntervalMs?: number;
  readonly staleAfterMs?: number;
}

export async function createVerificationTestContext(
  options: CreateVerificationTestContextOptions = {},
): Promise<VerificationTestContext> {
  const database = await ensureTestDatabase(DATABASE);

  const dataSource = new DataSource({
    type: 'postgres',
    ...testConnectionOptions(),
    database,
    entities: [VerificationPolicyEntity],
    migrations: [CreateVerificationPolicies1755700000000],
    synchronize: false,
    logging: process.env.VERIFICATION_TEST_LOGGING === 'true',
  });

  await dataSource.initialize();
  await dataSource.runMigrations();

  const policies = new VerificationPolicyRepository(dataSource);

  // A namespace per run, so a leftover kill from a previous run cannot make a
  // later one pass or fail for a reason that is not in the test.
  const namespace = `test:killswitch:${randomUUID()}`;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;

  const url = process.env.REDIS_URL || 'redis://localhost:6379';
  const clients: Redis[] = [];
  const connect = (): Redis => {
    const client = new Redis(url, { maxRetriesPerRequest: 1 });
    clients.push(client);
    return client;
  };

  const config = (): KillSwitchConfig => ({
    namespace,
    pollIntervalMs,
    staleAfterMs: options.staleAfterMs ?? 30_000,
    now: () => Date.now(),
  });

  const operatorSubscriber = connect();
  const servingSubscriber = connect();
  const admin = connect();

  const operatorKillSwitch = new RedisPolicyKillSwitchService(
    connect(),
    operatorSubscriber,
    config(),
  );
  const servingKillSwitch = new RedisPolicyKillSwitchService(
    connect(),
    servingSubscriber,
    config(),
  );

  await operatorKillSwitch.onModuleInit();
  await servingKillSwitch.onModuleInit();

  const operator = new DecisionPolicyService(policies, operatorKillSwitch);
  // Deliberately a *second* `DecisionPolicyService` over the *serving*
  // process's kill switch. Sharing one would let the operator's own refresh
  // stand in for the propagation this suite is measuring.
  const servingPolicies = new DecisionPolicyService(policies, servingKillSwitch);
  const serving = new VerificationAggregatorService(servingPolicies);

  return {
    operator,
    serving,
    servingKillSwitch,
    operatorKillSwitch,
    policies,
    dataSource,
    pollIntervalMs,

    silenceBroadcasts(): void {
      servingSubscriber.removeAllListeners('message');
    },

    async forgetKillSwitchState(): Promise<void> {
      await admin.del(namespace);
      await servingKillSwitch.refresh();
    },

    async reset(): Promise<void> {
      await dataSource.query('TRUNCATE TABLE "verification_policies"');
      await admin.del(namespace);
      await operatorKillSwitch.refresh();
      await servingKillSwitch.refresh();
    },

    async close(): Promise<void> {
      await operatorKillSwitch.onModuleDestroy();
      await servingKillSwitch.onModuleDestroy();
      await Promise.all(clients.map((client) => client.quit().catch(() => undefined)));
      await dataSource.destroy();
    },
  };
}

/** A tool id every fixture in this suite shares unless it says otherwise. */
export const TEST_TOOL_ID = '5d4a1c26-1c2a-4d0e-9d63-9b0b0f2c8a11';

/**
 * The quorum rule: two of four failing is a `FAIL`.
 *
 * Two of the four are the real built-in verifiers, which run against the real
 * response for every call in this suite. The other two are third-party
 * verifiers, and they are here for two reasons: they let a test put the tally
 * at exactly one or exactly two failures without hand-crafting a response that
 * happens to break two deterministic stages at once, and they are the seam the
 * architecture must leave open — a policy that counts a
 * verifier we do not operate, declared in data, with no change to settlement.
 */
export const EXTERNAL_VERIFIER_IDS = ['acme.oracle', 'globex.audit'] as const;

export function quorumDraft(
  toolId = TEST_TOOL_ID,
  id = 'search_web.default',
): Omit<DecisionPolicy, 'version'> {
  return {
    id,
    toolId,
    verifiers: [
      { verifierId: 'schema' },
      { verifierId: 'rules' },
      ...EXTERNAL_VERIFIER_IDS.map((verifierId) => ({ verifierId })),
    ],
    clauses: [
      {
        when: DecisionTrigger.FAILURES_AT_LEAST,
        count: 2,
        then: VerdictStatus.FAIL,
        label: '2 of the 4 checks disagreed with this response.',
      },
    ],
    otherwise: VerdictStatus.PASS,
  };
}

/** The deterministic checks the built-in verifiers run. */
export function checksPolicy(toolId = TEST_TOOL_ID): VerificationPolicy {
  return {
    id: 'search_web.checks',
    toolId,
    version: 1,
    schema: {
      type: 'object',
      required: ['results'],
      properties: {
        results: {
          type: 'array',
          items: {
            type: 'object',
            required: ['url'],
            properties: { url: { type: 'string' } },
          },
        },
      },
    },
    rules: [
      {
        id: 'min-results',
        type: VerificationRuleType.MIN_ARRAY_LENGTH,
        path: '$.results',
        min: 1,
        weight: 1,
      },
    ],
    passThreshold: 0.7,
    // Ignored by the aggregator: the lifecycle column decides whether a verdict
    // enforces, never the document. A policy that could declare itself active
    // would make the promote gate advisory — which is the thing
    // `policy-lifecycle.integration.spec.ts` asserts against a real row.
    mode: PolicyMode.ACTIVE,
  };
}

/** A response that satisfies both built-in verifiers. */
export const GOOD_RESPONSE = { results: [{ url: 'https://example.com/a' }] };

/** A response the schema verifier rejects: `url` is not a string. */
export const BAD_RESPONSE = { results: [{ url: 42 }] };

/** One third-party verifier's vote, for driving the tally. */
export function externalVote(verifierId: string, outcome: VerifierOutcome): VerifierResult {
  return {
    verifierId,
    outcome,
    code: outcome === VerifierOutcome.FAIL ? `${verifierId}_disagreed` : null,
    detail: null,
    score: null,
    costUsd: 0,
    stage: null,
  };
}
