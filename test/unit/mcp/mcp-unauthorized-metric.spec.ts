import { McpController } from '@modules/mcp/controllers/mcp.controller';
import { McpErrors } from '@modules/mcp/errors/mcp.errors';
import { McpSessionPort } from '@modules/mcp/ports/mcp-session.port';
import {
  McpUnauthorizedReason,
  McpUnauthorizedRecorder,
} from '@modules/mcp/ports/mcp-unauthorized.port';
import { AllExceptionsFilter } from '@shared/filters/all-exceptions.filter';

/**
 * `assay_mcp_unauthorized_total{reason}` (spec §6.7): the MCP catch-all
 * counts each 401 by the reason the session source carried out privately,
 * and the 401 the client sees is the same whatever the reason.
 */
describe('the MCP catch-all counts its 401s by reason', () => {
  const HOST = { mcpPublicUrl: 'https://mcp.example.com', webAppUrl: 'https://app.example.com' };

  function controller(error: Error, recorded: McpUnauthorizedReason[]): McpController {
    const sessions: McpSessionPort = { resolve: () => Promise.reject(error) } as McpSessionPort;
    const recorder: McpUnauthorizedRecorder = { record: (reason) => recorded.push(reason) };
    return new McpController(
      sessions,
      { create: jest.fn() } as never,
      { resolve: jest.fn() } as never,
      { resolve: jest.fn() } as never,
      HOST,
      recorder,
    );
  }

  function call(authorization?: string) {
    const headers: Record<string, string> = {};
    const response = { setHeader: (name: string, value: string) => (headers[name] = value) };
    const request = {
      method: 'POST',
      originalUrl: '/',
      headers: authorization ? { authorization, accept: 'application/json' } : {},
    };
    return { request: request as never, response: response as never, headers };
  }

  it.each([
    ['no token', undefined, McpErrors.credentialInvalid(), 'missing'],
    ['an unrecognised token', 'Bearer x', McpErrors.credentialInvalid(), 'unknown'],
    [
      'a revoked access token',
      'Bearer assay_at_x',
      McpErrors.credentialInvalid({ unauthorizedReason: 'revoked' }),
      'revoked',
    ],
    [
      'an access token for another audience',
      'Bearer assay_at_x',
      McpErrors.credentialInvalid({ unauthorizedReason: 'audience' }),
      'audience',
    ],
  ] as const)('%s → %s', async (_label, authorization, error, reason) => {
    const recorded: McpUnauthorizedReason[] = [];
    const { request, response, headers } = call(authorization);
    await expect(controller(error, recorded).handle(request, response)).rejects.toBe(error);
    expect(recorded).toEqual([reason]);
    expect(headers['WWW-Authenticate']).toContain('resource_metadata=');
  });

  it('an identified refusal is not a 401 and is not counted', async () => {
    const recorded: McpUnauthorizedReason[] = [];
    const { request, response } = call('Bearer assay_sk_live_x');
    const error = new Error('outage');
    await expect(controller(error, recorded).handle(request, response)).rejects.toBe(error);
    expect(recorded).toEqual([]);
  });

  it('the reason never reaches the 401 body', () => {
    const filter = new AllExceptionsFilter();
    const bodies: unknown[] = [];
    for (const error of [
      McpErrors.credentialInvalid(),
      McpErrors.credentialInvalid({ unauthorizedReason: 'expired' }),
    ]) {
      const response = {
        headersSent: false,
        status: () => response,
        json: (body: { error: { timestamp?: string } }) => {
          delete body.error.timestamp;
          bodies.push(body);
        },
      };
      filter.catch(error, {
        getType: () => 'http',
        switchToHttp: () => ({
          getRequest: () => ({ method: 'POST', originalUrl: '/' }),
          getResponse: () => response,
        }),
      } as never);
    }
    expect(bodies[1]).toEqual(bodies[0]);
    expect(JSON.stringify(bodies[1])).not.toContain('expired');
  });
});
