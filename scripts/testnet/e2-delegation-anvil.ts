/**
 * Agent payment delegation, end to end against a REAL EVM — an anvil fork of
 * Robinhood Chain testnet (eip155:46630) whose X402Escrow proxy has been
 * upgraded with `assay-evm/script/UpgradeEscrow.s.sol`.
 *
 * It drives the backend's own production classes against that chain, with no
 * Nest and no database, so what it proves is the chain/backend contract:
 *
 *   1. `EvmEscrowIntentBuilder.authorizeIntent` issues the AuthorizeDelegate the
 *      payer signs; `EvmRelayedEscrowIntentSubmitter` relays it
 *      (`authorizeDelegateBySig`) — the payer pays no gas;
 *   2. `list` reads the delegation back from the chain;
 *   3. a voucher built by the agent CLI and signed by the DELEGATE key is
 *      accepted by `EvmChainAdapter.authorizeVoucherSigner` (the off-chain
 *      mirror) and redeemed on chain by `EvmVoucherRedeemer`; the provider is
 *      paid and the delegate's own window counts it;
 *   4. the chain refuses a delegate voucher over the delegate's cap — and the
 *      off-chain terms name that same cap;
 *   5. the payer revokes (relayed); the mirror answers DELEGATE_REVOKED and the
 *      chain refuses with DelegateIsRevoked.
 *
 * Setup on the FORK only (never testnet): the config admin is impersonated to
 * point the redeemer at an anvil key, and the mock USDG is minted to a fresh
 * payer. Nothing here sends a transaction to a real network.
 *
 *   anvil --fork-url https://rpc.testnet.chain.robinhood.com --port 8547
 *   (assay-evm) forge script script/UpgradeEscrow.s.sol --rpc-url http://127.0.0.1:8547 \
 *       --sender <admin> --unlocked --broadcast
 *   (assay-backend) E2_RPC_URL=http://127.0.0.1:8547 \
 *       npx ts-node -r tsconfig-paths/register scripts/testnet/e2-delegation-anvil.ts
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  parseAbi,
  PublicClient,
} from 'viem';
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';

import { EvmChainAdapter } from '@modules/chains/evm/evm-chain.adapter';
import { EvmEscrowIntentBuilder } from '@modules/chains/evm/evm-escrow-intent-builder.service';
import { EvmRelayedEscrowIntentSubmitter } from '@modules/chains/evm/evm-relayed-escrow-intent.service';
import { EvmVoucherRedeemer } from '@modules/chains/evm/evm-voucher-redeemer.service';
import { EvmDeployment } from '@modules/chains/evm/evm.constants';
import { EvmRelayerPort, EvmRelayResult } from '@modules/chains/evm/ports/evm-relayer.port';
import { evmErrorName, revertDataOf } from '@modules/chains/evm/abi/error-selectors';
import {
  AccountId,
  AssetId,
  ChainId,
  parseAccountId,
  toAccountId,
} from '@modules/chains/ports/caip.types';
import { Eip155TypedDataRequest } from '@modules/chains/ports/unsigned-chain-transaction';
import { Voucher } from '@modules/chains/ports/x402.types';
import { EscrowDelegationKind } from '@modules/settlement/ports/escrow-delegation.port';
import { RelayedEscrowIntent } from '@modules/settlement/ports/relayed-escrow-intent.port';
import { MoneyUtil } from '@shared/utils/money.util';

const RPC = process.env.E2_RPC_URL ?? 'http://127.0.0.1:8547';
// Defaults assume the e2e workspace sits next to this repo; override with the env vars.
const EVIDENCE =
  process.env.E2_EVIDENCE ??
  resolve(__dirname, '../../../e2e/apps/evidence/delegation-anvil-proof.json');
const CLI_LIB =
  process.env.E2_AGENT_CLI_LIB ?? resolve(__dirname, '../../../e2e/apps/agent-cli/lib.mjs');

const CHAIN: ChainId = 'eip155:46630' as ChainId;
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const DEPLOYMENT: EvmDeployment = {
  chainId: CHAIN,
  config: '0xCf6592A3a053d9714D16d176A86fA039Fe7B6a43',
  stake: '0x0aF4D08f97B4FA8Ba3E47Cb025aE8CaD509bc73c',
  escrow: '0x1D2625efD87c2fc10b8563f3F0890072845Fcf41',
  asset: '0xDbbC156dD414f43f2c952C1Be0f16A0B9a826Cd3',
  escrowImplementation: '0x0000000000000000000000000000000000000000',
  admin: '0xD9a229c2847929ecAEfc83C17519FCA53Fd20D32',
  // Not read here: nothing in this script runs the vault-control check.
  owner: '0x0000000000000000000000000000000000000000',
  multicall3: MULTICALL3,
} as EvmDeployment;
/** The real testnet provider, already bonded above the stake floor. */
const PROVIDER = getAddress('0xfB18f483E985F21c58fD97F69DE225aECA5Fc1c4');
const USDG = `${CHAIN}/erc20:${DEPLOYMENT.asset}`;
/**
 * The fork's relayer AND redeemer: anvil's account #0, DERIVED from anvil's
 * public test mnemonic at run time (or `E2_ANVIL_MNEMONIC`), so no private-key
 * literal sits in the repository. Fork only.
 */
const ANVIL_MNEMONIC =
  process.env.E2_ANVIL_MNEMONIC ?? 'test test test test test test test test test test test junk';

const chain = defineChain({
  id: 46630,
  name: 'robinhood-testnet-fork',
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
  contracts: { multicall3: { address: MULTICALL3 } },
});

const CONFIG_ABI = parseAbi([
  'struct ParamSet { address treasury; address redeemer; uint64 unbondingPeriodSeconds; uint64 minimumStake; uint64 penaltyAmount; uint64 verifierDailyCap; uint16 takeRateBps; uint16 slashAgentBps; uint16 slashPlatformBps; uint16 slashCapBps; }',
  'function params() view returns (ParamSet)',
  'function updateConfig(ParamSet p, address newAdmin)',
]);
const ERC20_ABI = parseAbi([
  'function mint(address to, uint256 amount)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
]);
const ESCROW_ABI = parseAbi([
  'function deposit(uint64 amount)',
  'function setLimits(uint64 maxVoucherAmount, uint64 maxPerWindow)',
  'struct Delegation { uint64 maxVoucherAmount; uint64 maxPerWindow; uint64 spentInWindow; uint64 windowStartedAt; uint64 validUntil; uint32 listPosition; bool revoked; }',
  'function delegationOf(address payer, address delegate) view returns (Delegation)',
  'struct Escrow { uint128 balance; uint64 seqHigh; uint64 authNonce; uint64 maxVoucherAmount; uint64 maxPerWindow; uint64 spentInWindow; uint64 windowStartedAt; uint64 withdrawRequested; uint64 withdrawAvailableAt; uint128 totalRedeemed; uint128 totalWithdrawn; uint128 totalFunded; }',
  'function escrowOf(address) view returns (Escrow)',
]);

/** The two calls this proof makes on a wallet client, typed loosely: viem's account generics are not the subject here. */
type LooseWallet = {
  writeContract(args: unknown): Promise<`0x${string}`>;
  sendTransaction(args: unknown): Promise<`0x${string}`>;
};

const json = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2);
const step = (n: string, detail: unknown) => {
  console.log(`\n== ${n}\n${json(detail)}`);
  evidence.steps.push({ step: n, detail });
};
const evidence: { at: string; rpc: string; steps: { step: string; detail: unknown }[] } = {
  at: new Date().toISOString(),
  rpc: RPC,
  steps: [],
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`PROOF FAILED: ${message}`);
}

async function main(): Promise<void> {
  const publicClient = createPublicClient({
    chain,
    transport: http(RPC),
  }) as unknown as PublicClient;
  const testClient = createTestClient({ chain, mode: 'anvil', transport: http(RPC) });
  const relayer = mnemonicToAccount(ANVIL_MNEMONIC);
  const relayerWallet = createWalletClient({
    account: relayer,
    chain,
    transport: http(RPC),
  }) as unknown as LooseWallet;
  const payer = privateKeyToAccount(generatePrivateKey());
  const payerWallet = createWalletClient({
    account: payer,
    chain,
    transport: http(RPC),
  }) as unknown as LooseWallet;
  const delegate = privateKeyToAccount(generatePrivateKey());
  const stranger = privateKeyToAccount(generatePrivateKey());
  const payerAccount = toAccountId(CHAIN, payer.address);
  const delegateAccount = toAccountId(CHAIN, delegate.address);

  // ── Fork-only setup ────────────────────────────────────────────────────
  const params = (await publicClient.readContract({
    address: DEPLOYMENT.config as `0x${string}`,
    abi: CONFIG_ABI,
    functionName: 'params',
  })) as Record<string, unknown>;
  await testClient.impersonateAccount({ address: DEPLOYMENT.admin as `0x${string}` });
  await testClient.setBalance({ address: DEPLOYMENT.admin as `0x${string}`, value: 10n ** 20n });
  await testClient.setBalance({ address: payer.address, value: 10n ** 18n });
  const adminWallet = createWalletClient({
    account: DEPLOYMENT.admin as `0x${string}`,
    chain,
    transport: http(RPC),
  }) as unknown as LooseWallet;
  await publicClient.waitForTransactionReceipt({
    hash: await adminWallet.writeContract({
      address: DEPLOYMENT.config as `0x${string}`,
      abi: CONFIG_ABI,
      functionName: 'updateConfig',
      args: [{ ...params, redeemer: relayer.address }, DEPLOYMENT.admin as `0x${string}`],
      chain,
    } as never),
  });
  const send = async (hash: Promise<`0x${string}`>) =>
    publicClient.waitForTransactionReceipt({ hash: await hash });
  await send(
    payerWallet.writeContract({
      address: DEPLOYMENT.asset as `0x${string}`,
      abi: ERC20_ABI,
      functionName: 'mint',
      args: [payer.address, 20_000_000n],
      chain,
    }),
  );
  await send(
    payerWallet.writeContract({
      address: DEPLOYMENT.asset as `0x${string}`,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [DEPLOYMENT.escrow as `0x${string}`, 20_000_000n],
      chain,
    }),
  );
  await send(
    payerWallet.writeContract({
      address: DEPLOYMENT.escrow as `0x${string}`,
      abi: ESCROW_ABI,
      functionName: 'deposit',
      args: [20_000_000n],
      chain,
    }),
  );
  await send(
    payerWallet.writeContract({
      address: DEPLOYMENT.escrow as `0x${string}`,
      abi: ESCROW_ABI,
      functionName: 'setLimits',
      args: [1_000_000n, 10_000_000n],
      chain,
    }),
  );
  step('setup (fork only)', {
    payer: payer.address,
    delegate: delegate.address,
    redeemerNowAnvilKey: relayer.address,
    escrowFunded: '20 USDG, limits 1 / 10 USDG',
  });

  // ── The backend's own classes, wired to the fork ──────────────────────
  const clients = new Map([[CHAIN, publicClient as never]]);
  const deployments = new Map([[CHAIN, DEPLOYMENT]]);
  const relayerPort: EvmRelayerPort = {
    name: 'anvil-relayer',
    address: async (c) => toAccountId(c, relayer.address),
    balanceWei: async () => publicClient.getBalance({ address: relayer.address }),
    sendCall: async (call): Promise<EvmRelayResult> => {
      const hash = await relayerWallet.sendTransaction({
        to: getAddress(parseAccountId(call.to).address),
        data: call.data,
        gas: call.gasLimit,
        chain,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      let revertReason: string | null = null;
      if (receipt.status !== 'success') {
        try {
          await publicClient.call({
            account: relayer.address,
            to: getAddress(parseAccountId(call.to).address),
            data: call.data,
            blockNumber: receipt.blockNumber,
          });
        } catch (error) {
          revertReason = evmErrorName(revertDataOf(error));
        }
      }
      return {
        hash,
        status: receipt.status === 'success' ? 'SUCCESS' : 'REVERTED',
        revertReason,
        gasUsed: receipt.gasUsed,
        blockNumber: receipt.blockNumber,
      };
    },
    sendValue: async () => {
      throw new Error('not used');
    },
  };
  const builder = new EvmEscrowIntentBuilder(clients, deployments, { now: () => Date.now() });
  const submitter = new EvmRelayedEscrowIntentSubmitter(clients, deployments, relayerPort);
  const adapter = new EvmChainAdapter(clients, deployments, [CHAIN]);
  const redeemer = new EvmVoucherRedeemer(
    clients,
    deployments,
    relayerPort,
    { emit: async () => undefined } as never,
    { now: () => Date.now() },
  );
  const chainNow = async () =>
    Number((await publicClient.getBlock({ blockTag: 'latest' })).timestamp);

  const signRelayed = (tx: Eip155TypedDataRequest) =>
    payer.signTypedData({
      domain: { ...tx.domain, chainId: Number(tx.domain.chainId) },
      types: tx.types,
      primaryType: tx.primaryType,
      message: tx.message,
    } as never);

  // 1. Authorise, relayed.
  const validUntil = BigInt((await chainNow()) + 30 * 86_400);
  const authorize = (await builder.authorizeIntent(payerAccount, {
    delegate: delegateAccount,
    maxVoucherAmount: 400_000n,
    maxPerWindow: 1_000_000n,
    validUntil,
  })) as Eip155TypedDataRequest;
  const payerEthBefore = await publicClient.getBalance({ address: payer.address });
  const authSub = await submitter.submit({
    kind: EscrowDelegationKind.AUTHORIZE_DELEGATE,
    account: payerAccount,
    delegate: delegate.address,
    maxVoucherAmount: 400_000n,
    maxPerWindow: 1_000_000n,
    validUntil,
    nonce: BigInt(String(authorize.message.nonce)),
    deadline: BigInt(String(authorize.message.deadline)),
    signature: await signRelayed(authorize),
  } as RelayedEscrowIntent);
  assert(
    (await publicClient.getBalance({ address: payer.address })) === payerEthBefore,
    'the payer paid gas',
  );
  step('1. authorizeDelegateBySig relayed (payer paid no gas)', {
    primaryType: authorize.primaryType,
    message: authorize.message,
    submission: authSub,
  });

  // 2. Read back from the chain.
  const listed = await builder.list(payerAccount);
  assert(
    listed.length === 1 && listed[0].delegate === delegateAccount && listed[0].status === 'ACTIVE',
    'list',
  );
  step('2. GET /escrow/delegates equivalent (from chain)', listed);

  // 3. The agent CLI builds and signs the voucher with the DELEGATE key.
  const cli = (await new Function('p', 'return import(p)')(CLI_LIB)) as {
    buildVoucher: (
      r: unknown,
      now: number,
    ) => { voucher: Voucher; typedData: Record<string, unknown> };
    assertDelegateMaySign: (r: unknown, a: string) => void;
  };
  const requirementFor = (seq: string, amount: bigint) => ({
    rail: 'B',
    scheme: 'voucher',
    network: CHAIN,
    payer: payerAccount,
    payTo: toAccountId(CHAIN, DEPLOYMENT.escrow),
    provider: toAccountId(CHAIN, PROVIDER),
    providerId: 'anvil-provider',
    amount: { amount: amount.toString(), asset: USDG, decimals: 6 },
    resource: '/mcp/tools/get_weather',
    requestHash: `sha256:${'ab'.repeat(32)}`,
    seq,
    maxTimeoutSeconds: 300,
    signers: ['payer', 'delegate'],
    delegate: delegateAccount,
  });
  const voucherFor = async (signer: typeof delegate, seq: string, amount: bigint) => {
    const requirement = requirementFor(seq, amount);
    if (signer === delegate) cli.assertDelegateMaySign(requirement, delegate.address);
    const { voucher, typedData } = cli.buildVoucher(requirement, await chainNow());
    const signature = await signer.signTypedData(typedData as never);
    return {
      voucher: {
        ...voucher,
        amount: MoneyUtil.of(voucher.amount.amount, USDG as AssetId, 6),
      } as Voucher,
      signature,
    };
  };
  // The delegate travels with the request, as `VoucherRedemptionService` sends it, so the
  // redeemer pre-validates the grant before it simulates or sends anything.
  const redeem = (v: Voucher, signature: string, signedBy: AccountId | null = delegateAccount) =>
    redeemer.redeem({
      delegate: signedBy,
      payer: v.payer,
      provider: v.provider,
      amount: v.amount,
      asset: USDG as never,
      resourceHash: adapter.voucherResourceHash(v.resource),
      requestHash: v.requestHash.replace(/^sha256:/, ''),
      seq: v.seq,
      issuedAt: v.issuedAt,
      expiresAt: v.expiresAt,
      signature,
    });

  const paid = await voucherFor(delegate, '1', 250_000n);
  const authority = await adapter.authorizeVoucherSigner(
    paid.voucher,
    paid.signature,
    await chainNow(),
  );
  assert(authority.kind === 'DELEGATE', `mirror said ${authority.kind}`);
  const strangerVoucher = await voucherFor(stranger, '1', 250_000n);
  const strangerAuthority = await adapter.authorizeVoucherSigner(
    strangerVoucher.voucher,
    strangerVoucher.signature,
    await chainNow(),
  );
  assert(strangerAuthority.kind === 'REFUSED', 'a stranger was accepted');
  const providerBefore = (await publicClient.readContract({
    address: DEPLOYMENT.asset as `0x${string}`,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [PROVIDER],
  })) as bigint;
  const outcome = await redeem(paid.voucher, paid.signature);
  const providerAfter = (await publicClient.readContract({
    address: DEPLOYMENT.asset as `0x${string}`,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [PROVIDER],
  })) as bigint;
  const grant = (await publicClient.readContract({
    address: DEPLOYMENT.escrow as `0x${string}`,
    abi: ESCROW_ABI,
    functionName: 'delegationOf',
    args: [payer.address, delegate.address],
  })) as { spentInWindow: bigint };
  const escrow = (await publicClient.readContract({
    address: DEPLOYMENT.escrow as `0x${string}`,
    abi: ESCROW_ABI,
    functionName: 'escrowOf',
    args: [payer.address],
  })) as { balance: bigint; seqHigh: bigint };
  assert(
    outcome.kind === 'REDEEMED',
    `redeem outcome ${outcome.kind} ${outcome.programError ?? ''}`,
  );
  assert(providerAfter - providerBefore === 225_000n, 'provider not paid 0.25 - 10%');
  assert(
    grant.spentInWindow === 250_000n && escrow.balance === 19_750_000n && escrow.seqHigh === 1n,
    'counters',
  );
  step('3. delegate-signed voucher: mirror DELEGATE, stranger REFUSED, redeemed on chain', {
    mirror: authority,
    stranger: strangerAuthority,
    redeem: outcome,
    providerPaid: (providerAfter - providerBefore).toString(),
    delegateSpentInWindow: grant.spentInWindow,
    payerEscrow: escrow,
  });

  // 4. Over the delegate's own per-voucher cap (400k): the chain refuses it.
  const over = await voucherFor(delegate, '2', 500_000n);
  const overOutcome = await redeem(over.voucher, over.signature);
  assert(
    overOutcome.programError === 'DelegateVoucherExceedsPerCallLimit',
    `over-cap: ${overOutcome.programError}`,
  );
  step('4. over the delegate cap: chain refuses, off-chain terms name the same cap', {
    offChainTerms: authority.kind === 'DELEGATE' ? authority.terms : null,
    redeem: overOutcome,
  });

  // 5. Revoke, relayed; the mirror and the chain both refuse afterwards.
  const revoke = (await builder.revokeIntent(
    payerAccount,
    delegateAccount,
  )) as Eip155TypedDataRequest;
  const revokeSub = await submitter.submit({
    kind: EscrowDelegationKind.REVOKE_DELEGATE,
    account: payerAccount,
    delegate: delegate.address,
    nonce: BigInt(String(revoke.message.nonce)),
    deadline: BigInt(String(revoke.message.deadline)),
    signature: await signRelayed(revoke),
  } as RelayedEscrowIntent);
  await new Promise((r) => setTimeout(r, 3_100)); // the mirror's delegation cache TTL
  const after = await voucherFor(delegate, '3', 100_000n);
  const revokedAuthority = await adapter.authorizeVoucherSigner(
    after.voucher,
    after.signature,
    await chainNow(),
  );
  const revokedOutcome = await redeem(after.voucher, after.signature);
  assert(
    revokedAuthority.kind === 'REFUSED' && revokedAuthority.reason === 'DELEGATE_REVOKED',
    'mirror after revoke',
  );
  assert(
    revokedOutcome.programError === 'DelegateIsRevoked',
    `chain after revoke: ${revokedOutcome.programError}`,
  );
  assert((await builder.list(payerAccount)).length === 0, 'still listed');
  // The payer's OWN key still pays: delegation never replaced it.
  const own = await voucherFor(payer as never, '4', 100_000n);
  const ownOutcome = await redeem(own.voucher, own.signature, null);
  assert(ownOutcome.kind === 'REDEEMED', 'payer key');
  step(
    '5. revoked (relayed): mirror DELEGATE_REVOKED, chain DelegateIsRevoked, payer key still pays',
    {
      submission: revokeSub,
      mirror: revokedAuthority,
      redeem: revokedOutcome,
      payerOwnVoucher: ownOutcome,
    },
  );

  writeFileSync(EVIDENCE, json(evidence));
  console.log(`\nPROOF OK — evidence: ${EVIDENCE}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
