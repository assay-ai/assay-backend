import { randomUUID } from 'crypto';

import { pad, toHex } from 'viem';

import { EvmVaultClient, EvmVaultService } from '@modules/chains/evm/evm-vault.service';
import { createSanctionedEvmClient } from '@modules/chains/evm/sanctioned-evm-rpc';
import { EvmDeployment, MULTICALL3_ADDRESS } from '@modules/chains/evm/evm.constants';
import { buildNamespaceVaultPort } from '@modules/chains/multiplex/namespace-vault.port';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { AccountId, CHAIN_IDS, ChainId, toAccountId } from '@modules/chains/ports/caip.types';
import { VaultPort } from '@modules/chains/ports/vault.port';
import { LedgerAccountId, LedgerEntryType } from '@modules/ledger/ports/ledger.types';
import {
  ReconciliationFindingCode,
  ReconciliationSeverity,
} from '@modules/settlement/ports/reconciliation.types';
import { EgressHttpClient, EgressRequest, EgressResponse } from '@shared/network/egress';
import { MoneyUtil } from '@shared/utils/money.util';

import {
  SettlementTestContext,
  USDC_ASSET,
  USDC_DECIMALS,
  createSettlementTestContext,
} from '../helpers/settlement-test-context';

const EVM_CHAIN = CHAIN_IDS.ROBINHOOD_TESTNET;
const USDG = ASSET_IDS.USDG_ROBINHOOD_TESTNET;
const USDG_DECIMALS = 6;

const ESCROW_PROXY = '0x3333333333333333333333333333333333333333';
const CONFIG_PROXY = '0x1111111111111111111111111111111111111111';
const ESCROW_IMPLEMENTATION = '0x8888888888888888888888888888888888888888';
const ADMIN = '0x9999999999999999999999999999999999999999';
const OWNER = '0x7777777777777777777777777777777777777777';
const OTHER_IMPLEMENTATION = '0x00000000000000000000000000000000DeaDBeef';

const DEPLOYMENT: EvmDeployment = {
  chainId: EVM_CHAIN,
  config: CONFIG_PROXY,
  stake: '0x2222222222222222222222222222222222222222',
  escrow: ESCROW_PROXY,
  asset: '0x7E99c98e066032b2Ef5768ff18Ed090e1aB921ac',
  escrowImplementation: ESCROW_IMPLEMENTATION,
  admin: ADMIN,
  owner: OWNER,
};

const BUYER = toAccountId(EVM_CHAIN, '0x5B38Da6a701c568545dCfcB03FcB875f56beddC4');
const SOLANA_VAULT: AccountId = toAccountId(
  CHAIN_IDS.SOLANA_MAINNET,
  'Vau1t1111111111111111111111111111111111111',
);
const BLOCK = 116_313_808n;

const SELECTOR = {
  admin: '0xf851a440',
  owner: '0x8da5cb5b',
  ASSET: '0x4800d97f',
  balanceOf: '0x70a08231',
} as const;

/** The mutable chain a test sets up before it reconciles. */
const evmRpc = {
  implementation: ESCROW_IMPLEMENTATION as string,
  escrowBalance: 0n,
  throwOnRequest: null as Error | null,
};

function evmClient(): EvmVaultClient {
  const egress = {
    async request(request: EgressRequest): Promise<EgressResponse> {
      if (evmRpc.throwOnRequest) throw evmRpc.throwOnRequest;
      const { id, method, params } = JSON.parse(String(request.body)) as {
        id: number;
        method: string;
        params?: readonly unknown[];
      };

      const answer = (): string => {
        if (method === 'eth_blockNumber') return toHex(BLOCK);
        if (method === 'eth_getStorageAt') {
          return pad(evmRpc.implementation as `0x${string}`, { size: 32 });
        }
        if (method === 'eth_call') {
          const selector = (params?.[0] as { data: string }).data.slice(0, 10);
          if (selector === SELECTOR.admin) return pad(ADMIN, { size: 32 });
          if (selector === SELECTOR.owner) return pad(OWNER, { size: 32 });
          if (selector === SELECTOR.ASSET) return pad(DEPLOYMENT.asset, { size: 32 });
          if (selector === SELECTOR.balanceOf) return toHex(evmRpc.escrowBalance, { size: 32 });
          // `pendingOwner()`: no transfer proposed (assertVaultControl warns on one).
          if (selector === '0xe30c3978') return pad('0x', { size: 32 });
        }
        throw new Error(`unexpected JSON-RPC ${method}`);
      };

      return {
        status: 200,
        headers: {},
        body: JSON.stringify({ jsonrpc: '2.0', id, result: answer() }),
        bytes: 0,
        url: request.url,
        redirects: 0,
      };
    },
  } as unknown as EgressHttpClient;

  return createSanctionedEvmClient('https://rpc.testnet.chain.robinhood.example', egress, {
    id: 46630,
    name: 'eip155:46630',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [] } },
    contracts: { multicall3: { address: MULTICALL3_ADDRESS } },
  }) as unknown as EvmVaultClient;
}

/**
 * The Solana half, faked at the port.
 *
 * Only test 3 reads it, and all it has to be is *a chain that is fine* — the
 * assertion is that a breach on 46630 leaves it alone, which a real Squads
 * derivation would add nothing to.
 */
const solanaVault: VaultPort = {
  getVaultOwner: () => Promise.resolve(SOLANA_VAULT),
  getVaultAccount: () => Promise.resolve(SOLANA_VAULT),
  getVaultBalance: () => Promise.resolve(MoneyUtil.of(0n, USDC_ASSET, USDC_DECIMALS)),
  getVaultBalanceAt: () =>
    Promise.resolve({ balance: MoneyUtil.of(0n, USDC_ASSET, USDC_DECIMALS), slot: 1n }),
  assertVaultControl: () => Promise.resolve(),
};

/**
 * `ReconciliationService` on `eip155:46630`.
 *
 * **Integration, not unit, and the reason is measured:** three maker/checker
 * defects survived 2,850 green tests because the unit harness is an in-memory
 * `Map` where CHECK constraints do not exist.
 * Everything below writes a real `reconciliation_runs` row through the real
 * repository, over the real ledger schema.
 *
 * The vault is the **real** `NamespaceVaultPort` in front of the **real**
 * `EvmVaultService`, whose only fake is the JSON-RPC transport. So this suite
 * exercises the dispatch, the control proof, the block-anchored balance read
 * and the persisted row as one thing — which is what "the reconciler runs on
 * 46630 without a structural change" has to mean if it is to be proved rather
 * than asserted.
 */
describe('ReconciliationService on eip155:46630', () => {
  let context: SettlementTestContext;

  const fundUsdg = async (account: AccountId, atomic: bigint): Promise<void> => {
    await context.ledger.appendNow({
      organizationId: context.organizationId,
      accountId: account as unknown as LedgerAccountId,
      entryType: LedgerEntryType.DEPOSIT,
      money: MoneyUtil.of(atomic, USDG, USDG_DECIMALS),
    });
  };

  beforeAll(async () => {
    context = await createSettlementTestContext({
      // Its own database: this suite and the Solana one both truncate every
      // table in `reset()`, and sharing would make each one's isolation depend
      // on jest staying single-worker.
      database: `${process.env.DATABASE_NAME || 'app'}_settlement_evm_test`,
      vault: buildNamespaceVaultPort({
        enabled: [CHAIN_IDS.SOLANA_MAINNET as ChainId, EVM_CHAIN],
        solana: solanaVault,
        evm: new EvmVaultService(
          new Map<ChainId, EvmVaultClient>([[EVM_CHAIN, evmClient()]]),
          new Map([[EVM_CHAIN, DEPLOYMENT]]),
        ),
      }),
    });
  }, 120_000);

  afterAll(async () => {
    await context?.close();
  });

  beforeEach(async () => {
    await context.reset();
    evmRpc.implementation = ESCROW_IMPLEMENTATION;
    evmRpc.escrowBalance = 0n;
    evmRpc.throwOnRequest = null;
  });

  it('writes a reconciliation_runs row naming the ESCROW PROXY as the vault', async () => {
    await fundUsdg(BUYER, 12_500_000n);
    evmRpc.escrowBalance = 12_500_000n;

    const report = await context.reconciliation.reconcile(USDG);
    const row = await context.runs.findLatest(USDG);

    expect(report.severity).toBe(ReconciliationSeverity.OK);
    expect(row).not.toBeNull();
    // The proxy, not a derived account and not the token: on EVM the pool and
    // its owner are one address.
    expect(row!.vaultAccount).toBe(`${EVM_CHAIN}:${ESCROW_PROXY}`);
    // A BLOCK number in a column called `vault_slot`, written as the decimal
    // string the `numeric` column stores.
    expect(row!.vaultSlot).toBe(BLOCK.toString());
    expect(row!.vaultBalance).toBe('12500000');
  });

  it('reports CRITICAL, and does NOT throw, when the chain holds less than the journal owes', async () => {
    await fundUsdg(BUYER, 20_000_000n); // journal says 20 USDG
    evmRpc.escrowBalance = 5_000_000n; // chain says 5

    const report = await context.reconciliation.reconcile(USDG);

    expect(report.severity).toBe(ReconciliationSeverity.CRITICAL);
    expect(report.findings.map((f) => f.code)).toContain(ReconciliationFindingCode.RESERVES_BREACH);
    // The row must exist even though the pass found a breach: it is the
    // artefact an incident is reconstructed from, and a throw would abort
    // BEFORE it is written.
    expect(await context.runs.findLatest(USDG)).not.toBeNull();
    await expect(context.reconciliation.isFrozen(USDG)).resolves.toBe(true);
  });

  it('does not count what a redemption already paid out of the escrow as owed by it', async () => {
    // A buyer deposits 20 USDG. Two 0.10 calls are served on rail B: one
    // voucher is redeemed (the escrow pays 0.09 to the provider and 0.01 to the
    // treasury, so it holds 19.90); the other can never be redeemed, the buyer
    // keeps the money and the platform owes the provider 0.09.
    const PROVIDER = toAccountId(EVM_CHAIN, '0xfB18f483E985F21c58fD97F69DE225aECA5Fc1c4');
    const providerOrg = randomUUID();
    const usdg = (atomic: bigint) => MoneyUtil.of(atomic, USDG, USDG_DECIMALS);
    // No `payment_intents` in this harness's schema: the ledger keys on the id only.
    const intent = async (): Promise<string> => randomUUID();

    await fundUsdg(BUYER, 20_000_000n);
    const hold = async (intentId: string) =>
      context.ledger.createHold({
        organizationId: context.organizationId,
        accountId: BUYER as unknown as LedgerAccountId,
        money: usdg(100_000n),
        intentId,
      });

    const redeemed = await intent();
    const redeemedHold = await hold(redeemed);
    await context.ledger.commitHoldAndCredit(context.organizationId, redeemedHold.id, {
      providerOrganizationId: providerOrg,
      providerAccountId: PROVIDER as unknown as LedgerAccountId,
      providerAmount: usdg(90_000n),
      platformFee: usdg(10_000n),
      intentId: redeemed,
      chainTxRef: `0x${'ab'.repeat(32)}`,
    });

    const absorbed = await intent();
    const absorbedHold = await hold(absorbed);
    await context.ledger.appendNow({
      organizationId: providerOrg,
      accountId: PROVIDER as unknown as LedgerAccountId,
      entryType: LedgerEntryType.PROVIDER_CREDIT,
      money: usdg(90_000n),
      intentId: absorbed,
      chainTxRef: 'platform_absorbed:DelegateIsRevoked',
    });
    await context.ledger.releaseHold(context.organizationId, absorbedHold.id);

    evmRpc.escrowBalance = 19_900_000n;
    const report = await context.reconciliation.reconcile(USDG);

    expect(report.agentLiabilitiesAtomic).toBe(19_900_000n);
    // Only the absorbed credit: the redeemed one is in the provider's wallet.
    expect(report.providerPayableAtomic).toBe(90_000n);
    expect(report.platformFeesAtomic).toBe(0n);
    expect(report.differenceAtomic).toBe(-90_000n);
    // The snapshot still agrees with the journal's own fold.
    expect(report.findings.map((f) => f.code)).toEqual([ReconciliationFindingCode.RESERVES_BREACH]);
  });

  it('freezes withdrawals on 46630 and LEAVES SOLANA ALONE', async () => {
    await fundUsdg(BUYER, 20_000_000n);
    evmRpc.escrowBalance = 0n;

    await context.reconciliation.reconcile(USDG);
    await context.reconciliation.reconcile(USDC_ASSET);

    expect(await context.reconciliation.isFrozen(USDG)).toBe(true);
    // Solana's own pass ran against its own vault and its own (empty) journal.
    // A freeze keyed on "the latest run of any asset" would fail here, and it
    // is the shape a per-asset freeze exists to refuse.
    expect(await context.reconciliation.isFrozen(USDC_ASSET)).toBe(false);
  });

  it('records a finding, not a silence, when the chain cannot be read at all', async () => {
    evmRpc.throwOnRequest = new Error('ECONNRESET');

    const report = await context.reconciliation.reconcile(USDG);

    expect(report.findings.map((f) => f.code)).toContain(
      ReconciliationFindingCode.RECONCILIATION_FAILED,
    );
    // A reconciler whose failures propagate as exceptions goes quiet exactly
    // when the infrastructure is unhealthy, which is when it is most needed.
    expect(await context.runs.findLatest(USDG)).not.toBeNull();
  });

  it('refuses the whole pass when vault control cannot be proven', async () => {
    await fundUsdg(BUYER, 12_500_000n);
    evmRpc.escrowBalance = 12_500_000n;
    evmRpc.implementation = OTHER_IMPLEMENTATION;

    const report = await context.reconciliation.reconcile(USDG);

    expect(report.findings.map((f) => f.code)).toContain(
      ReconciliationFindingCode.RECONCILIATION_FAILED,
    );
    // And the balance must NOT appear in the row — an unverified vault's
    // balance is not evidence. The chain would have answered 12500000 happily;
    // what stops it being written is that `assertVaultControl` runs FIRST.
    const row = await context.runs.findLatest(USDG);
    expect(row!.vaultBalance).toBeNull();
    expect(row!.vaultAccount).toBeNull();
  });
});
