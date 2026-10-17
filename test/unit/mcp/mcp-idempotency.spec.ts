import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { AccountId } from '@modules/chains/ports/caip.types';
import { Voucher } from '@modules/chains/ports/x402.types';
import {
  X402_ERROR,
  X402_IDEMPOTENCY_KEY,
  X402_RECEIPT,
  X402_REPLAYED,
} from '@modules/mcp/constants/mcp.constants';
import { McpErrorCode } from '@modules/mcp/errors/mcp.errors';
import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import {
  McpCallOutcome,
  McpFailureCode,
  McpPayment,
  VoucherRequirement,
} from '@modules/mcp/services/mcp-tool-call.service';
import { PaymentIntentStatus, PaymentRail } from '@modules/payment/ports/payment.types';
import { PricingMode } from '@modules/tool/ports/tool.types';
import { ProviderResponse } from '@modules/tool/domain/classification/classification.types';
import { MoneyUtil } from '@utils/money.util';

import { offerSolanaRailsInThisSuite } from '../helpers/solana-rail-b';
import {
  InvokerScript,
  ScriptedInvoker,
  buildBinding,
  buildProvider,
  buildTool,
  ok,
  status,
  usdc,
} from '../tool/helpers/routing-fixtures';
import { FakeIdempotencyRedis } from './helpers/fake-idempotency-redis';
import {
  CHAIN_ID,
  McpHarnessOptions,
  SESSION,
  buildMcpHarness,
  fakeVoucherSignature,
} from './helpers/mcp-harness';

/**
 * `_meta["x402/idempotency-key"]` on `tools/call` (G2.1): a client that
 * retries the same logical call is never charged twice, and gets the first
 * call's result back.
 *
 * The harness runs the real `McpToolCallService`, the real `VoucherService`
 * and the real `McpIdempotencyStore` over a fake Redis; `FakeIntents` models
 * the payment record's partial unique index on the key, so the cases that lose
 * the Redis record exercise the database backstop too.
 */
describe('McpToolCallService — idempotency keys', () => {
  offerSolanaRailsInThisSuite('A', 'B');

  const TOOL_NAME = 'Search the web';
  const ARGS = { query: 'moon landing' };
  const KEY = 'retry-key-0001';

  function harness(
    script: InvokerScript = () => Promise.resolve(ok('forty-two')),
    overrides: Partial<McpHarnessOptions> = {},
  ) {
    const invoker = new ScriptedInvoker({ 'binding-provider-a': script });
    const built = buildMcpHarness({
      bindings: [buildBinding('provider-a')],
      providers: [buildProvider('provider-a')],
      invoker,
      ...overrides,
    });
    return { ...built, invoker };
  }

  function keyed(
    h: ReturnType<typeof harness>,
    key: string | null = KEY,
    args: Record<string, unknown> = ARGS,
    session: McpSession = SESSION,
    payment?: McpPayment,
  ): Promise<McpCallOutcome> {
    return h.calls.call(session, TOOL_NAME, args as never, payment, key);
  }

  function holds(h: ReturnType<typeof harness>): number {
    return h.ledger.events.filter((event) => event.kind === 'HOLD_CREATE').length;
  }

  // ── Rail A ────────────────────────────────────────────────────────────────

  describe('rail A', () => {
    it('runs the first call, passes the key to the intent and stores the result without the arguments', async () => {
      const h = harness();

      const outcome = await keyed(h);

      expect(outcome).toMatchObject({ kind: 'RESULT', output: { answer: 'forty-two' } });
      expect(outcome.kind === 'RESULT' && outcome.replayed).toBeFalsy();
      expect(h.intents.only.idempotencyKey).toBe(KEY);
      expect(holds(h)).toBe(1);

      const [record] = h.idempotencyRedis.records;
      expect(record).toMatchObject({ state: 'DONE', toolId: h.intents.only.toolId });
      expect(record.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
      // The arguments are hashed, never stored; nor is the client's key.
      const raw = [...h.idempotencyRedis.strings.entries()].flat().join(' ');
      expect(raw).not.toContain('moon landing');
      expect(raw).not.toContain(KEY);
    });

    it('replays the stored result after the call settled, marked replayed, without a second charge', async () => {
      const h = harness();
      const first = await keyed(h);
      if (first.kind !== 'RESULT') throw new Error('expected a RESULT');

      // The verification worker settles the intent behind the agent.
      const intent = h.intents.only;
      await h.intents.resolve(
        SESSION.organizationId,
        intent.id,
        PaymentIntentStatus.VERIFYING,
        PaymentIntentStatus.SETTLED,
        { settledAmount: intent.price },
      );

      const replay = await keyed(h);

      expect(replay).toMatchObject({
        kind: 'RESULT',
        replayed: true,
        output: first.output,
        receipt: { intentId: intent.id, status: PaymentIntentStatus.SETTLED },
      });
      if (replay.kind !== 'RESULT') throw new Error('expected a RESULT');
      // The receipt is re-read: the call is charged now, and nothing is held.
      expect(replay.receipt.charged).toEqual(intent.price);
      expect(MoneyUtil.isZero(replay.receipt.held)).toBe(true);

      expect(h.invoker.invocations).toHaveLength(1);
      expect(h.intents.rows.size).toBe(1);
      expect(holds(h)).toBe(1);
      expect(h.spendPolicy.checked).toHaveLength(1);
    });

    it('answers IN_PROGRESS, retryable, while the first attempt is still running', async () => {
      let answer: (response: ProviderResponse) => void = () => undefined;
      const h = harness(() => new Promise<ProviderResponse>((resolve) => (answer = resolve)));

      const first = keyed(h);
      await waitFor(() => h.invoker.invocations.length === 1);

      const retry = await keyed(h);

      expect(retry).toMatchObject({
        kind: 'ERROR',
        code: McpFailureCode.IN_PROGRESS,
        retryable: true,
        detail: { retryAfterMs: expect.any(Number) },
      });
      expect(h.intents.rows.size).toBe(1);
      expect(holds(h)).toBe(1);

      answer(ok('forty-two'));
      await expect(first).resolves.toMatchObject({ kind: 'RESULT' });
      // Once it is done, the same key gets its result.
      await expect(keyed(h)).resolves.toMatchObject({ kind: 'RESULT', replayed: true });
      expect(h.invoker.invocations).toHaveLength(1);
    });

    it('refuses the same key with other arguments: IDEMPOTENCY_KEY_REUSED, nothing charged', async () => {
      const h = harness();
      await keyed(h);

      const reused = await keyed(h, KEY, { query: 'something else' });

      expect(reused).toMatchObject({
        kind: 'ERROR',
        code: McpFailureCode.IDEMPOTENCY_KEY_REUSED,
        retryable: false,
        detail: { reason: 'ARGUMENTS' },
      });
      expect(h.invoker.invocations).toHaveLength(1);
      expect(h.intents.rows.size).toBe(1);
      expect(holds(h)).toBe(1);
    });

    it('treats the same arguments in another key order as the same call', async () => {
      const h = harness();
      await keyed(h, KEY, { query: 'moon landing', limit: 3 });

      await expect(keyed(h, KEY, { limit: 3, query: 'moon landing' })).resolves.toMatchObject({
        kind: 'RESULT',
        replayed: true,
      });
    });

    it('refuses the same key on another tool: IDEMPOTENCY_KEY_REUSED, nothing charged', async () => {
      const redis = new FakeIdempotencyRedis();
      const search = harness(undefined, { idempotencyRedis: redis });
      const other = harness(undefined, {
        idempotencyRedis: redis,
        tool: buildTool({ id: 'tool-translate', name: 'Translate' }),
        bindings: [buildBinding('provider-a', { toolId: 'tool-translate' })],
      });
      await keyed(search);

      const reused = await other.calls.call(SESSION, 'Translate', ARGS, undefined, KEY);

      expect(reused).toMatchObject({
        kind: 'ERROR',
        code: McpFailureCode.IDEMPOTENCY_KEY_REUSED,
        detail: { reason: 'TOOL' },
      });
      expect(other.invoker.invocations).toHaveLength(0);
      expect(other.intents.rows.size).toBe(0);
      expect(other.ledger.events).toHaveLength(0);
    });

    it('scopes the key per agent: another agent with the same key is another call', async () => {
      const redis = new FakeIdempotencyRedis();
      const h = harness(undefined, { idempotencyRedis: redis });
      await keyed(h);

      const otherAgent = await keyed(h, KEY, ARGS, { ...SESSION, agentId: 'agent-2' });

      expect(otherAgent).toMatchObject({ kind: 'RESULT' });
      expect(otherAgent.kind === 'RESULT' && otherAgent.replayed).toBeFalsy();
      expect(h.invoker.invocations).toHaveLength(2);
    });

    it('allows a fresh attempt after the first was voided with no charge', async () => {
      let calls = 0;
      const h = harness(() => Promise.resolve(++calls === 1 ? status(400) : ok('forty-two')));

      const voided = await keyed(h);
      expect(voided).toMatchObject({ kind: 'ERROR', code: McpFailureCode.PROVIDER_REQUEST_ERROR });
      expect(h.intents.only.status).toBe(PaymentIntentStatus.VOIDED);
      // Released, not stored: a failure that cost nothing is not replayed.
      expect(h.idempotencyRedis.strings.size).toBe(0);

      const retried = await keyed(h);

      expect(retried).toMatchObject({ kind: 'RESULT', output: { answer: 'forty-two' } });
      expect(retried.kind === 'RESULT' && retried.replayed).toBeFalsy();
      expect(h.invoker.invocations).toHaveLength(2);
      const rows = [...h.intents.rows.values()];
      expect(rows.map((row) => row.status)).toEqual([
        PaymentIntentStatus.VOIDED,
        PaymentIntentStatus.VERIFYING,
      ]);
      expect(rows.every((row) => row.idempotencyKey === KEY)).toBe(true);
    });

    it('expires an unaffordable keyed intent at once, so the retry after a top-up runs', async () => {
      const h = harness(undefined, { balance: usdc('0.001') });

      const refused = await keyed(h);
      expect(refused).toMatchObject({
        kind: 'ERROR',
        code: McpFailureCode.PAYMENT_INSUFFICIENT_FUNDS,
      });
      expect(h.intents.only.status).toBe(PaymentIntentStatus.EXPIRED);

      (h.ledger as unknown as { available: unknown }).available = usdc(100);
      await expect(keyed(h)).resolves.toMatchObject({ kind: 'RESULT' });
      expect(h.intents.rows.size).toBe(2);
    });

    it('without a key, two identical calls both run — no key is derived from the arguments', async () => {
      const h = harness();

      await keyed(h, null);
      await keyed(h, null);

      expect(h.invoker.invocations).toHaveLength(2);
      expect(h.intents.rows.size).toBe(2);
      expect([...h.intents.rows.values()].every((row) => row.idempotencyKey === null)).toBe(true);
      expect(h.idempotencyRedis.commands).toHaveLength(0);
    });

    it('when Redis lost the record, the payment index still refuses a second charge', async () => {
      const h = harness();
      const first = await keyed(h);
      if (first.kind !== 'RESULT') throw new Error('expected a RESULT');
      h.idempotencyRedis.flush();

      const retry = await keyed(h);

      expect(retry).toMatchObject({
        kind: 'ERROR',
        code: McpFailureCode.IDEMPOTENCY_RESULT_UNAVAILABLE,
        retryable: false,
        intentId: first.receipt.intentId,
      });
      expect(h.invoker.invocations).toHaveLength(1);
      expect(h.intents.rows.size).toBe(1);
      expect(holds(h)).toBe(1);
      // A failure that cost nothing: the record is released, not stored.
      expect(h.idempotencyRedis.strings.size).toBe(0);
    });

    it('when Redis lost the record of a call still running, the payment index answers IN_PROGRESS', async () => {
      let answer: (response: ProviderResponse) => void = () => undefined;
      const h = harness(() => new Promise<ProviderResponse>((resolve) => (answer = resolve)));
      const first = keyed(h);
      await waitFor(() => h.invoker.invocations.length === 1);
      h.idempotencyRedis.flush();

      const retry = await keyed(h);

      expect(retry).toMatchObject({
        kind: 'ERROR',
        code: McpFailureCode.IN_PROGRESS,
        retryable: true,
        intentId: h.intents.only.id,
      });
      expect(holds(h)).toBe(1);
      answer(ok());
      await first;
    });

    it('runs the call when Redis is down, the payment index still guarding the charge', async () => {
      const h = harness();
      h.idempotencyRedis.down = true;

      await expect(keyed(h)).resolves.toMatchObject({ kind: 'RESULT' });
      const retry = await keyed(h);

      expect(retry).toMatchObject({ code: McpFailureCode.IDEMPOTENCY_RESULT_UNAVAILABLE });
      expect(holds(h)).toBe(1);
    });
  });

  // ── Rail B ────────────────────────────────────────────────────────────────

  describe('rail B (voucher)', () => {
    const AGENT: AccountId = `${CHAIN_ID}:Agent1111111111111111111111111111111111111` as AccountId;
    const RAIL_B: McpSession = { ...SESSION, agentAccount: AGENT };
    const ASK: McpPayment = { rail: PaymentRail.RAIL_B_VOUCHER, voucher: null };

    function voucherFor(requirement: VoucherRequirement): Voucher {
      const now = Math.floor(Date.now() / 1000);
      return {
        payer: requirement.payer,
        payTo: requirement.payTo,
        provider: requirement.provider,
        amount: requirement.amount,
        resource: requirement.resource,
        requestHash: requirement.requestHash,
        seq: requirement.seq,
        issuedAt: now,
        expiresAt: now + 120,
      };
    }

    function paying(requirement: VoucherRequirement): McpPayment {
      const voucher = voucherFor(requirement);
      return {
        rail: null,
        voucher: {
          signed: { voucher, signature: fakeVoucherSignature(voucher.payer) },
          providerId: requirement.providerId,
        },
      };
    }

    async function requirementOf(
      h: ReturnType<typeof harness>,
      key: string | null,
    ): Promise<VoucherRequirement> {
      const outcome = await keyed(h, key, ARGS, RAIL_B, ASK);
      if (outcome.kind !== 'ERROR' || outcome.code !== McpFailureCode.PAYMENT_REQUIRED) {
        throw new Error('expected a payment requirement');
      }
      return outcome.detail.paymentRequired as VoucherRequirement;
    }

    it('keeps the two-step handshake on one key, and a retry with a NEW voucher is not charged', async () => {
      const h = harness();

      // Step one with the key: PAYMENT_REQUIRED charged nothing, so the key
      // is released for step two.
      const requirement = await requirementOf(h, KEY);
      expect(h.idempotencyRedis.strings.size).toBe(0);

      const paid = await keyed(h, KEY, ARGS, RAIL_B, paying(requirement));
      expect(paid).toMatchObject({ kind: 'RESULT', output: { answer: 'forty-two' } });
      expect(h.intents.only.idempotencyKey).toBe(KEY);
      expect(h.intents.only.voucherSeq).toBe(requirement.seq);

      // The client timed out, fetched a fresh requirement and signed a new
      // voucher for the same logical call.
      const second = await requirementOf(h, null);
      expect(second.seq).not.toBe(requirement.seq);
      const retry = await keyed(h, KEY, ARGS, RAIL_B, paying(second));

      expect(retry).toMatchObject({
        kind: 'RESULT',
        replayed: true,
        output: { answer: 'forty-two' },
      });
      // Short-circuited before `redeem`: no intent for the new seq, one hold.
      expect(h.intents.rows.size).toBe(1);
      expect([...h.intents.rows.values()].some((row) => row.voucherSeq === second.seq)).toBe(false);
      expect(holds(h)).toBe(1);
      expect(h.invoker.invocations).toHaveLength(1);
    });

    it('step one with a key whose call already completed replays it instead of a new requirement', async () => {
      const h = harness();
      const requirement = await requirementOf(h, KEY);
      await keyed(h, KEY, ARGS, RAIL_B, paying(requirement));

      await expect(keyed(h, KEY, ARGS, RAIL_B, ASK)).resolves.toMatchObject({
        kind: 'RESULT',
        replayed: true,
      });
      expect(h.seqs.allocated).toHaveLength(1);
    });

    it('when Redis lost the record, a new voucher is neither held nor redeemed', async () => {
      const h = harness();
      const requirement = await requirementOf(h, KEY);
      const paid = await keyed(h, KEY, ARGS, RAIL_B, paying(requirement));
      if (paid.kind !== 'RESULT') throw new Error('expected a RESULT');
      h.idempotencyRedis.flush();

      const second = await requirementOf(h, null);
      const retry = await keyed(h, KEY, ARGS, RAIL_B, paying(second));

      expect(retry).toMatchObject({
        kind: 'ERROR',
        code: McpFailureCode.IDEMPOTENCY_RESULT_UNAVAILABLE,
        intentId: paid.receipt.intentId,
      });
      expect(h.intents.rows.size).toBe(1);
      expect(holds(h)).toBe(1);
      expect(h.invoker.invocations).toHaveLength(1);
    });
  });

  // ── Free calls ────────────────────────────────────────────────────────────

  describe('free calls', () => {
    it('a replay takes no second free-quota place and dials nobody', async () => {
      const h = harness(undefined, {
        bindings: [
          buildBinding('provider-a', {
            pricingMode: PricingMode.FREE,
            priceAmount: '0',
            freeQuotaPerAgent: 100,
          }),
        ],
      });

      const first = await keyed(h);
      const replay = await keyed(h);

      expect(first).toMatchObject({ kind: 'RESULT' });
      expect(replay).toMatchObject({
        kind: 'RESULT',
        replayed: true,
        output: { answer: 'forty-two' },
      });
      expect(h.freeQuota.platformPlaces).toHaveLength(1);
      expect(h.freeQuota.places).toHaveLength(1);
      expect(h.freeQuota.checked).toHaveLength(1);
      expect(h.toolCallRecords.written).toHaveLength(1);
      expect(h.invoker.invocations).toHaveLength(1);
      expect(h.intents.rows.size).toBe(0);
    });
  });

  // ── The protocol surface ──────────────────────────────────────────────────

  describe('over MCP', () => {
    async function connected(h: ReturnType<typeof harness>) {
      const server = h.servers.create(SESSION);
      const client = new Client({ name: 'test-agent', version: '0.0.0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      return client;
    }

    it.each([
      ['an empty string', ''],
      ['a non-ASCII string', 'clé-0001'],
      ['a control character', 'key\n0001'],
      ['129 characters', 'k'.repeat(129)],
      ['a number', 42],
      ['an object', { key: 'x' }],
    ])(
      'refuses %s as a key with MCP_IDEMPOTENCY_KEY_INVALID and charges nothing',
      async (_, key) => {
        const h = harness();
        const client = await connected(h);

        const result = (await client.callTool({
          name: TOOL_NAME,
          arguments: ARGS,
          _meta: { [X402_IDEMPOTENCY_KEY]: key },
        })) as CallToolResult;

        expect(result.isError).toBe(true);
        expect(result._meta?.[X402_ERROR]).toMatchObject({
          code: McpErrorCode.MCP_IDEMPOTENCY_KEY_INVALID,
          retryable: false,
        });
        expect(h.invoker.invocations).toHaveLength(0);
        expect(h.intents.rows.size).toBe(0);
        expect(h.ledger.events).toHaveLength(0);
      },
    );

    it('accepts a 128-character printable key and marks only the replay with x402/replayed', async () => {
      const h = harness();
      const client = await connected(h);
      const key = '~ '.repeat(64);

      const call = async () =>
        (await client.callTool({
          name: TOOL_NAME,
          arguments: ARGS,
          _meta: { [X402_IDEMPOTENCY_KEY]: key },
        })) as CallToolResult;
      const first = await call();
      const replay = await call();

      expect(first.isError).toBeFalsy();
      expect(first._meta?.[X402_REPLAYED]).toBeUndefined();
      expect(replay._meta?.[X402_REPLAYED]).toBe(true);
      expect(replay.structuredContent).toEqual(first.structuredContent);
      expect((replay._meta?.[X402_RECEIPT] as { intentId: string }).intentId).toBe(
        (first._meta?.[X402_RECEIPT] as { intentId: string }).intentId,
      );
      expect(h.invoker.invocations).toHaveLength(1);
    });

    it('answers IDEMPOTENCY_KEY_REUSED as an isError result', async () => {
      const h = harness();
      const client = await connected(h);
      await client.callTool({
        name: TOOL_NAME,
        arguments: ARGS,
        _meta: { [X402_IDEMPOTENCY_KEY]: KEY },
      });

      const reused = (await client.callTool({
        name: TOOL_NAME,
        arguments: { query: 'other' },
        _meta: { [X402_IDEMPOTENCY_KEY]: KEY },
      })) as CallToolResult;

      expect(reused.isError).toBe(true);
      expect(reused._meta?.[X402_ERROR]).toMatchObject({
        code: McpFailureCode.IDEMPOTENCY_KEY_REUSED,
        retryable: false,
      });
    });
  });
});

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  if (!condition()) throw new Error('condition never became true');
}
