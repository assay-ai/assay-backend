import { ChainErrorCode } from '@modules/chains/errors/chains.errors';
import { AccountId, AssetId, CHAIN_IDS, ChainNamespace } from '@modules/chains/ports/caip.types';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { NamespaceEscrowBalanceReader } from '@modules/chains/multiplex/namespace-escrow-balance-reader';
import { NamespaceEscrowIntentBuilder } from '@modules/chains/multiplex/namespace-escrow-intent-builder';
import { NamespaceStakeReader } from '@modules/chains/multiplex/namespace-stake-reader';
import { NamespaceVoucherRedeemer } from '@modules/chains/multiplex/namespace-voucher-redeemer';
import { EscrowIntentKind } from '@modules/settlement/ports/escrow-intent-builder.port';
import {
  RedeemOutcomeKind,
  RedeemVoucherRequest,
  VoucherRedeemerPort,
} from '@modules/payment/ports/voucher-redeemer.port';
import { MoneyUtil } from '@shared/utils/money.util';

const SOLANA = CHAIN_IDS.SOLANA_DEVNET;
const EVM = CHAIN_IDS.ROBINHOOD_TESTNET;

const SOLANA_ACCOUNT = `${SOLANA}:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM` as AccountId;
const EVM_ACCOUNT = `${EVM}:0x5B38Da6a701c568545dCfcB03FcB875f56beddC4` as AccountId;
const COSMOS_ACCOUNT = 'cosmos:hub-4:cosmos1abcdefghijklmnop' as AccountId;

const USDC = ASSET_IDS.USDC_SOLANA_DEVNET as AssetId;
const USDG = ASSET_IDS.USDG_ROBINHOOD_TESTNET as AssetId;

/**
 * The namespace multiplexers.
 *
 * Five ports resolved to exactly one Solana class before EVM support, and
 * `ChainVerifierRegistry` was the first of them to be split. These are the other
 * four. Every domain call site is unchanged: it holds the port, and the object
 * behind it dispatches on the CAIP-2 namespace of the identifier it is handed.
 */
describe('a namespace multiplexer', () => {
  // ── The escrow balance reader ────────────────────────────────────────────

  describe('NamespaceEscrowBalanceReader', () => {
    const solana = { read: jest.fn(), readMany: jest.fn(), escrowAddresses: jest.fn() };
    const evm = { read: jest.fn(), readMany: jest.fn(), escrowAddresses: jest.fn() };
    const reader = new NamespaceEscrowBalanceReader(
      new Map([
        [ChainNamespace.SOLANA, solana],
        [ChainNamespace.EIP155, evm],
      ]),
    );

    beforeEach(() => {
      jest.resetAllMocks();
      solana.readMany.mockResolvedValue(new Map());
      evm.readMany.mockResolvedValue(new Map());
    });

    it('routes a solana account to the solana implementation', async () => {
      solana.read.mockResolvedValue(null);

      await reader.read(SOLANA_ACCOUNT, USDC);

      expect(solana.read).toHaveBeenCalledWith(SOLANA_ACCOUNT, USDC);
      expect(evm.read).not.toHaveBeenCalled();
    });

    it('routes an eip155 account to the evm implementation', async () => {
      evm.read.mockResolvedValue(null);

      await reader.read(EVM_ACCOUNT, USDG);

      expect(evm.read).toHaveBeenCalledWith(EVM_ACCOUNT, USDG);
      expect(solana.read).not.toHaveBeenCalled();
    });

    it('refuses a namespace no implementation claims, naming it', async () => {
      await expect(reader.read(COSMOS_ACCOUNT, USDC)).rejects.toMatchObject({
        errorCode: ChainErrorCode.CHAIN_UNSUPPORTED,
        context: expect.objectContaining({ chainId: 'cosmos:hub-4' }),
      });
    });

    it('splits a MIXED readMany and never sends one namespace to the other', async () => {
      await reader.readMany([SOLANA_ACCOUNT, EVM_ACCOUNT], USDC);

      expect(solana.readMany).toHaveBeenCalledWith([SOLANA_ACCOUNT], USDC);
      expect(evm.readMany).toHaveBeenCalledWith([EVM_ACCOUNT], USDC);
    });

    it('merges the two answers into one map keyed by the original accounts', async () => {
      const solanaReading = { balance: MoneyUtil.of('1', USDC, 6) } as never;
      const evmReading = { balance: MoneyUtil.of('2', USDG, 6) } as never;
      solana.readMany.mockResolvedValue(new Map([[SOLANA_ACCOUNT, solanaReading]]));
      evm.readMany.mockResolvedValue(new Map([[EVM_ACCOUNT, evmReading]]));

      const merged = await reader.readMany([SOLANA_ACCOUNT, EVM_ACCOUNT], USDC);

      expect([...merged.keys()].sort()).toEqual([EVM_ACCOUNT, SOLANA_ACCOUNT].sort());
      expect(merged.get(SOLANA_ACCOUNT)).toBe(solanaReading);
      expect(merged.get(EVM_ACCOUNT)).toBe(evmReading);
    });

    it('asks nobody about an empty batch', async () => {
      const merged = await reader.readMany([], USDC);

      expect(merged.size).toBe(0);
      expect(solana.readMany).not.toHaveBeenCalled();
      expect(evm.readMany).not.toHaveBeenCalled();
    });
  });

  // ── The stake reader, and the batch that used to go to one chain ─────────

  describe('NamespaceStakeReader', () => {
    const solana = { bondedStakeOf: jest.fn() };
    const evm = { bondedStakeOf: jest.fn() };
    const reader = new NamespaceStakeReader(
      new Map([
        [ChainNamespace.SOLANA, solana],
        [ChainNamespace.EIP155, evm],
      ]),
    );

    beforeEach(() => {
      jest.resetAllMocks();
      solana.bondedStakeOf.mockResolvedValue(new Map());
      evm.bondedStakeOf.mockResolvedValue(new Map());
    });

    it('splits a MIXED batch and never sends one namespace to the other', async () => {
      // `OnChainProviderStakeSource.stakeOn` hands the UNION of accounts to one
      // reader and nothing narrows it by chain. On one chain that is invisible;
      // with two it asks Solana about an 0x address, which returns "no account"
      // — and an absent stake reading fails the routing gate CLOSED, so every
      // EVM provider silently stops routing.
      await reader.bondedStakeOf([SOLANA_ACCOUNT, EVM_ACCOUNT]);

      expect(solana.bondedStakeOf).toHaveBeenCalledWith([SOLANA_ACCOUNT]);
      expect(evm.bondedStakeOf).toHaveBeenCalledWith([EVM_ACCOUNT]);
    });

    it('merges the two answers into one map keyed by the original accounts', async () => {
      const one = { account: SOLANA_ACCOUNT } as never;
      const two = { account: EVM_ACCOUNT } as never;
      solana.bondedStakeOf.mockResolvedValue(new Map([[SOLANA_ACCOUNT, one]]));
      evm.bondedStakeOf.mockResolvedValue(new Map([[EVM_ACCOUNT, two]]));

      const merged = await reader.bondedStakeOf([SOLANA_ACCOUNT, EVM_ACCOUNT]);

      expect(merged.get(SOLANA_ACCOUNT)).toBe(one);
      expect(merged.get(EVM_ACCOUNT)).toBe(two);
      expect(merged.size).toBe(2);
    });

    it('groups repeated accounts into ONE call per namespace', async () => {
      // The control for the split: a per-account loop also puts each account on
      // the right reader, and would issue one RPC round trip per candidate.
      const second = `${SOLANA}:7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU` as AccountId;

      await reader.bondedStakeOf([SOLANA_ACCOUNT, second, EVM_ACCOUNT]);

      expect(solana.bondedStakeOf).toHaveBeenCalledTimes(1);
      expect(solana.bondedStakeOf).toHaveBeenCalledWith([SOLANA_ACCOUNT, second]);
      expect(evm.bondedStakeOf).toHaveBeenCalledTimes(1);
    });

    it('THROWS when one namespace cannot be read, rather than answering partially', async () => {
      // The caller — `OnChainProviderStakeSource` — treats a successful read as
      // authoritative and DISCARDS a cached reading for any account the chain
      // said nothing about. A partial map would therefore turn an EVM RPC
      // outage into "every EVM provider has no stake account" AND delete the
      // good cached readings — a stake-visibility race seen after deposits.
      // Throwing keeps
      // the caller on its own stale-tolerant path.
      evm.bondedStakeOf.mockRejectedValue(new Error('rpc unreachable'));

      await expect(reader.bondedStakeOf([SOLANA_ACCOUNT, EVM_ACCOUNT])).rejects.toThrow(
        /rpc unreachable/,
      );
    });

    it('refuses a namespace no implementation claims, before reading anything', async () => {
      await expect(reader.bondedStakeOf([SOLANA_ACCOUNT, COSMOS_ACCOUNT])).rejects.toMatchObject({
        errorCode: ChainErrorCode.CHAIN_UNSUPPORTED,
      });
      // And nothing was asked. A partial read followed by a throw would have
      // spent an RPC call on a batch that was never going to be answered.
      expect(solana.bondedStakeOf).not.toHaveBeenCalled();
    });
  });

  // ── The voucher redeemer ─────────────────────────────────────────────────

  describe('NamespaceVoucherRedeemer', () => {
    const solana = { maxBatchSize: 1, redeem: jest.fn(), redeemBatch: jest.fn() };
    const evm = { maxBatchSize: 64, redeem: jest.fn(), redeemBatch: jest.fn() };
    const redeemer = new NamespaceVoucherRedeemer(
      new Map([
        [ChainNamespace.SOLANA, solana],
        [ChainNamespace.EIP155, evm],
      ]),
    );

    const request = (payer: AccountId): RedeemVoucherRequest =>
      ({ payer, amount: MoneyUtil.of('1', USDC, 6) }) as RedeemVoucherRequest;

    beforeEach(() => {
      jest.resetAllMocks();
      solana.redeemBatch.mockResolvedValue([{ kind: RedeemOutcomeKind.REDEEMED }]);
      evm.redeemBatch.mockResolvedValue([{ kind: RedeemOutcomeKind.REDEEMED }]);
    });

    it('is the MINIMUM batch size across implementations', () => {
      // Not the maximum and not the EVM one: `VoucherRedemptionService` forms a
      // batch before it knows which chain the rows are on, and a batch of 64
      // handed to Solana would be 64 transactions' worth of work presented as
      // one.
      expect(redeemer.maxBatchSize).toBe(1);
    });

    it('asks the payer chain whether a voucher landed, and answers null where it cannot look', async () => {
      const landing = jest.fn().mockResolvedValue('0xlanded');
      const withLanding = new NamespaceVoucherRedeemer(
        new Map<ChainNamespace, VoucherRedeemerPort>([
          [ChainNamespace.SOLANA, solana],
          [ChainNamespace.EIP155, { ...evm, findLanding: landing }],
        ]),
      );

      await expect(withLanding.findLanding(request(EVM_ACCOUNT), ['0xa'])).resolves.toBe(
        '0xlanded',
      );
      expect(landing).toHaveBeenCalledWith(request(EVM_ACCOUNT), ['0xa']);
      await expect(withLanding.findLanding(request(SOLANA_ACCOUNT), ['sig'])).resolves.toBeNull();
    });

    it('routes a single redemption on the payer chain', async () => {
      solana.redeem.mockResolvedValue({ kind: RedeemOutcomeKind.REDEEMED });

      await redeemer.redeem(request(SOLANA_ACCOUNT));

      expect(solana.redeem).toHaveBeenCalled();
      expect(evm.redeem).not.toHaveBeenCalled();
    });

    it('refuses a batch spanning two namespaces, by name', async () => {
      // A batch is ONE transaction and a transaction is on one chain. Splitting
      // it here would return outcomes for two transactions under one call, and
      // the caller matches a hold to an outcome BY INDEX.
      await expect(
        redeemer.redeemBatch([request(SOLANA_ACCOUNT), request(EVM_ACCOUNT)]),
      ).rejects.toMatchObject({
        errorCode: ChainErrorCode.CHAIN_NAMESPACE_MISMATCH,
        // Both namespaces named: "a batch was mixed" is only actionable if it
        // says what it was mixed with.
        context: expect.objectContaining({ actual: expect.stringContaining('eip155') }),
      });

      expect(solana.redeemBatch).not.toHaveBeenCalled();
      expect(evm.redeemBatch).not.toHaveBeenCalled();
    });

    it('passes a single-namespace batch straight through', async () => {
      // The control: a redeemer that refused every batch passes the case above.
      await redeemer.redeemBatch([request(EVM_ACCOUNT)]);

      expect(evm.redeemBatch).toHaveBeenCalledTimes(1);
    });

    it('answers an empty batch without asking anybody', async () => {
      expect(await redeemer.redeemBatch([])).toEqual([]);
      expect(solana.redeemBatch).not.toHaveBeenCalled();
    });
  });

  // ── The escrow intent builder ────────────────────────────────────────────

  describe('NamespaceEscrowIntentBuilder', () => {
    const solana = {
      escrowAsset: jest.fn(),
      withdrawDelaySeconds: jest.fn(),
      buildIntent: jest.fn(),
    };
    const evm = {
      escrowAsset: jest.fn(),
      withdrawDelaySeconds: jest.fn(),
      buildIntent: jest.fn(),
    };
    const builder = new NamespaceEscrowIntentBuilder(
      new Map([
        [ChainNamespace.SOLANA, solana],
        [ChainNamespace.EIP155, evm],
      ]),
    );

    beforeEach(() => jest.resetAllMocks());

    it('routes buildIntent on the request account', async () => {
      evm.buildIntent.mockResolvedValue({ namespace: 'eip155' });

      await builder.buildIntent({
        kind: EscrowIntentKind.WITHDRAW,
        account: EVM_ACCOUNT,
        asset: USDG,
        amount: null,
        limits: null,
        destination: null,
      });

      expect(evm.buildIntent).toHaveBeenCalled();
      expect(solana.buildIntent).not.toHaveBeenCalled();
    });

    it('routes escrowAsset on the account', async () => {
      solana.escrowAsset.mockResolvedValue({ asset: USDC, decimals: 6 });

      await builder.escrowAsset(SOLANA_ACCOUNT);

      expect(solana.escrowAsset).toHaveBeenCalledWith(SOLANA_ACCOUNT);
      expect(evm.escrowAsset).not.toHaveBeenCalled();
    });

    it('refuses a bare withdrawDelaySeconds() — it is a per-chain constant', async () => {
      // The port's method takes no argument, which was answerable while one
      // chain existed and is not now: Solana reads `Config.withdraw_delay_
      // seconds` off the chain and EVM has a compile-time `3600` with no
      // getter. Answering with whichever implementation happened to be first
      // would put one chain's delay on the other chain's screen.
      // @ts-expect-error the port now REQUIRES a chain, which is the fix — this
      // line is the compile-time half of the assertion. The runtime half is that
      // it refuses rather than picking whichever implementation is first: no
      // implementation is reached at all.
      await expect(builder.withdrawDelaySeconds()).rejects.toThrow();
      expect(solana.withdrawDelaySeconds).not.toHaveBeenCalled();
      expect(evm.withdrawDelaySeconds).not.toHaveBeenCalled();
    });

    it('answers withdrawDelaySeconds for a NAMED chain', async () => {
      // The control, and the replacement: the multiplexer adds an overload the
      // port does not have, so a caller that knows its chain gets an answer.
      evm.withdrawDelaySeconds.mockResolvedValue(3600);

      expect(await builder.withdrawDelaySeconds(EVM)).toBe(3600);
      expect(solana.withdrawDelaySeconds).not.toHaveBeenCalled();
    });
  });
});
