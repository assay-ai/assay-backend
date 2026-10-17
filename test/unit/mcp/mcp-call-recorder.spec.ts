import { ToolCallRecordWriter } from '@modules/free-tier/services/tool-call-record-writer.service';
import { McpErrors } from '@modules/mcp/errors/mcp.errors';
import {
  McpCallRecorder,
  REPEAT_ALERT_THRESHOLD,
} from '@modules/mcp/services/mcp-call-recorder.service';
import { NotificationEvent } from '@modules/notification/ports/notification.port';
import { ToolAccessErrors } from '@modules/tool/errors/tool-access.errors';
import { ToolErrors } from '@modules/tool/errors/tool.errors';
import { RefusalLayer } from '@modules/toolset/domain/attribution';
import { CacheService } from '@shared/cache/redis-cache/cache.service';

import { SESSION } from './helpers/mcp-harness';

/** The refused-call row (FR-16), and the owner's alert when one repeats (§7.10). */
describe('McpCallRecorder', () => {
  function build() {
    const writes: Array<Record<string, unknown>> = [];
    const notified: Array<Record<string, unknown>> = [];
    const counters = new Map<string, number>();
    const recorder = new McpCallRecorder(
      {
        writeRefusal: async (input: Record<string, unknown>) => void writes.push(input),
      } as unknown as ToolCallRecordWriter,
      undefined,
      { mcpPublicUrl: 'https://mcp.example.com', webAppUrl: 'https://app.example.com' },
      {
        getRedisClient: () => ({
          incr: async (key: string) => {
            counters.set(key, (counters.get(key) ?? 0) + 1);
            return counters.get(key);
          },
          expire: async () => 1,
        }),
      } as unknown as CacheService,
      { notify: async (request: Record<string, unknown>) => void notified.push(request) } as never,
    );
    return { recorder, writes, notified };
  }

  it.each([
    [ToolAccessErrors.notInToolset(), RefusalLayer.SERVER],
    [ToolAccessErrors.notAllowed(), RefusalLayer.AGENT_LIMITS],
    [McpErrors.spendLimitExceeded({ limitType: 'daily' }), RefusalLayer.AGENT_LIMITS],
    [McpErrors.policyAgentPaused({}), RefusalLayer.AGENT_LIMITS],
    [ToolErrors.noEligibleBinding({ toolId: 't' }), RefusalLayer.SERVER],
    [
      ToolAccessErrors.noProviderMatchesRules({
        details: { providers: [{ source: 'TOOLSET' }] },
      }),
      RefusalLayer.TOOLSET_RULES,
    ],
    [
      ToolAccessErrors.noProviderMatchesRules({
        details: { providers: [{ source: 'TOOLSET' }, { source: 'AGENT' }] },
      }),
      RefusalLayer.AGENT_LIMITS,
    ],
  ])('records %s on its layer', async (error, layer) => {
    const { recorder, writes } = build();
    await recorder.recordRefusal(SESSION, undefined, 'get_weather', error, Date.now());
    expect(writes).toEqual([
      expect.objectContaining({ refusalCode: error.errorCode, refusalLayer: layer }),
    ]);
  });

  it('records nothing for an error that is not a refusal, or one an intent already recorded', async () => {
    const { recorder, writes } = build();
    await recorder.recordRefusal(SESSION, undefined, 't', new Error('boom'), Date.now());
    await recorder.recordRefusal(
      SESSION,
      undefined,
      't',
      ToolErrors.allBindingsFailed({ attempts: 2 }),
      Date.now(),
    );
    await recorder.recordRefusal(
      SESSION,
      undefined,
      't',
      ToolErrors.noEligibleBinding({ toolId: 't', intentId: 'intent-1' }),
      Date.now(),
    );
    expect(writes).toEqual([]);
  });

  it(`alerts the owner once, on the ${REPEAT_ALERT_THRESHOLD}th same refusal within an hour`, async () => {
    const { recorder, notified } = build();
    for (let n = 0; n < REPEAT_ALERT_THRESHOLD + 2; n += 1) {
      await recorder.recordRefusal(
        SESSION,
        undefined,
        'get_weather',
        ToolAccessErrors.notAllowed(),
        Date.now(),
      );
    }
    expect(notified).toEqual([
      expect.objectContaining({
        event: NotificationEvent.CALL_REFUSED_REPEATEDLY,
        organizationId: SESSION.organizationId,
        dedupeKey: `${SESSION.agentId}:get_weather:TOOL_NOT_ALLOWED`,
      }),
    ]);
  });
});
