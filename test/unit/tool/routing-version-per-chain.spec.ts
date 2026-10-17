import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { AccountId, AssetId, CHAIN_IDS } from '@modules/chains/ports/caip.types';
import { MinimumStakeParameters } from '@modules/tool/domain/routing';
import { ToolContractVersion, ToolTier, ToolVersionStatus } from '@modules/tool/ports/tool.types';
import { MoneyUtil } from '@utils/money.util';

import {
  MINIMUM_STAKE,
  PAYOUT_ACCOUNT,
  PAYOUT_CHAIN,
  ROUTING_CONTEXT,
  ScriptedInvoker,
  TOOL_ID,
  buildBinding,
  buildProvider,
  buildRouter,
  buildTool,
  ok,
  usdc,
} from './helpers/routing-fixtures';

/**
 * Review P2-1: a quote asks about every chain, but the contract version it
 * picks is the one the buyer's own chain can be served at.
 */
const MAINNET = CHAIN_IDS.SOLANA_MAINNET;
const MAINNET_USDC = ASSET_IDS.USDC_SOLANA_MAINNET as AssetId;
const MAINNET_PAYOUT = `${MAINNET}:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM` as AccountId;
const mainnetUsdc = (amount: string) => MoneyUtil.of(amount, MAINNET_USDC, 6);
const MAINNET_MINIMUM: MinimumStakeParameters = {
  floor: mainnetUsdc('50000000'),
  priceMultiple: 1000,
};

function v(major: number, version: number): ToolContractVersion {
  const tool = buildTool();
  return {
    version,
    semver: `${major}.0.0`,
    major,
    summary: 's',
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    optionalInputFields: [],
    optionalOutputFields: [],
    examples: [],
    verificationPolicyId: 'policy-default',
    tier: ToolTier.VERIFIED,
    status: ToolVersionStatus.ACTIVE,
    sunsetAt: null,
    changelog: null,
    publishedAt: null,
  };
}

describe('the quote picks its contract version for the buyer’s chain', () => {
  // v1 is served on devnet only, v2 (current) on mainnet only.
  const onDevnet = buildBinding('dev', { toolVersionRange: '^1' });
  const onMainnet = buildBinding('main', {
    toolVersionRange: '^2',
    assetId: MAINNET_USDC,
    priceAmount: '50000',
  });
  const { router } = buildRouter({
    tool: buildTool({ versions: [v(2, 2), v(1, 1)], currentVersion: 2 }),
    bindings: [onDevnet, onMainnet],
    providers: [
      buildProvider('dev'),
      buildProvider('main', { payoutAccountByChain: new Map([[MAINNET, MAINNET_PAYOUT]]) }),
    ],
    stakes: { dev: usdc(1000) },
    stakesByChain: { [`main|${MAINNET}`]: mainnetUsdc('1000000000') },
    config: {
      minimumStakeByChain: new Map([
        [PAYOUT_CHAIN, MINIMUM_STAKE],
        [MAINNET, MAINNET_MINIMUM],
      ]),
    },
    invoker: new ScriptedInvoker({
      [onDevnet.id]: async () => ok(),
      [onMainnet.id]: async () => ok(),
    }),
  });
  const everyChain = {
    ...ROUTING_CONTEXT,
    payerChains: [PAYOUT_CHAIN, MAINNET],
    enabledChains: [PAYOUT_CHAIN, MAINNET],
  };

  it('without a buyer chain, the current major (v2) is chosen', async () => {
    const quote = await router.quote(TOOL_ID, everyChain);
    expect(quote?.tool.version?.major).toBe(2);
  });

  it('for a devnet buyer, v1 — the version its chain can be served at', async () => {
    const quote = await router.quote(TOOL_ID, {
      ...everyChain,
      contract: { range: null, requireOutputFields: [], versionChains: [PAYOUT_CHAIN] },
    });
    expect(quote?.tool.version?.major).toBe(1);
    expect(quote?.settlementChains).toEqual([PAYOUT_CHAIN]);
    expect(PAYOUT_ACCOUNT).toBeDefined();
  });
});
