import { EntityManager } from 'typeorm';

import { VerificationPolicyEntity } from '@database/postgres/entities/verification-policy.entity';
import { VerificationPolicyRepository } from '@database/postgres/repositories/verification-policy.repository';
import { PolicyLifecycle, defaultDecisionPolicy } from '@modules/verification/domain/aggregation';
import { KillScope } from '@modules/verification/domain/lifecycle/kill-switch';
import { VerificationErrorCode } from '@modules/verification/errors/verification.errors';
import { PolicyKillSwitchPort } from '@modules/verification/ports/policy-kill-switch.port';
import { DecisionPolicyService } from '@modules/verification/services/decision-policy.service';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';

/**
 * The lifecycle methods take the caller's transaction (the operator override
 * log's): every read and write goes through its manager, so a change commits
 * or rolls back with the register entry.
 */
const TX = { tx: true } as unknown as EntityManager;

class FakePolicies {
  readonly rows: Partial<VerificationPolicyEntity>[] = [];
  /** Which manager each call ran through (`null`: the default connection). */
  readonly managers: (EntityManager | null)[] = [];

  on(manager?: EntityManager) {
    this.managers.push(manager ?? null);
    return {
      findOne: async ({ where }: { where: Partial<VerificationPolicyEntity> }) =>
        this.rows.find((row) =>
          Object.entries(where).every(([k, v]) => (row as Record<string, unknown>)[k] === v),
        ) ?? null,
      save: async (entity: VerificationPolicyEntity) => {
        this.rows.push({ ...entity });
        return entity;
      },
    };
  }

  async findVersion(policyId: string, policyVersion: number, manager?: EntityManager) {
    this.managers.push(manager ?? null);
    return (this.rows.find(
      (row) => row.policyId === policyId && row.policyVersion === policyVersion,
    ) ?? null) as VerificationPolicyEntity | null;
  }

  async latestVersion(policyId: string, manager?: EntityManager) {
    this.managers.push(manager ?? null);
    return this.rows
      .filter((row) => row.policyId === policyId)
      .reduce((max, row) => Math.max(max, row.policyVersion ?? 0), 0);
  }

  async transitionIfInLifecycle(
    policyId: string,
    policyVersion: number,
    from: string,
    to: string,
    patch: Partial<VerificationPolicyEntity> = {},
    manager?: EntityManager,
  ) {
    this.managers.push(manager ?? null);
    const row = this.rows.find(
      (r) => r.policyId === policyId && r.policyVersion === policyVersion && r.lifecycle === from,
    );
    if (!row) return 0;
    Object.assign(row, patch, { lifecycle: to });
    return 1;
  }
}

function build() {
  const store = new FakePolicies();
  const events: string[] = [];
  const killSwitch = {
    isKilled: () => null,
    kill: async (target: { policyId: string; version: number }, reason: string, actor: string) => {
      events.push(`kill ${target.policyId}@${target.version}`);
      return {
        key: `policy:${target.policyId}@${target.version}`,
        scope: KillScope.POLICY_VERSION,
        policyId: target.policyId,
        version: target.version,
        reason,
        actor,
        killedAt: new Date(0).toISOString(),
      };
    },
  } as unknown as PolicyKillSwitchPort;
  const service = new DecisionPolicyService(
    store as unknown as VerificationPolicyRepository,
    killSwitch,
  );
  return { store, service, events };
}

describe('DecisionPolicyService with a transaction manager', () => {
  it('registers through the manager and archives the previous SHADOW version there', async () => {
    const { store, service } = build();
    store.rows.push({
      policyId: 'get_x.default',
      policyVersion: 1,
      toolId: 't1',
      lifecycle: 'SHADOW',
    });

    const registered = await service.register(
      {
        draft: defaultDecisionPolicy({ id: 'get_x.default', toolId: 't1', withRules: false }),
        createdBy: 'op-1',
        startIn: PolicyLifecycle.SHADOW,
      },
      TX,
    );

    expect(registered.version).toBe(2);
    expect(store.rows.map((row) => [row.policyVersion, row.lifecycle])).toEqual([
      [1, 'ARCHIVED'],
      [2, 'SHADOW'],
    ]);
    expect(store.managers.every((manager) => manager === TX)).toBe(true);
  });

  it('promotes through the manager', async () => {
    const { store, service } = build();
    store.rows.push({ policyId: 'p', policyVersion: 1, toolId: 't1', lifecycle: 'SHADOW' });
    await service.promote(
      'p',
      1,
      {
        shadowCalls: 500,
        labelledSamples: 100,
        falsePositives: 1,
        requestedBy: 'op-1',
        approvedBy: 'op-2',
      },
      TX,
    );
    expect(store.rows[0]).toMatchObject({ lifecycle: 'ACTIVE', promotedBy: 'op-2' });
    expect(store.rows[0].promotionEvidence).toMatchObject({ falsePositiveRate: 0.01 });
    expect(store.managers.every((manager) => manager === TX)).toBe(true);
  });

  it('withdraws: the kill switch first, then the row through the manager', async () => {
    const { store, service, events } = build();
    store.rows.push({ policyId: 'p', policyVersion: 3, toolId: 't1', lifecycle: 'ACTIVE' });
    const record = await service.withdraw('p', 3, 'Strikes honest providers.', 'op-1', TX);
    expect(events).toEqual(['kill p@3']);
    expect(record.policyId).toBe('p');
    expect(store.rows[0]).toMatchObject({
      lifecycle: 'WITHDRAWN',
      withdrawnBy: 'op-1',
      withdrawnReason: 'Strikes honest providers.',
    });
    expect(store.managers.every((manager) => manager === TX)).toBe(true);
  });

  it('reports a withdrawal whose row was already moved, inside a transaction', async () => {
    const { store, service, events } = build();
    store.rows.push({ policyId: 'p', policyVersion: 3, toolId: 't1', lifecycle: 'ARCHIVED' });
    await expectErrorCodeAsync(
      () => service.withdraw('p', 3, 'Strikes honest providers.', 'op-1', TX),
      VerificationErrorCode.VERIFICATION_POLICY_TRANSITION_LOST,
    );
    // The switch stays engaged: the failure mode to prefer.
    expect(events).toEqual(['kill p@3']);
  });
});
