import { McpCallerKind, McpSession } from '@modules/mcp/ports/mcp-session.port';
import { SpendPolicyController } from '@modules/spend-policy/controllers/spend-policy.controller';
import { SpendPolicyService } from '@modules/spend-policy/services/spend-policy.service';

/** BUG-BUY-CONNECT-05: the route hands the service who is asking and what was asked, as is. */
describe('SpendPolicyController.get', () => {
  const OTHER = '6f1c2d3e-4b5a-4c6d-8e7f-901234567890';

  function build() {
    const getForRequest = jest.fn(async () => ({}));
    const controller = new SpendPolicyController({
      getForRequest,
    } as unknown as SpendPolicyService);
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
