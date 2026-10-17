import { AccountId, AssetId, CHAIN_IDS } from '@modules/chains/ports/caip.types';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { FreeQuotaService } from '@modules/free-tier/services/free-quota.service';
import { ToolCallRecordWriter } from '@modules/free-tier/services/tool-call-record-writer.service';
import { McpScope } from '@modules/mcp/ports/mcp-scope';
import { McpCallerKind, McpSession } from '@modules/mcp/ports/mcp-session.port';
import { McpCatalogueService } from '@modules/mcp/services/mcp-catalogue.service';
import {
  DEFAULT_MCP_IDEMPOTENCY_CONFIG,
  McpIdempotencyStore,
} from '@modules/mcp/services/mcp-idempotency.store';
import { McpToolCallService } from '@modules/mcp/services/mcp-tool-call.service';
import { PaymentRail } from '@modules/payment/ports/payment.types';
import { stakeKey } from '@modules/provider/ports/provider-stake.port';
import { SpendPolicyEnforcementService } from '@modules/spend-policy/services/spend-policy-enforcement.service';
import { OnEmpty, ProviderMode, RuleRejectionReason } from '@modules/tool/domain/routing';
import { ToolAccessErrorCode } from '@modules/tool/errors/tool-access.errors';
import { BindingCallCounterService } from '@modules/tool/services/binding-call-counter.service';
import { InMemoryToolCatalogue } from '@modules/tool/services/in-memory-tool-catalogue';
import { ALLOW_ALL } from '@modules/toolset/domain/access';
import { attributionOf } from '@modules/toolset/domain/attribution';
import { EndpointKind, McpPathKind, parseMcpUrl } from '@modules/toolset/domain/mcp-url';
import { McpEndpointView } from '@modules/toolset/domain/view';
import { VerificationSettlementService } from '@modules/verification/services/verification-settlement.service';
import { MoneyUtil } from '@shared/utils/money.util';

import { offerSolanaRailBInThisSuite } from '../../unit/helpers/solana-rail-b';
import {
  FakeBindingCallCounter,
  FakeEscrowReader,
  FakeFreeQuota,
  FakeSettlement,
  FakeSpendPolicy,
  FakeToolCallRecords,
} from '../../unit/mcp/helpers/mcp-harness';
import {
  ScriptedInvoker,
  TOOL_ID,
  buildBinding,
  buildProvider,
  buildRouter,
  buildTool,
  ok,
} from '../../unit/tool/helpers/routing-fixtures';
import {
  VOUCHER_PROVIDER,
  VoucherTestContext,
  createVoucherTestContext,
} from '../helpers/voucher-test-context';

const MAINNET = CHAIN_IDS.SOLANA_MAINNET;
const USDC: AssetId = ASSET_IDS.USDC_SOLANA_MAINNET;
const usdc = (atomic: string) => MoneyUtil.of(atomic, USDC, 6);
const P2_ACCOUNT = `${MAINNET}:3Kz9zpH8Hn7c9DqWQ5HvMXDKfo8FZe1pKUbRCMoMS5wq` as AccountId;

/**
 * Rail B under a toolset entry's rules, against the real payment database
 * (design spec §7.3): the entry is ONLY [p1] with FALLBACK_BEST and p1 is
 * eligible, so nothing falls back — a voucher that pays p2 is refused as
 * `PAYEE_NO_LONGER_ELIGIBLE` before it is redeemed: no intent, no hold, its
 * seq never spent, and nobody dialled.
 */
describe('rail B, a voucher for a payee the rules drop', () => {
  offerSolanaRailBInThisSuite();

  let context: VoucherTestContext;

  // One tenant for the file: the PAYMENT_REQUIRED case allocates a seq, and
  // `reset()` re-seeds `next_seq` below it, which the database refuses.
  beforeAll(async () => {
    context = await createVoucherTestContext();
    await context.reset();
  }, 120_000);
  afterAll(async () => context?.close());

  function build() {
    const tool = buildTool();
    const bindings = ['p1', 'p2'].map((providerId) =>
      buildBinding(providerId, {
        assetId: USDC,
        settlementChains: [MAINNET],
        priceAmount: '50000',
      }),
    );
    const invoker = new ScriptedInvoker({
      'binding-p1': async () => ok(),
      'binding-p2': async () => ok(),
    });
    const { router } = buildRouter({
      tool,
      bindings,
      providers: [
        buildProvider('p1', { payoutAccountByChain: new Map([[MAINNET, VOUCHER_PROVIDER]]) }),
        buildProvider('p2', { payoutAccountByChain: new Map([[MAINNET, P2_ACCOUNT]]) }),
      ],
      stakes: {},
      stakesByChain: {
        [stakeKey('p1', MAINNET)]: usdc('1000000000'),
        [stakeKey('p2', MAINNET)]: usdc('1000000000'),
      },
      invoker,
      config: {
        minimumStakeByChain: new Map([
          [MAINNET, { floor: usdc('50000000'), priceMultiple: 1000 }],
        ]) as never,
      },
    });
    const freeQuota = new FakeFreeQuota() as unknown as FreeQuotaService;
    const catalogue = new McpCatalogueService(
      new InMemoryToolCatalogue({ tools: [tool], bindings }),
      router,
      freeQuota,
      [MAINNET],
    );
    const calls = new McpToolCallService(
      catalogue,
      router,
      context.intents,
      context.ledger,
      new FakeSettlement() as unknown as VerificationSettlementService,
      new FakeBindingCallCounter() as unknown as BindingCallCounterService,
      new FakeSpendPolicy() as unknown as SpendPolicyEnforcementService,
      freeQuota,
      new FakeToolCallRecords() as unknown as ToolCallRecordWriter,
      context.vouchers,
      context.seqs,
      new FakeEscrowReader(),
      { platformFeeBps: 1_000 },
      [MAINNET],
      new McpIdempotencyStore(context.redis as never, DEFAULT_MCP_IDEMPOTENCY_CONFIG),
      DEFAULT_MCP_IDEMPOTENCY_CONFIG,
      { findByIntentId: async () => null } as never,
    );
    return { calls, invoker };
  }

  function scope(): McpScope {
    const parsed = parseMcpUrl('/my/research')!;
    const view: McpEndpointView = {
      canonicalUrl: 'https://mcp.example.com/my/research',
      path: { kind: McpPathKind.MY_TOOLSET, slug: 'research', version: null },
      kind: EndpointKind.TOOLSET,
      filter: parsed.filter,
      toolset: {
        id: '1d2c3b4a-5e6f-4a70-8b91-a2b3c4d5e6f7',
        slug: 'research',
        name: 'Research',
        version: null,
        latest: false,
      },
      handle: null,
      settings: { discovery: 'AUTO', searchThreshold: 25, pinnedTools: [] },
      notice: null,
      baseToolIds: [TOOL_ID],
      entryRules: new Map([
        [
          TOOL_ID,
          {
            mode: ProviderMode.ONLY,
            providerIds: ['p1'],
            minTier: null,
            maxPrice: null,
            minQuality: null,
            onEmpty: OnEmpty.FALLBACK_BEST,
          },
        ],
      ]),
    };
    return {
      view,
      access: {
        agentId: 'agent',
        agent: ALLOW_ALL,
        key: null,
        rules: null,
        pinnedTools: [],
        policyVersion: null,
      },
      attribution: attributionOf(view),
    };
  }

  const session = (): McpSession => ({
    credentialId: 'cred-rail-b',
    organizationId: context.organizationId,
    agentId: context.id('rail-b-rules:agent'),
    agentAccount: context.payer,
    chainId: MAINNET,
    label: null,
    callerKind: McpCallerKind.AGENT,
  });

  it('offers only p1, the entry’s provider, and never falls back', async () => {
    const { calls } = build();
    const outcome = await calls.call(
      session(),
      'Search the web',
      { query: 'Paris' },
      {
        rail: PaymentRail.RAIL_B_VOUCHER,
        voucher: null,
      },
      scope(),
    );
    expect(outcome).toMatchObject({
      kind: 'ERROR',
      code: 'PAYMENT_REQUIRED',
      detail: { paymentRequired: { providerId: 'p1', provider: VOUCHER_PROVIDER } },
    });
  });

  it('refuses a voucher for p2 as PAYEE_NO_LONGER_ELIGIBLE, leaving it unredeemed', async () => {
    const { calls, invoker } = build();
    const { signed } = context.voucherFor();
    const held = await context.held(context.payer);

    const refusal = await calls
      .call(
        session(),
        'Search the web',
        { query: 'Paris' },
        {
          rail: PaymentRail.RAIL_B_VOUCHER,
          voucher: { signed, providerId: 'p2' },
        },
        scope(),
      )
      .catch((error: unknown) => error);

    expect(refusal).toMatchObject({ errorCode: ToolAccessErrorCode.NO_PROVIDER_MATCHES_RULES });
    expect(
      (refusal as { context: { details: { providers: Array<Record<string, unknown>> } } }).context
        .details.providers,
    ).toEqual([
      expect.objectContaining({
        providerId: 'p2',
        reason: RuleRejectionReason.PAYEE_NO_LONGER_ELIGIBLE,
        rule: RuleRejectionReason.NOT_IN_ALLOWED_PROVIDERS,
      }),
    ]);

    const [{ count }] = await context.dataSource.query(
      `SELECT count(*)::int AS count FROM payment_intents WHERE organization_id = $1`,
      [context.organizationId],
    );
    expect(count).toBe(0);
    expect(
      await context.intents.isVoucherSeqUsed(
        context.organizationId,
        context.payer,
        String(signed.voucher.seq),
      ),
    ).toBe(false);
    expect(await context.held(context.payer)).toBe(held);
    expect(invoker.invocations).toHaveLength(0);
  });
});
