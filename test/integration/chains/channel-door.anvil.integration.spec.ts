import { readFileSync } from 'node:fs';

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  parseAbi,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { EvmChannelDoor } from '@modules/chains/evm/evm-channel-door.service';
import { evmDomain } from '@modules/chains/evm/eip712/domain';
import {
  channelKeyOf,
  channelRefundId,
  channelVoucherTypedData,
} from '@modules/payment/domain/channel/channel-voucher';

/**
 * `EvmChannelDoor` against the REAL W1 contracts (assay-evm 6e36571) on a
 * LOCAL anvil (chain 46630) — never a shared or public chain. Skipped unless
 * `CHANNEL_ANVIL_ADDRS` names the addresses file a local deploy wrote
 * (`{ usdg, config, stake, escrow }`) and `CHANNEL_ANVIL_RPC` its RPC.
 *
 * Proves the ABI, the calldata (concatenated signatures, the forwarded tail),
 * and the decoding of every event the scheduler books from: `ChannelOpened`,
 * slim `ChannelSettled` (waived derived), `ChannelSettleSkipped`,
 * `ChannelCollected`, `ChannelRefunded`, and `channelBooks`.
 */
const ADDRS = process.env.CHANNEL_ANVIL_ADDRS;
const RPC = process.env.CHANNEL_ANVIL_RPC ?? 'http://127.0.0.1:8549';
const run = ADDRS ? describe : describe.skip;

const CHAIN_ID = 'eip155:46630' as never;
const ASSET = 'eip155:46630/erc20:0x5FbDB2315678afecb367f032d93F642f64180aa3' as never;
// Anvil's well-known development keys: local only.
const OWNER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const REDEEMER_KEY = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6';
const BUYER_KEY = '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a';
const PROVIDER = getAddress('0x6666666666666666666666666666666666666666');

run('EvmChannelDoor against the W1 contracts on a local anvil', () => {
  const chain = defineChain({
    id: 46630,
    name: 'local',
    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [RPC] } },
  });
  const client = createPublicClient({ chain, transport: http(RPC) });
  const addrs = ADDRS ? JSON.parse(readFileSync(ADDRS, 'utf8')) : {};
  const owner = privateKeyToAccount(OWNER_KEY);
  const redeemer = privateKeyToAccount(REDEEMER_KEY);
  const buyer = privateKeyToAccount(BUYER_KEY);
  let door: EvmChannelDoor;

  const wallet = (account: ReturnType<typeof privateKeyToAccount>) =>
    createWalletClient({ account, chain, transport: http(RPC) });
  const send = async (
    account: ReturnType<typeof privateKeyToAccount>,
    address: string,
    abi: string,
    args: unknown[],
  ) => {
    const parsed = parseAbi([abi]);
    const hash = await wallet(account).writeContract({
      address: address as `0x${string}`,
      abi: parsed,
      functionName: (parsed[0] as { name: string }).name,
      args,
    } as never);
    await client.waitForTransactionReceipt({ hash });
  };
  const rpc = (method: string, params: unknown[]) =>
    client.request({ method: method as never, params: params as never });

  beforeAll(async () => {
    // This test's redeemer: Config names it.
    const usdg = addrs.usdg;
    for (const account of [redeemer, buyer]) {
      await rpc('anvil_setBalance', [account.address, '0x56BC75E2D63100000']);
    }
    const params = (await client.readContract({
      address: addrs.config,
      abi: parseAbi([
        'struct ParamSet { address treasury; address redeemer; uint64 unbondingPeriodSeconds; uint64 minimumStake; uint64 penaltyAmount; uint64 verifierDailyCap; uint16 takeRateBps; uint16 slashAgentBps; uint16 slashPlatformBps; uint16 slashCapBps; }',
        'function params() view returns (ParamSet)',
      ]),
      functionName: 'params',
    })) as Record<string, unknown>;
    if (getAddress(params.redeemer as string) !== redeemer.address) {
      // The deploy named another redeemer: impersonate it instead.
      throw new Error(`deploy with REDEEMER_ADDRESS=${redeemer.address}`);
    }
    await send(owner, usdg, 'function mint(address,uint256)', [owner.address, 1_000_000_000n]);
    await send(owner, usdg, 'function approve(address,uint256)', [addrs.stake, 1_000_000_000n]);
    await send(owner, addrs.stake, 'function depositStakeFor(address,uint64)', [
      PROVIDER,
      200_000_000n,
    ]);
    await send(owner, usdg, 'function mint(address,uint256)', [buyer.address, 500_000_000n]);
    await send(buyer, usdg, 'function approve(address,uint256)', [addrs.escrow, 500_000_000n]);
    await send(buyer, addrs.escrow, 'function deposit(uint64)', [100_000_000n]);
    await send(buyer, addrs.escrow, 'function setLimits(uint64,uint64)', [5_000_000n, 50_000_000n]);

    const relayer = {
      name: 'anvil-redeemer',
      address: async () => `eip155:46630:${redeemer.address}`,
      balanceWei: async () => 10n ** 20n,
      sendCall: async (call: { to: string; data: `0x${string}`; gasLimit: bigint }) => {
        const hash = await wallet(redeemer).sendTransaction({
          to: getAddress(call.to.split(':')[2]),
          data: call.data,
          gas: call.gasLimit,
        } as never);
        const receipt = await client.waitForTransactionReceipt({ hash });
        return {
          hash,
          status: receipt.status === 'success' ? 'SUCCESS' : 'REVERTED',
          revertReason: receipt.status === 'success' ? null : 'UNKNOWN_REVERT',
          gasUsed: receipt.gasUsed,
          effectiveGasPrice: receipt.effectiveGasPrice,
          blockNumber: receipt.blockNumber,
        };
      },
      sendValue: async () => {
        throw new Error('not used');
      },
    };
    door = new EvmChannelDoor(
      new Map([[CHAIN_ID, client as never]]),
      new Map([
        [
          CHAIN_ID,
          {
            chainId: CHAIN_ID,
            config: addrs.config,
            stake: addrs.stake,
            escrow: addrs.escrow,
            asset: addrs.usdg,
          } as never,
        ],
      ]),
      relayer as never,
      null,
      null,
    );
  }, 120_000);

  const domain = () => evmDomain(CHAIN_ID, getAddress(addrs.escrow));
  const voucher = async (channelId: `0x${string}`, cumulative: bigint, calls: number) => {
    const block = await client.getBlock();
    const message = {
      payer: buyer.address,
      provider: PROVIDER,
      channelId,
      cumulative,
      calls,
      issuedAt: block.timestamp,
      expiresAt: block.timestamp + 240n,
    };
    const signature = await buyer.signTypedData(
      channelVoucherTypedData(message, domain()) as never,
    );
    return { message, signature };
  };

  it('the escrow has the door; settle opens a channel, charges into a bucket, derives waived', async () => {
    expect(await door.doorLive(ASSET)).toBe(true);
    const id = `0x${'a1'.repeat(32)}` as `0x${string}`;
    const first = await voucher(id, 300_000n, 3);
    const settled = await door.settle(
      ASSET,
      [{ voucher: first.message, signature: first.signature, fromSettled: 0n, charge: 200_000n }],
      'ORDINARY',
    );
    const outcome = settled.outcomes[0];
    expect(outcome.kind).toBe('SETTLED');
    if (outcome.kind !== 'SETTLED') return;
    const key = channelKeyOf(buyer.address, buyer.address, PROVIDER, id);
    expect(outcome.key.toLowerCase()).toBe(key.toLowerCase());
    expect(outcome.opened).toEqual({ signer: buyer.address, channelId: id });
    expect(outcome.charge).toBe(200_000n);
    expect(outcome.cumulative - 0n - outcome.charge).toBe(100_000n); // waived
    expect(outcome.takeRateBps).toBe(1_000);

    const books = await door.readBooks(ASSET, key);
    expect(books?.slot.settled).toBe(300_000n);
    expect(books?.slot.calls).toBe(3);
    expect(books!.slot.h1 + books!.slot.h2).toBe(200_000n);
    expect(books?.held).toBeGreaterThanOrEqual(200_000n);
  });

  it('a stale fromSettled is skipped BaseMismatch (never a revert), in the simulation and on chain', async () => {
    const id = `0x${'a1'.repeat(32)}` as `0x${string}`;
    const next = await voucher(id, 400_000n, 4);
    const item = {
      voucher: next.message,
      signature: next.signature,
      fromSettled: 0n,
      charge: 100_000n,
    };
    const simulated = await door.simulateSettle(ASSET, [item]);
    // With eth_simulateV1 the skip is seen before the send; without it the call passes.
    if (simulated[0].kind === 'SKIPPED') expect(simulated[0].reason).toBe('BaseMismatch');
    const landed = await door.settle(ASSET, [item], 'ORDINARY');
    expect(landed.outcomes[0]).toMatchObject({ kind: 'SKIPPED', reason: 'BaseMismatch' });
  });

  it('refunds from a bucket inside its window; collects a matured one oldest first', async () => {
    const id = `0x${'b2'.repeat(32)}` as `0x${string}`;
    const v = await voucher(id, 500_000n, 5);
    const settled = await door.settle(
      ASSET,
      [{ voucher: v.message, signature: v.signature, fromSettled: 0n, charge: 500_000n }],
      'ORDINARY',
    );
    const outcome = settled.outcomes[0];
    if (outcome.kind !== 'SETTLED') throw new Error('not settled');
    const ref = { payer: buyer.address, signer: buyer.address, provider: PROVIDER, channelId: id };

    const refund = await door.refund(ASSET, [
      {
        ref,
        maturityHour: outcome.maturityHour,
        takeRateBps: outcome.takeRateBps,
        amount: 100_000n,
        refundId: channelRefundId('anvil-refund-1'),
      },
    ]);
    expect(refund.refunded).toEqual([
      expect.objectContaining({
        payer: buyer.address,
        amount: 100_000n,
        maturityHour: outcome.maturityHour,
      }),
    ]);

    // Past maturity: the redeemer collects, keeping 50,000 for a dispute.
    await rpc('evm_increaseTime', [2 * 3_600 + 60]);
    await rpc('evm_mine', []);
    const collected = await door.collect(ASSET, [ref], [50_000n], 'ORDINARY');
    expect(collected.paid).toEqual([
      expect.objectContaining({ provider: PROVIDER, gross: 350_000n, fee: 35_000n }),
    ]);
    expect(collected.deferred).toEqual([]);
    const books = await door.readBooks(
      ASSET,
      channelKeyOf(buyer.address, buyer.address, PROVIDER, id),
    );
    expect(books!.slot.h1 + books!.slot.h2).toBe(50_000n);
    expect(books?.totalUnpaid).toBe(0n);
  });

  it('reads the signer window, the provider risk and the foreign-transaction scan from the real contracts', async () => {
    const window = await door.signerWindow(ASSET, buyer.address, buyer.address);
    // setLimits raised nothing it lowered: no caps hold, no grant.
    expect(window).toEqual({
      validUntil: null,
      revoked: false,
      revokeGraceEndsAt: null,
      heldCapsEndAt: null,
    });
    // Staked 200 against a minimum of 100: no risk.
    expect(await door.providerRisk(ASSET, PROVIDER)).toEqual({
      unbonding: false,
      slashPending: false,
      nearFloor: false,
      blocked: false,
    });
    // Every channel transaction so far was the redeemer's.
    const scan = await door.foreignChannelTxs(ASSET, null, 5_000n);
    expect(scan.foreign).toEqual([]);
  });
});
