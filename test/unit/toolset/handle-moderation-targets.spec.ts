import { OrganizationEntity } from '@database/postgres/entities/organization.entity';
import { ToolsetErrorCode } from '@modules/toolset/errors/toolset.errors';
import { ToolsetModerationService } from '@modules/toolset/services/toolset-moderation.service';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';

const ORG = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';

/**
 * A rename or reassign of a handle is checked before it is queued for a
 * second operator (BUG-OPS-MARKET-02): a handle, or a target organization,
 * that does not exist is a 404, never an approval.
 */
describe('ToolsetModerationService.assertHandleTargetsExist', () => {
  function build(handles: Record<string, string>, organizations: string[]) {
    const lookedUp: string[] = [];
    const manager = {
      createQueryBuilder: () => {
        let wanted = '';
        const qb = {
          where: (_sql: string, params: { handle: string }) => {
            wanted = params.handle;
            lookedUp.push(wanted);
            return qb;
          },
          getOne: async () => (handles[wanted] ? { id: handles[wanted], handle: wanted } : null),
        };
        return qb;
      },
      exists: async (entity: unknown, options: { where: { id: string } }) =>
        entity === OrganizationEntity && organizations.includes(options.where.id),
    };
    const service = new ToolsetModerationService(
      {} as never,
      {} as never,
      {} as never,
      { manager } as never,
    );
    return { service, lookedUp };
  }

  it('passes a handle that exists, matched case-insensitively', async () => {
    const { service, lookedUp } = build({ acme: ORG }, []);
    await expect(service.assertHandleTargetsExist('ACME')).resolves.toBeUndefined();
    expect(lookedUp).toEqual(['acme']);
  });

  it('refuses a handle that does not exist with TOOLSET_HANDLE_NOT_FOUND', async () => {
    const { service } = build({ acme: ORG }, [OTHER]);
    await expectErrorCodeAsync(
      () => service.assertHandleTargetsExist('no-such-handle', OTHER),
      ToolsetErrorCode.TOOLSET_HANDLE_NOT_FOUND,
    );
  });

  it('refuses a reassign to an organization that does not exist with TOOLSET_ORGANIZATION_NOT_FOUND', async () => {
    const { service } = build({ acme: ORG }, []);
    await expectErrorCodeAsync(
      () => service.assertHandleTargetsExist('acme', OTHER),
      ToolsetErrorCode.TOOLSET_ORGANIZATION_NOT_FOUND,
    );
  });

  it('passes a reassign whose handle and organization both exist', async () => {
    const { service } = build({ acme: ORG }, [OTHER]);
    await expect(service.assertHandleTargetsExist('acme', OTHER)).resolves.toBeUndefined();
  });
});

/**
 * Review M2: the approved (and the direct-approver) write answers the same 404
 * as the pre-queue check when the receiving organization is gone.
 */
describe('ToolsetModerationService.reassignHandle, unknown organization', () => {
  it('answers TOOLSET_ORGANIZATION_NOT_FOUND, not the reassign refusal', async () => {
    const manager = {
      query: async () => [],
      createQueryBuilder: () => {
        const qb = {
          where: () => qb,
          getOne: async () => ({ id: ORG, handle: 'acme', handleStatus: 'FROZEN' }),
        };
        return qb;
      },
      findOne: async () => null,
    };
    const service = new ToolsetModerationService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expectErrorCodeAsync(
      () => service.reassignHandle(manager as never, 'acme', OTHER),
      ToolsetErrorCode.TOOLSET_ORGANIZATION_NOT_FOUND,
    );
  });
});
