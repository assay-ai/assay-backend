import { McpCallerKind, McpSession } from '@modules/mcp/ports/mcp-session.port';
import { SpendPolicyController } from '@modules/spend-policy/controllers/spend-policy.controller';
import { SpendPolicyService } from '@modules/spend-policy/services/spend-policy.service';
import { AccessEpochService } from '@modules/toolset/services/access-epoch.service';
import { HumanSessionGuard, SESSION_REQUEST_KEY } from '@shared/auth';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ExecutionContext } from '@nestjs/common';

/** BUG-BUY-CONNECT-05: the route hands the service who is asking and what was asked, as is. */
describe('SpendPolicyController.get', () => {
  const OTHER = '6f1c2d3e-4b5a-4c6d-8e7f-901234567890';

  function build() {
    const getForRequest = jest.fn(async () => ({}));
    const controller = new SpendPolicyController(
      { getForRequest } as unknown as SpendPolicyService,
      { bump: jest.fn() } as unknown as AccessEpochService,
    );
    return { controller, getForRequest };
  }

  const session = (callerKind: McpCallerKind) =>
    ({ organizationId: 'org-1', agentId: 'agent-1', callerKind }) as unknown as McpSession;

  it('reads as a person for a HUMAN session', async () => {
    const { controller, getForRequest } = build();
    await controller.get(session(McpCallerKind.HUMAN), OTHER);
    expect(getForRequest).toHaveBeenCalledWith('org-1', 'agent-1', OTHER, true);
  });

  it('reads as an agent for an AGENT credential', async () => {
    const { controller, getForRequest } = build();
    await controller.get(session(McpCallerKind.AGENT), OTHER);
    expect(getForRequest).toHaveBeenCalledWith('org-1', 'agent-1', OTHER, false);
  });

  it('passes a repeated agentId through as the array it is, for the service to ignore', async () => {
    const { controller, getForRequest } = build();
    await controller.get(session(McpCallerKind.HUMAN), [OTHER, 'agent-1']);
    expect(getForRequest).toHaveBeenCalledWith('org-1', 'agent-1', [OTHER, 'agent-1'], true);
  });
});

/** BUG-BUY-CONNECT-05 part 2: "Use account default" is a person's decision. */
describe('SpendPolicyController.dropAgentPolicy', () => {
  const AGENT = '6f1c2d3e-4b5a-4c6d-8e7f-901234567890';

  it('is behind HumanSessionGuard, which refuses an agent credential', () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      SpendPolicyController.prototype.dropAgentPolicy,
    ) as unknown[];
    expect(guards).toContain(HumanSessionGuard);

    const contextOf = (callerKind: McpCallerKind) =>
      ({
        switchToHttp: () => ({
          getRequest: () => ({ [SESSION_REQUEST_KEY]: { callerKind } }),
        }),
      }) as unknown as ExecutionContext;
    expect(() => new HumanSessionGuard().canActivate(contextOf(McpCallerKind.AGENT))).toThrow(
      expect.objectContaining({ errorCode: 'AUTH_HUMAN_SESSION_REQUIRED' }),
    );
    expect(new HumanSessionGuard().canActivate(contextOf(McpCallerKind.HUMAN))).toBe(true);
  });

  it("drops the agent's policy as the person and bumps the access epoch", async () => {
    const dropAgentPolicy = jest.fn(async () => ({ scope: 'ORGANIZATION' }));
    const bump = jest.fn();
    const controller = new SpendPolicyController(
      { dropAgentPolicy } as unknown as SpendPolicyService,
      { bump } as unknown as AccessEpochService,
    );
    const session = {
      organizationId: 'org-1',
      agentId: 'agent-1',
      credentialId: 'login-1',
      callerKind: McpCallerKind.HUMAN,
    } as unknown as McpSession;

    await expect(controller.dropAgentPolicy(session, AGENT)).resolves.toEqual({
      scope: 'ORGANIZATION',
    });
    expect(dropAgentPolicy).toHaveBeenCalledWith('org-1', AGENT, { type: 'user', id: 'login-1' });
    expect(bump).toHaveBeenCalledWith('org-1');
  });
});
