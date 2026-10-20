import {
  findAssociatedTokenPda,
  getTokenEncoder,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import { Address, address, getAddressDecoder } from '@solana/kit';
import { findEscrowPda, getBuyerEscrowEncoder } from '@assay/settlement-client';

import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { AccountId, CHAIN_IDS, parseAssetId } from '@modules/chains/ports/caip.types';
import {
  EscrowBalanceRpcClient,
  SolanaEscrowBalanceReader,
} from '@modules/chains/solana/escrow-balance-reader.service';
import { PaymentErrorCode } from '@modules/payment/errors/payment.errors';

import { expectErrorCodeAsync } from '../../helpers/expect-error-code';

const SOLANA_MAINNET = CHAIN_IDS.SOLANA_MAINNET;
const USDC = ASSET_IDS.USDC_SOLANA_MAINNET;
const USDC_MINT = parseAssetId(USDC).assetReference;
const PROGRAM_ADDRESS = address('DbHEzzA6CwKRY9xLGSzDgqei7VmnHpF6YociozaN8qFR');
const BUYER_PUBKEY = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const BUYER_ACCOUNT: AccountId = `${SOLANA_MAINNET}:${BUYER_PUBKEY}` as AccountId;

/** A controllable clock, injected as `config.now`. */
class FakeClock {
  private ms = 1_700_000_000_000;
  now = (): number => this.ms;
  advance(ms: number): void {
    this.ms += ms;
  }
}

/** A minimal in-memory fake of the one RPC call the reader uses. */
class FakeRpc implements EscrowBalanceRpcClient {
  accounts = new Map<string, string>();
  calls = 0;
  private failure: Error | null = null;

  async escrowPda(buyer: string): Promise<Address> {
    const [pda] = await findEscrowPda(
      { buyer: address(buyer) },
      { programAddress: PROGRAM_ADDRESS },
    );
    return pda;
  }

  async escrowAta(buyer: string): Promise<Address> {
    const pda = await this.escrowPda(buyer);
    const [ata] = await findAssociatedTokenPda({
      owner: pda,
      mint: address(USDC_MINT),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    return ata;
  }

  async setEscrow(
    buyer: string,
    fields: Partial<{
      seqHigh: bigint;
      withdrawRequested: bigint;
      withdrawAvailableAt: bigint;
      maxVoucherAmount: bigint;
      maxPerWindow: bigint;
      spentInWindow: bigint;
      windowStartedAt: bigint;
      lastRedeemAt: bigint;
    }>,
  ): Promise<void> {
    const pda = await this.escrowPda(buyer);
    const bytes = getBuyerEscrowEncoder().encode({
      buyer: address(buyer),
      seqHigh: fields.seqHigh ?? 0n,
      withdrawRequested: fields.withdrawRequested ?? 0n,
      withdrawAvailableAt: fields.withdrawAvailableAt ?? 0n,
      totalRedeemed: 0n,
      totalWithdrawn: 0n,
      maxVoucherAmount: fields.maxVoucherAmount ?? 1_000_000_000n,
      maxPerWindow: fields.maxPerWindow ?? 1_000_000_000n,
      spentInWindow: fields.spentInWindow ?? 0n,
      windowStartedAt: fields.windowStartedAt ?? 0n,
      bump: 255,
      reserved: new Uint8Array(32),
    });
    this.accounts.set(pda as unknown as string, Buffer.from(bytes).toString('base64'));
  }

  async setTokenAccount(account: Address, amount: bigint): Promise<void> {
    const bytes = getTokenEncoder().encode({
      mint: address(USDC_MINT),
      owner: account,
      amount,
      delegate: { __option: 'None' },
      state: 1,
      isNative: { __option: 'None' },
      delegatedAmount: 0n,
      closeAuthority: { __option: 'None' },
    });
    this.accounts.set(account as unknown as string, Buffer.from(bytes).toString('base64'));
  }

  failEveryCall(error: Error): void {
    this.failure = error;
  }

  getMultipleAccounts(accounts: readonly Address[]) {
    this.calls += 1;
    return {
      send: async () => {
        if (this.failure) {
          throw this.failure;
        }
        return {
          value: accounts.map((account) => {
            const data = this.accounts.get(account as unknown as string);
            return data ? { data: [data, 'base64'] as const } : null;
          }),
        };
      },
    };
  }
}

function harness() {
  const rpc = new FakeRpc();
  const clock = new FakeClock();
  const reader = new SolanaEscrowBalanceReader(rpc, PROGRAM_ADDRESS as unknown as string, {
    freshTtlMs: 10_000,
    staleMaxMs: 60_000,
    now: clock.now,
  });
  return { reader, rpc, clock };
}

describe('SolanaEscrowBalanceReader', () => {
  it('reports the escrow token account’s amount, not the escrow account’s', async () => {
    const { reader, rpc } = harness();
    await rpc.setEscrow(BUYER_PUBKEY, { seqHigh: 12n, withdrawRequested: 0n });
    const ata = await rpc.escrowAta(BUYER_PUBKEY);
    await rpc.setTokenAccount(ata, 7_500_000n);

    const reading = await reader.read(BUYER_ACCOUNT, USDC);

    expect(reading?.balance.amount).toBe('7500000');
    expect(reading?.seqHigh).toBe(12n);
  });

  it('surfaces the window meter and the close-quarantine clock too', async () => {
    // `EscrowAccountService` publishes the buyer's own brake and the
    // close-quarantine clock — both come off the SAME decode this reader
    // already does for `balance`, so they cost nothing extra to carry.
    const { reader, rpc } = harness();
    await rpc.setEscrow(BUYER_PUBKEY, {
      maxPerWindow: 500_000_000n,
      spentInWindow: 125_000_000n,
      windowStartedAt: 1_700_000_000n,
    });
    const ata = await rpc.escrowAta(BUYER_PUBKEY);
    await rpc.setTokenAccount(ata, 0n);

    const reading = await reader.read(BUYER_ACCOUNT, USDC);

    expect(reading?.maxPerWindow).toBe(500_000_000n);
    expect(reading?.spentInWindow).toBe(125_000_000n);
    expect(reading?.windowStartedAt).toBe(1_700_000_000);
  });

  it('returns null when the buyer has no escrow, and null is not zero', async () => {
    const { reader } = harness();
    await expect(reader.read(BUYER_ACCOUNT, USDC)).resolves.toBeNull();
  });

  it('serves a cached reading for ten seconds without touching the RPC', async () => {
    const { reader, rpc, clock } = harness();
    await rpc.setEscrow(BUYER_PUBKEY, { seqHigh: 1n, withdrawRequested: 0n });
    const ata = await rpc.escrowAta(BUYER_PUBKEY);
    await rpc.setTokenAccount(ata, 1_000_000n);

    await reader.read(BUYER_ACCOUNT, USDC);
    const callsAfterFirst = rpc.calls;
    clock.advance(9_999);
    await reader.read(BUYER_ACCOUNT, USDC);

    expect(rpc.calls).toBe(callsAfterFirst);
  });

  it('refreshes in the background between 10s and 60s, but still serves the cached figure', async () => {
    const { reader, rpc, clock } = harness();
    await rpc.setEscrow(BUYER_PUBKEY, { seqHigh: 1n, withdrawRequested: 0n });
    const ata = await rpc.escrowAta(BUYER_PUBKEY);
    await rpc.setTokenAccount(ata, 1_000_000n);
    await reader.read(BUYER_ACCOUNT, USDC);

    clock.advance(11_000); // stale, not yet past the ceiling
    const reading = await reader.read(BUYER_ACCOUNT, USDC);
    expect(reading?.balance.amount).toBe('1000000');

    // The refresh runs in the background, behind PDA derivation that itself
    // awaits — a real macrotask tick is what actually lets it land, not just
    // a microtask flush.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(rpc.calls).toBeGreaterThan(1);
  });

  it('THROWS rather than degrading once the last reading is more than a minute old', async () => {
    // Fail closed. The mirror is a lagging copy by construction, so spending
    // against it is spending money that may already have left the escrow.
    const { reader, rpc, clock } = harness();
    await rpc.setEscrow(BUYER_PUBKEY, { seqHigh: 1n, withdrawRequested: 0n });
    const ata = await rpc.escrowAta(BUYER_PUBKEY);
    await rpc.setTokenAccount(ata, 1_000_000n);
    await reader.read(BUYER_ACCOUNT, USDC);

    rpc.failEveryCall(new Error('rpc timeout'));
    clock.advance(30_000);
    await expect(reader.read(BUYER_ACCOUNT, USDC)).resolves.toMatchObject({
      balance: expect.objectContaining({ amount: '1000000' }),
    });

    clock.advance(31_000); // now 61s since the successful read
    await expectErrorCodeAsync(
      () => reader.read(BUYER_ACCOUNT, USDC),
      PaymentErrorCode.PAYMENT_ESCROW_BALANCE_UNAVAILABLE,
    );
  });

  it('never touches the ledger and is keyed per buyer — one unreadable account does not blind another', async () => {
    const { reader, rpc } = harness();
    const other = `${SOLANA_MAINNET}:5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1` as AccountId;

    await rpc.setEscrow(BUYER_PUBKEY, { seqHigh: 1n });
    const ata = await rpc.escrowAta(BUYER_PUBKEY);
    await rpc.setTokenAccount(ata, 1_000_000n);

    await expect(reader.read(BUYER_ACCOUNT, USDC)).resolves.toMatchObject({
      balance: expect.objectContaining({ amount: '1000000' }),
    });
    // The other account has no escrow at all — reported as null, not as an
    // error that could be confused with the first account's own state.
    await expect(reader.read(other, USDC)).resolves.toBeNull();
  });
});

describe('SolanaEscrowBalanceReader.readMany — batched, because the reconciler pays for it', () => {
  /**
   * `getMultipleAccounts` batching is the mitigation that makes
   * failing closed affordable: without it the reconciler is one RPC round trip
   * per buyer, on every five-minute tick, forever.
   */
  function buyerAt(seed: number): { pubkey: string; account: AccountId } {
    const pubkey = getAddressDecoder().decode(
      new Uint8Array(32).fill(seed % 251 === 0 ? 251 : seed % 251),
    ) as unknown as string;
    return { pubkey, account: `${SOLANA_MAINNET}:${pubkey}` as AccountId };
  }

  it('reads 60 buyers in two calls, not sixty — two addresses per escrow, 100 per call', async () => {
    const { reader, rpc } = harness();
    const buyers = Array.from({ length: 60 }, (_unused, index) => buyerAt(index + 1));

    for (const buyer of buyers) {
      await rpc.setEscrow(buyer.pubkey, {});
      await rpc.setTokenAccount(await rpc.escrowAta(buyer.pubkey), 1_000n);
    }
    rpc.calls = 0;

    const readings = await reader.readMany(
      buyers.map((buyer) => buyer.account),
      USDC,
    );

    expect(readings.size).toBe(60);
    // 120 addresses / 100 per call, and a pair is never split across two calls
    // — so 50 buyers per call, and 60 buyers is two.
    expect(rpc.calls).toBe(2);
  });

  it('maps an unopened escrow to null (read, nothing there) rather than leaving it out', async () => {
    const { reader, rpc } = harness();
    const opened = buyerAt(3);
    const never = buyerAt(4);
    await rpc.setEscrow(opened.pubkey, {});
    await rpc.setTokenAccount(await rpc.escrowAta(opened.pubkey), 5n);

    const readings = await reader.readMany([opened.account, never.account], USDC);

    expect(readings.get(opened.account)).toBeTruthy();
    // Present with `null`: absence from the map is reserved for a failed read.
    expect(readings.has(never.account)).toBe(true);
    expect(readings.get(never.account)).toBeNull();
  });

  it('skips a failed batch instead of taking the whole pass down', async () => {
    const { reader, rpc } = harness();
    const buyer = buyerAt(5);
    await rpc.setEscrow(buyer.pubkey, {});
    rpc.failEveryCall(new Error('RPC timeout'));

    await expect(reader.readMany([buyer.account], USDC)).resolves.toEqual(new Map());
  });

  it('fills the cache the paying path reads from, so the walk is not paid for twice', async () => {
    const { reader, rpc } = harness();
    const buyer = buyerAt(6);
    await rpc.setEscrow(buyer.pubkey, { seqHigh: 9n });
    await rpc.setTokenAccount(await rpc.escrowAta(buyer.pubkey), 42n);

    await reader.readMany([buyer.account], USDC);
    const callsAfterWalk = rpc.calls;

    const reading = await reader.read(buyer.account, USDC);

    expect(reading?.seqHigh).toBe(9n);
    expect(rpc.calls).toBe(callsAfterWalk);
  });
});
