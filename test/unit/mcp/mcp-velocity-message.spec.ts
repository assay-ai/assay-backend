import { McpErrors } from '@modules/mcp/errors/mcp.errors';

// BUG-R3-J-02: a duplicate-request refusal read "Call rate exceeded the agent's
// velocity limit (DUPLICATE_REQUEST)", and the owner was sent to fix a spend
// limit that had room left.
describe('MCP_VELOCITY_LIMIT_EXCEEDED message names what was actually exceeded', () => {
  it('says a duplicate is a duplicate, not a rate or spend limit', () => {
    const error = McpErrors.velocityLimitExceeded({ reason: 'DUPLICATE_REQUEST', retryAfter: 8 });

    expect(error.message).toBe(
      'The same call (same tool, same arguments) was repeated too many times within one ' +
        'minute and was refused as a duplicate (DUPLICATE_REQUEST); no spend limit is used ' +
        'up and nothing was charged, retry after 8s',
    );
  });

  it('names the limit for the three real velocity limits', () => {
    expect(
      McpErrors.velocityLimitExceeded({ reason: 'CALLS_PER_MINUTE', retryAfter: 42 }).message,
    ).toBe(
      "The agent's calls-per-minute limit is used up (CALLS_PER_MINUTE); nothing was charged, retry after 42s",
    );
    expect(McpErrors.velocityLimitExceeded({ reason: 'CALLS_PER_HOUR' }).message).toBe(
      "The agent's calls-per-hour limit is used up (CALLS_PER_HOUR); nothing was charged",
    );
    expect(McpErrors.velocityLimitExceeded({ reason: 'SPEND_PER_HOUR' }).message).toBe(
      "The agent's spend-per-hour limit is used up (SPEND_PER_HOUR); nothing was charged",
    );
  });

  it('keeps a generic sentence for a reason it does not know', () => {
    expect(McpErrors.velocityLimitExceeded({ reason: 'UNAVAILABLE', retryAfter: 5 }).message).toBe(
      "Call rate exceeded the agent's velocity limit (UNAVAILABLE); nothing was charged, retry after 5s",
    );
  });
});
