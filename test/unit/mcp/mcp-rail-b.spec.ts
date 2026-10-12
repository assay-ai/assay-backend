import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { AccountId, CHAIN_IDS } from '@modules/chains/ports/caip.types';
import { Voucher } from '@modules/chains/ports/x402.types';
import {
  X402_ERROR,
  X402_PAYMENT_REQUIRED,
  X402_RAIL,
  X402_RECEIPT,
  X402_VOUCHER,
} from '@modules/mcp/constants/mcp.constants';
import { McpCallerKind, McpSession } from '@modules/mcp/ports/mcp-session.port';
import {
  McpFailureCode,
  VoucherRequirement,
  chooseRail,
} from '@modules/mcp/services/mcp-tool-call.service';
import { VOUCHER_MAX_TTL_SECONDS } from '@modules/payment/constants/voucher.constants';
import { computeRequestHash } from '@modules/payment/domain/request-hash';
import { PaymentErrorCode } from '@modules/payment/errors/payment.errors';
import { PaymentIntentStatus, PaymentRail } from '@modules/payment/ports/payment.types';

import {
  PAYOUT_ACCOUNT,
  ScriptedInvoker,
  buildBinding,
  buildProvider,
  ok,
  usdc,
} from '../tool/helpers/routing-fixtures';
import { CHAIN_ID, SESSION, buildMcpHarness, fakeVoucherSignature } from './helpers/mcp-harness';

/**
 * Rail B over MCP — a paid call settled by a voucher the BUYER signs.
 *
 * `eip155:46630` offers rail B only, so until this existed a paid MCP call on
 * that chain had no path at all: rail A was refused by design and nothing ever
 * called `VoucherService.redeem`. The shape is x402's 402 handshake carried in
 * MCP `_meta`:
 *
 * ```text
 *  tools/call                       → isError, x402/paymentRequired {provider, payTo, seq, requestHash…}
 *  tools/call + _meta[x402/voucher] → the call, paid by that voucher
 * ```
 *
 * `VoucherService` is the REAL class here (see the harness), so every binding
 * check it makes runs as in production; only the signature primitive is faked.
 */
const AGENT: AccountId = `${CHAIN_ID}:Agent1111111111111111111111111111111111111` as AccountId;
const RAIL_B_SESSION: McpSession = { ...SESSION, agentAccount: AGENT };
const ARGS = { query: 'moon landing' };
const TOOL_NAME = 'Search the web';
const RESOURCE = `/mcp/tools/${TOOL_NAME}`;
const PRICE = usdc('0.05');

function harness(options: { balance?: ReturnType<typeof usdc>; twoProviders?: boolean } = {}) {
  const ids = options.twoProviders ? ['provider-a', 'provider-b'] : ['provider-a'];
  const invoker = new ScriptedInvoker(
    Object.fromEntries(ids.map((id) => [`binding-${id}`, async () => ok('forty-two')])),
  );
  const built = buildMcpHarness({
    bindings: ids.map((id) => buildBinding(id)),
    providers: ids.map((id) => buildProvider(id)),
    invoker,
    balance: options.balance,
  });
  return { ...built, invoker };
}

/** What a wallet would sign, built from the requirement alone — as an x402 client must. */
function voucherFor(requirement: VoucherRequirement, overrides: Partial<Voucher> = {}): Voucher {
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
    ...overrides,
  };
}

function paying(requirement: VoucherRequirement, voucher = voucherFor(requirement)) {
  return {
    rail: null,
    voucher: {
      signed: { voucher, signature: fakeVoucherSignature(voucher.payer) },
      providerId: requirement.providerId,
    },
  };
}

async function requirementOf(h: ReturnType<typeof harness>): Promise<VoucherRequirement> {
  const outcome = await h.calls.call(RAIL_B_SESSION, TOOL_NAME, ARGS, {
    rail: PaymentRail.RAIL_B_VOUCHER,
    voucher: null,
  });
  if (outcome.kind !== 'ERROR') throw new Error('expected a payment requirement');
  return outcome.detail.paymentRequired as VoucherRequirement;
}

describe('rail B over MCP', () => {
  describe('the requirement — what the buyer must sign', () => {
    it('answers an unpaid rail-B call with PAYMENT_REQUIRED and everything a voucher binds', async () => {
      const h = harness();

      const outcome = await h.calls.call(RAIL_B_SESSION, TOOL_NAME, ARGS, {
        rail: PaymentRail.RAIL_B_VOUCHER,
        voucher: null,
      });

      expect(outcome).toMatchObject({
        kind: 'ERROR',
        code: McpFailureCode.PAYMENT_REQUIRED,
        retryable: true,
        intentId: null,
      });
      const requirement = (outcome as { detail: Record<string, unknown> }).detail
        .paymentRequired as VoucherRequirement;
      expect(requirement).toEqual({
        rail: 'B',
        scheme: 'voucher',
        network: CHAIN_ID,
        payer: AGENT,
        // The fake escrow reader's escrow is the account itself.
        payTo: AGENT,
        provider: PAYOUT_ACCOUNT,
        providerId: 'provider-a',
        amount: { amount: PRICE.amount, asset: PRICE.asset, decimals: 6 },
        resource: RESOURCE,
        requestHash: computeRequestHash({
          method: 'POST',
          path: RESOURCE,
          query: null,
          body: ARGS,
          toolId: 'search_web',
          providerId: 'provider-a',
          amount: PRICE.amount,
          asset: PRICE.asset,
        }),
        seq: '1',
        maxTimeoutSeconds: VOUCHER_MAX_TTL_SECONDS,
      });
    });

    it('costs nothing: no intent, no hold, no provider dialled, no spend-policy charge', async () => {
      const h = harness();

      await requirementOf(h);

      expect(h.intents.rows.size).toBe(0);
      expect(h.ledger.events).toHaveLength(0);
      expect(h.invoker.invocations).toHaveLength(0);
      expect(h.spendPolicy.checked).toHaveLength(0);
    });

    it('never offers a seq the chain has already passed', async () => {
      // Lean v3 admits `seq > seq_high` and nothing else. A buyer who redeemed
      // outside this database (or a database restored from backup) would
      // otherwise be handed a number the chain refuses AFTER the call was
      // served — at the platform's cost.
      const h = harness();
      h.escrow.withdrawRequested = 0n;
      h.escrow.seqHigh = 7n;

      const requirement = await requirementOf(h);

      expect(requirement.seq).toBe('8');
    });
  });

  describe('the paid retry — the voucher spends', () => {
    it('serves the call on rail B, holding exactly the voucher amount', async () => {
      const h = harness();
      const requirement = await requirementOf(h);

      const outcome = await h.calls.call(RAIL_B_SESSION, TOOL_NAME, ARGS, paying(requirement));

      expect(outcome.kind).toBe('RESULT');
      const intent = h.intents.only;
      expect(intent).toMatchObject({
        rail: PaymentRail.RAIL_B_VOUCHER,
        status: PaymentIntentStatus.VERIFYING,
        providerId: 'provider-a',
        providerAccount: PAYOUT_ACCOUNT,
        voucherSeq: requirement.seq,
        requestHash: requirement.requestHash,
        voucherResourceHash: `resource-hash:${RESOURCE}`,
      });
      expect(h.ledger.events[0]).toMatchObject({ kind: 'HOLD_CREATE', money: PRICE });
      expect(h.invoker.providerIds).toEqual(['provider-a']);
    });

    it('records which agent credential paid, and none for a config session (U02)', async () => {
      const h = harness();
      const agentSession: McpSession = {
        ...RAIL_B_SESSION,
        callerKind: McpCallerKind.AGENT,
        credentialId: '0f5e7c2a-8d3b-4c1e-9a6f-2b7d4e8c1a90',
      };
      const requirement = await (async () => {
        const outcome = await h.calls.call(agentSession, TOOL_NAME, ARGS, {
          rail: PaymentRail.RAIL_B_VOUCHER,
          voucher: null,
        });
        if (outcome.kind !== 'ERROR') throw new Error('expected a payment requirement');
        return outcome.detail.paymentRequired as VoucherRequirement;
      })();
      await h.calls.call(agentSession, TOOL_NAME, ARGS, paying(requirement));
      expect(h.intents.only.credentialId).toBe('0f5e7c2a-8d3b-4c1e-9a6f-2b7d4e8c1a90');

      const config = harness();
      await config.calls.call(RAIL_B_SESSION, TOOL_NAME, ARGS, paying(await requirementOf(config)));
      expect(config.intents.only.credentialId ?? null).toBeNull();
    });

    it('is still a charge the spend policy sees, against the voucher request hash', async () => {
      const h = harness();
      const requirement = await requirementOf(h);

      await h.calls.call(RAIL_B_SESSION, TOOL_NAME, ARGS, paying(requirement));

      expect(h.spendPolicy.checked).toEqual([
        { toolId: 'search_web', requestHash: requirement.requestHash },
      ]);
    });

    it('is served by the provider the voucher names, never another', async () => {
      const h = harness({ twoProviders: true });
      const requirement: VoucherRequirement = {
        ...(await requirementOf(h)),
        providerId: 'provider-b',
        requestHash: computeRequestHash({
          method: 'POST',
          path: RESOURCE,
          query: null,
          body: ARGS,
          toolId: 'search_web',
          providerId: 'provider-b',
          amount: PRICE.amount,
          asset: PRICE.asset,
        }),
      };

      await h.calls.call(RAIL_B_SESSION, TOOL_NAME, ARGS, paying(requirement));

      expect(h.invoker.providerIds).toEqual(['provider-b']);
      expect(h.intents.only.providerId).toBe('provider-b');
    });

    it('refuses a voucher whose amount is not the price, before any provider is dialled', async () => {
      const h = harness();
      const requirement = await requirementOf(h);
      const cheap = voucherFor(requirement, {
        amount: { ...requirement.amount, amount: '1' },
      });

      await expect(
        h.calls.call(RAIL_B_SESSION, TOOL_NAME, ARGS, paying(requirement, cheap)),
      ).rejects.toMatchObject({ errorCode: PaymentErrorCode.PAYMENT_VOUCHER_BINDING_MISMATCH });
      expect(h.invoker.invocations).toHaveLength(0);
      expect(h.ledger.events).toHaveLength(0);
    });

    /**
     * REGRESSION (BUG-D1-03): the escrow's own per-voucher limit binds at
     * redemption; a call above it was served and then refused on chain.
     */
    it('refuses a voucher above the escrow’s own per-voucher limit, before any provider is dialled', async () => {
      const h = harness();
      h.escrow.withdrawRequested = 0n;
      h.escrow.maxVoucherAmount = BigInt(PRICE.amount) - 1n;
      const requirement = await requirementOf(h);

      await expect(
        h.calls.call(RAIL_B_SESSION, TOOL_NAME, ARGS, paying(requirement)),
      ).rejects.toMatchObject({
        errorCode: PaymentErrorCode.PAYMENT_VOUCHER_ESCROW_LIMIT_EXCEEDED,
      });
      expect(h.invoker.invocations).toHaveLength(0);
      expect(h.ledger.events).toHaveLength(0);
    });

    it('refuses a voucher for different arguments', async () => {
      const h = harness();
      const requirement = await requirementOf(h);

      await expect(
        h.calls.call(RAIL_B_SESSION, TOOL_NAME, { query: 'something dearer' }, paying(requirement)),
      ).rejects.toMatchObject({ errorCode: PaymentErrorCode.PAYMENT_REQUEST_HASH_MISMATCH });
      expect(h.invoker.invocations).toHaveLength(0);
    });

    it('refuses a voucher somebody else signed', async () => {
      const h = harness();
      const requirement = await requirementOf(h);
      const voucher = voucherFor(requirement);

      await expect(
        h.calls.call(RAIL_B_SESSION, TOOL_NAME, ARGS, {
          rail: null,
          voucher: {
            signed: { voucher, signature: fakeVoucherSignature(PAYOUT_ACCOUNT) },
            providerId: requirement.providerId,
          },
        }),
      ).rejects.toMatchObject({ errorCode: PaymentErrorCode.PAYMENT_VOUCHER_SIGNATURE_INVALID });
      expect(h.invoker.invocations).toHaveLength(0);
    });

    it('answers PAYMENT_INSUFFICIENT_FUNDS without dialling when the balance cannot hold it', async () => {
      const h = harness({ balance: usdc('0.01') });
      const requirement = await requirementOf(h);

      const outcome = await h.calls.call(RAIL_B_SESSION, TOOL_NAME, ARGS, paying(requirement));

      expect(outcome).toMatchObject({
        kind: 'ERROR',
        code: McpFailureCode.PAYMENT_INSUFFICIENT_FUNDS,
      });
      expect(h.invoker.invocations).toHaveLength(0);
    });
  });

  describe('chooseRail — which rail a call takes', () => {
    it('takes rail B on a chain that offers nothing else', () => {
      expect(chooseRail(CHAIN_IDS.ROBINHOOD_TESTNET, null, false)).toBe(PaymentRail.RAIL_B_VOUCHER);
    });

    it('keeps rail A as the default where it is offered, so existing agents are unchanged', () => {
      expect(chooseRail(CHAIN_IDS.SOLANA_DEVNET, null, false)).toBe(PaymentRail.RAIL_A_PER_CALL);
    });

    it('takes rail B whenever a voucher is presented, or the agent asks for it', () => {
      expect(chooseRail(CHAIN_IDS.SOLANA_DEVNET, null, true)).toBe(PaymentRail.RAIL_B_VOUCHER);
      expect(chooseRail(CHAIN_IDS.SOLANA_DEVNET, PaymentRail.RAIL_B_VOUCHER, false)).toBe(
        PaymentRail.RAIL_B_VOUCHER,
      );
    });
  });

  describe('on the wire, through the reference MCP client', () => {
    async function connect() {
      const h = harness();
      const server = h.servers.create(RAIL_B_SESSION);
      const client = new Client({ name: 'test-agent', version: '0.0.0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      return { ...h, client };
    }

    /**
     * REGRESSION (BUG-D1-07 review, finding 4): the admission pause while the
     * payer tightens its caps is retryable — nothing was charged and the seq is
     * not spent — but the MCP error said `retryable: false`, so an agent gave
     * up the task every time its payer edited a cap.
     */
    it('marks PAYMENT_VOUCHER_ADMISSION_PAUSED retryable, with a retryAfter hint', async () => {
      const { client, intents, escrow } = await connect();
      escrow.withdrawRequested = 0n;
      const refused = (await client.callTool({
        name: TOOL_NAME,
        arguments: ARGS,
        _meta: { [X402_RAIL]: 'B' },
      })) as CallToolResult;
      const requirement = refused._meta?.[X402_PAYMENT_REQUIRED] as VoucherRequirement;
      intents.pausedFor = 7;

      const paused = (await client.callTool({
        name: TOOL_NAME,
        arguments: ARGS,
        _meta: {
          [X402_VOUCHER]: {
            voucher: voucherFor(requirement),
            signature: fakeVoucherSignature(requirement.payer),
            providerId: requirement.providerId,
          },
        },
      })) as CallToolResult;

      expect(paused.isError).toBe(true);
      expect(paused._meta?.[X402_ERROR]).toMatchObject({
        code: PaymentErrorCode.PAYMENT_VOUCHER_ADMISSION_PAUSED,
        retryable: true,
        retryAfter: 7,
      });
    });

    it('carries the requirement in _meta[x402/paymentRequired] and takes the voucher back in _meta', async () => {
      const { client, intents } = await connect();

      const refused = (await client.callTool({
        name: TOOL_NAME,
        arguments: ARGS,
        _meta: { [X402_RAIL]: 'B' },
      })) as CallToolResult;

      expect(refused.isError).toBe(true);
      expect(refused._meta?.[X402_ERROR]).toMatchObject({
        code: McpFailureCode.PAYMENT_REQUIRED,
        retryable: true,
      });
      const requirement = refused._meta?.[X402_PAYMENT_REQUIRED] as VoucherRequirement;
      expect(requirement.seq).toBe('1');

      const voucher = voucherFor(requirement);
      const paid = (await client.callTool({
        name: TOOL_NAME,
        arguments: ARGS,
        _meta: {
          [X402_VOUCHER]: {
            voucher,
            signature: fakeVoucherSignature(voucher.payer),
            providerId: requirement.providerId,
          },
        },
      })) as CallToolResult;

      expect(paid.isError).toBeFalsy();
      expect(paid._meta?.[X402_RECEIPT]).toMatchObject({ status: PaymentIntentStatus.VERIFYING });
      expect(intents.only.rail).toBe(PaymentRail.RAIL_B_VOUCHER);
    });

    it('refuses a malformed _meta[x402/voucher] as PAYMENT_VOUCHER_MALFORMED', async () => {
      const { client, invoker } = await connect();

      const refused = (await client.callTool({
        name: TOOL_NAME,
        arguments: ARGS,
        _meta: { [X402_VOUCHER]: { voucher: 'not-an-object' } },
      })) as CallToolResult;

      expect(refused.isError).toBe(true);
      expect(refused._meta?.[X402_ERROR]).toMatchObject({
        code: PaymentErrorCode.PAYMENT_VOUCHER_MALFORMED,
      });
      expect(invoker.invocations).toHaveLength(0);
    });
  });
});
