import 'reflect-metadata';

import { OperatorApprovalsController } from '@modules/operator/controllers/operator-approvals.controller';
import { OperatorRole, OVERRIDE_REGISTER } from '@modules/operator/domain/override-register';
import { OperatorSession } from '@modules/operator/ports/operator-session.port';
import {
  OperatorApprovalService,
  payloadHash,
} from '@modules/operator/services/operator-approval.service';
import { REQUIRE_ROLES_METADATA } from '@shared/auth/require-roles.decorator';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';

/**
 * Who may approve or turn down a queued two-person action (BUG-OPS-CORE-01).
 *
 * `POLA` is the second person of the policy rows (`P-10`, `P-11`) and of
 * nothing else; the two-person rule and the ban on approving one's own request
 * hold for it like for everyone.
 */
const operator = (id: string, roles: OperatorRole[]): OperatorSession => ({
  operatorId: id,
  subject: `${id}@`,
  displayName: id,
  email: `${id}@example.test`,
  roles,
  authorityLimitMinor: null,
});
const POL = operator('op-pol', [OperatorRole.POL]);
const POLA = operator('op-pola', [OperatorRole.POLA]);
const POLA_2 = operator('op-pola-2', [OperatorRole.POLA]);
const LEAD = operator('op-adjl', [OperatorRole.ADJL]);
const SRE = operator('op-sre', [OperatorRole.SRE]);
const CMP = operator('op-cmp', [OperatorRole.CMP]);
const CMP_2 = operator('op-cmp-2', [OperatorRole.CMP]);

const PAYLOAD = { toolId: 'tool-1', version: 2 };

function build(rows: Record<string, { action: string; requestedBy: string }>) {
  const stored = new Map(
    Object.entries(rows).map(([id, row]) => [
      id,
      {
        id,
        ...row,
        target: 'tool-1',
        payload: PAYLOAD,
        payloadHash: payloadHash(PAYLOAD),
        status: 'PENDING',
        approvedBy: null,
        rejectedBy: null,
        createdAt: new Date(),
        decidedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      },
    ]),
  );
  const markRejected = jest.fn(async (id: string) => {
    const row = stored.get(id);
    if (row) row.status = 'REJECTED';
    return true;
  });
  const service = new OperatorApprovalService(
    {
      expireStale: async () => 0,
      findOneBy: async ({ id }: { id: string }) => stored.get(id) ?? null,
      markRejected,
    } as never,
    { findById: async () => null } as never,
    {
      requireActive: async (id: string) => ({ id }),
      sessionOf: (row: { id: string }) => operator(row.id, [OperatorRole.POL]),
    } as never,
  );
  const runs = {
    publish: jest.fn(async () => 'published'),
    unblock: jest.fn(async () => 'ok'),
    reassign: jest.fn(async () => 'reassigned'),
  };
  service.register('contract.publish', { code: 'P-10', run: runs.publish });
  service.register('account.unblock', { code: 'A-10', run: runs.unblock });
  service.register('handle.reassign', { code: 'A-22', run: runs.reassign });
  return { service, runs, markRejected };
}

describe('approvals — the policy approver (BUG-OPS-CORE-01)', () => {
  it('lets POLA approve a policy request someone else made', async () => {
    const { service, runs } = build({
      a1: { action: 'contract.publish', requestedBy: POL.operatorId },
    });

    await service.approve('a1', POLA, null);

    expect(runs.publish).toHaveBeenCalledWith(
      expect.objectContaining({ operatorId: POL.operatorId }),
      expect.objectContaining({ operatorId: POLA.operatorId, approvalId: 'a1' }),
      PAYLOAD,
      null,
    );
  });

  it('still refuses POLA approving its own policy request (no self-approval)', async () => {
    const { service, runs } = build({
      a1: { action: 'contract.publish', requestedBy: POLA.operatorId },
    });

    await expectErrorCodeAsync(
      () => service.approve('a1', POLA, null),
      'OPERATOR_SELF_APPROVAL_REFUSED',
    );
    expect(runs.publish).not.toHaveBeenCalled();
  });

  it('a second POLA may approve a POLA request (two different people)', async () => {
    const { service, runs } = build({
      a1: { action: 'contract.publish', requestedBy: POLA.operatorId },
    });

    await service.approve('a1', POLA_2, null);

    expect(runs.publish).toHaveBeenCalledTimes(1);
  });

  it('refuses POL (the author role) as the second person of a policy request', async () => {
    const { service, runs } = build({
      a1: { action: 'contract.publish', requestedBy: POLA.operatorId },
    });

    await expectErrorCodeAsync(
      () => service.approve('a1', POL, null),
      'OPERATOR_APPROVER_ROLE_REQUIRED',
    );
    expect(runs.publish).not.toHaveBeenCalled();
  });

  it('refuses POLA approving anything that is not a policy row', async () => {
    const { service, runs } = build({
      a1: { action: 'account.unblock', requestedBy: SRE.operatorId },
    });

    await expectErrorCodeAsync(
      () => service.approve('a1', POLA, null),
      'OPERATOR_APPROVER_ROLE_REQUIRED',
    );
    expect(runs.unblock).not.toHaveBeenCalled();
  });

  it('refuses a lead approving a policy row (only POLA is named)', async () => {
    const { service } = build({ a1: { action: 'contract.publish', requestedBy: POL.operatorId } });

    await expectErrorCodeAsync(
      () => service.approve('a1', LEAD, null),
      'OPERATOR_APPROVER_ROLE_REQUIRED',
    );
  });

  it('lets POL withdraw its own policy request', async () => {
    const { service, markRejected } = build({
      a1: { action: 'contract.publish', requestedBy: POL.operatorId },
    });

    await service.reject('a1', POL);

    expect(markRejected).toHaveBeenCalledWith('a1', POL.operatorId);
  });

  it('lets POLA turn down a policy request someone else made', async () => {
    const { service, markRejected } = build({
      a1: { action: 'contract.publish', requestedBy: POL.operatorId },
    });

    await service.reject('a1', POLA);

    expect(markRejected).toHaveBeenCalledWith('a1', POLA.operatorId);
  });

  it('refuses POL turning down someone else’s request, and POLA a non-policy one', async () => {
    const { service, markRejected } = build({
      a1: { action: 'contract.publish', requestedBy: POLA.operatorId },
      a2: { action: 'account.unblock', requestedBy: SRE.operatorId },
    });

    await expectErrorCodeAsync(() => service.reject('a1', POL), 'OPERATOR_APPROVER_ROLE_REQUIRED');
    await expectErrorCodeAsync(() => service.reject('a2', POLA), 'OPERATOR_APPROVER_ROLE_REQUIRED');
    expect(markRejected).not.toHaveBeenCalled();
  });

  it('falls back to the general approver roles, not to anyone, for a row naming none', async () => {
    const { service } = build({ b1: { action: 'calls.bulk', requestedBy: SRE.operatorId } });
    const run = jest.fn(async () => 'ok');
    // V-2 is two-person and names no approver roles (not implemented).
    service.register('calls.bulk', { code: 'V-2', run });

    await expectErrorCodeAsync(
      () => service.approve('b1', POLA, null),
      'OPERATOR_APPROVER_ROLE_REQUIRED',
    );
    expect(run).not.toHaveBeenCalled();
  });
});

describe('approvals routes admit every role a register row names as its approver', () => {
  const rolesOf = (method: keyof OperatorApprovalsController): OperatorRole[] =>
    Reflect.getMetadata(REQUIRE_ROLES_METADATA, OperatorApprovalsController.prototype[method]);

  const named = Object.values(OVERRIDE_REGISTER)
    .filter((row) => row.implemented)
    .flatMap((row) => row.approverRoles ?? []);

  it('approve: POLA is admitted, POL (an author, never an approver) is not', () => {
    expect(rolesOf('approve')).toContain(OperatorRole.POLA);
    expect(rolesOf('approve')).not.toContain(OperatorRole.POL);
  });

  it('reject: POL (to withdraw its own) and POLA are admitted', () => {
    expect(rolesOf('reject')).toEqual(
      expect.arrayContaining([OperatorRole.POL, OperatorRole.POLA]),
    );
  });

  it.each(['P-10', 'P-11'])('%s: every approver role passes both route guards', (code) => {
    for (const role of OVERRIDE_REGISTER[code].approverRoles ?? []) {
      expect(rolesOf('approve')).toContain(role);
      expect(rolesOf('reject')).toContain(role);
    }
  });

  it('every named approver role passes both route guards (CMP for A-22 included)', () => {
    const roles = [...new Set(named)];
    expect(roles).toContain(OperatorRole.CMP);
    expect(roles.filter((role) => !rolesOf('approve').includes(role))).toEqual([]);
    expect(roles.filter((role) => !rolesOf('reject').includes(role))).toEqual([]);
  });

  it('CMP is named as an approver on A-22 only', () => {
    const rows = Object.values(OVERRIDE_REGISTER)
      .filter((row) => row.approverRoles?.includes(OperatorRole.CMP))
      .map((row) => row.code);
    expect(rows).toEqual(['A-22']);
  });
});

describe('approvals — CMP on A-22 (handle reassignment, lot 1 C10)', () => {
  it('lets CMP approve an A-22 request someone else made', async () => {
    const { service, runs } = build({
      h1: { action: 'handle.reassign', requestedBy: LEAD.operatorId },
    });

    await service.approve('h1', CMP, 'req-1');

    expect(runs.reassign).toHaveBeenCalledTimes(1);
    const [, approver] = runs.reassign.mock.calls[0] as unknown as [
      unknown,
      { operatorId: string },
    ];
    expect(approver.operatorId).toBe(CMP.operatorId);
  });

  it('refuses CMP approving its own A-22 request (self-approval), and runs nothing', async () => {
    const { service, runs } = build({
      h1: { action: 'handle.reassign', requestedBy: CMP.operatorId },
    });

    await expectErrorCodeAsync(
      () => service.approve('h1', CMP, null),
      'OPERATOR_SELF_APPROVAL_REFUSED',
    );
    expect(runs.reassign).not.toHaveBeenCalled();
  });

  it('two-person: a second CMP (another person) approves a CMP request', async () => {
    const { service, runs } = build({
      h1: { action: 'handle.reassign', requestedBy: CMP.operatorId },
    });

    await service.approve('h1', CMP_2, null);

    expect(runs.reassign).toHaveBeenCalledTimes(1);
  });

  it('refuses CMP approving anything but A-22', async () => {
    const { service, runs } = build({
      a1: { action: 'account.unblock', requestedBy: SRE.operatorId },
      p1: { action: 'contract.publish', requestedBy: POL.operatorId },
    });

    await expectErrorCodeAsync(
      () => service.approve('a1', CMP, null),
      'OPERATOR_APPROVER_ROLE_REQUIRED',
    );
    await expectErrorCodeAsync(
      () => service.approve('p1', CMP, null),
      'OPERATOR_APPROVER_ROLE_REQUIRED',
    );
    expect(runs.unblock).not.toHaveBeenCalled();
    expect(runs.publish).not.toHaveBeenCalled();
  });

  it('lets CMP turn down an A-22 request, and withdraw its own', async () => {
    const { service, markRejected } = build({
      h1: { action: 'handle.reassign', requestedBy: LEAD.operatorId },
      h2: { action: 'handle.reassign', requestedBy: CMP.operatorId },
    });

    await service.reject('h1', CMP);
    await service.reject('h2', CMP);

    expect(markRejected).toHaveBeenCalledWith('h1', CMP.operatorId);
    expect(markRejected).toHaveBeenCalledWith('h2', CMP.operatorId);
  });

  it('refuses CMP turning down someone else’s non-A-22 request', async () => {
    const { service, markRejected } = build({
      a1: { action: 'account.unblock', requestedBy: SRE.operatorId },
    });

    await expectErrorCodeAsync(() => service.reject('a1', CMP), 'OPERATOR_APPROVER_ROLE_REQUIRED');
    expect(markRejected).not.toHaveBeenCalled();
  });

  it('a row naming no approver roles never falls back to CMP', async () => {
    const { service } = build({ b1: { action: 'calls.bulk', requestedBy: SRE.operatorId } });
    const run = jest.fn(async () => 'ok');
    service.register('calls.bulk', { code: 'V-2', run });

    await expectErrorCodeAsync(
      () => service.approve('b1', CMP, null),
      'OPERATOR_APPROVER_ROLE_REQUIRED',
    );
    expect(run).not.toHaveBeenCalled();
  });
});
