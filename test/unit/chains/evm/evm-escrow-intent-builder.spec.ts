import { decodeFunctionData, hashTypedData, TypedDataDomain } from 'viem';

import {
  EVM_RELAYED_DEADLINE_MIN_WINDOW_SECONDS,
  EvmEscrowIntentBuilder,
  EvmEscrowIntentClient,
} from '@modules/chains/evm/evm-escrow-intent-builder.service';
import { EvmRpcError } from '@modules/chains/evm/sanctioned-evm-rpc';
import { X402_ESCROW_ABI } from '@modules/chains/evm/abi/x402.abi';
import { EVM_CONSTANTS } from '@modules/chains/evm/evm.constants';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { AccountId, CHAIN_IDS, ChainId, toAccountId } from '@modules/chains/ports/caip.types';
import {
  Eip155TypedDataRequest,
  Eip155UnsignedTransaction,
  UnsignedChainTransaction,
} from '@modules/chains/ports/unsigned-chain-transaction';
import {
  EscrowIntentKind,
  EscrowIntentRequest,
} from '@modules/settlement/ports/escrow-intent-builder.port';
import { ChainErrorCode } from '@modules/chains/errors/chains.errors';
import { MoneyUtil } from '@shared/utils/money.util';

import { expectErrorCodeAsync } from '../../helpers/expect-error-code';
import { deployment } from './evm-fixtures';

/**
 * `EvmEscrowIntentBuilder` — the three buyer-facing escrow doors on eip155,
 * and the shape difference between them that the union exists for.
 *
 * Two of the three are **signature requests** the platform relays; the third is
 * a transaction the buyer sends themselves and that the platform is
 * structurally unable to send for them. The assertions below are about which
 * is which, and about the ONE `authNonce` counter both signature requests draw
 * from.
 *
 * ## What the typed-data assertions are pinned against
 *
 * Never against the builder's own encoder. The digest is recomputed with
 * viem's `hashTypedData` over a hand-written domain and a hand-written field
 * list — the Solidity field order copied out of `assay-evm/src/Types.sol` — so a
 * reordering inside `eip712/` fails here instead of travelling silently into a
 * signature request.
 */
const TESTNET = CHAIN_IDS.ROBINHOOD_TESTNET;
const OTHER = CHAIN_IDS.BASE_SEPOLIA;
const DEPLOYMENT = deployment(TESTNET);

const BUYER = '0x5B38Da6a701c568545dCfcB03FcB875f56beddC4';
const BUYER_ACCOUNT = toAccountId(TESTNET, BUYER);
const USDG = ASSET_IDS.USDG_ROBINHOOD_TESTNET;

/** Fixed, so `deadline` is a number this file can name rather than observe. */
const NOW_MS = 1_800_000_000_000;
const NOW_SECONDS = NOW_MS / 1000;

/** `withdraw()` — the selector, computed by `cast sig` and pasted, not derived here. */
const WITHDRAW_SELECTOR = '0x3ccfd60b';

/** The all-zero `Escrow` struct a mapping returns for a buyer never touched. */
const ZERO_ESCROW = {
  balance: 0n,
  seqHigh: 0n,
  authNonce: 0n,
  maxVoucherAmount: 0n,
  maxPerWindow: 0n,
  spentInWindow: 0n,
  windowStartedAt: 0n,
  withdrawRequested: 0n,
  withdrawAvailableAt: 0n,
  totalRedeemed: 0n,
  totalWithdrawn: 0n,
  totalFunded: 0n,
};

/**
 * A buyer with a matured withdrawal standing.
 *
 * Every fixture below is spread from this and violates **exactly one** thing —
 * a fixture wrong in two ways passes its test for the wrong reason and would
 * still pass after the guard it names is deleted.
 */
const MATURED = {
  ...ZERO_ESCROW,
  balance: 5_000_000n,
  authNonce: 4n,
  withdrawRequested: 5_000_000n,
  withdrawAvailableAt: BigInt(NOW_SECONDS - 1),
  totalFunded: 5_000_000n,
};

function usdg(atomic: string) {
  return MoneyUtil.of(atomic, USDG, 6);
}

interface Harness {
  readonly builder: EvmEscrowIntentBuilder;
  readonly escrowOf: jest.Mock;
  readonly estimateGas: jest.Mock;
  readonly getBlock: jest.Mock;
}

/**
 * The chain's clock, separate from the server's.
 *
 * Defaulted to the same instant as `NOW_MS` so that every test written before
 * the two were distinguished still reads as "the clocks agree"; the tests that
 * are ABOUT the difference set it.
 */
interface ChainState {
  readonly chainSeconds?: number;
  /**
   * This PROCESS's clock, in seconds — the staleness detector's reference and
   * nothing else. Defaulted to the same instant as the chain's, so a test that
   * does not mention it is a test where the latest block was sealed just now.
   */
  readonly serverSeconds?: number;
  readonly estimateGas?: jest.Mock;
}

function build(escrow: Record<string, bigint> = MATURED, chain: ChainState = {}): Harness {
  const escrowOf = jest.fn().mockResolvedValue(escrow);
  const estimateGas = chain.estimateGas ?? jest.fn().mockResolvedValue(50_000n);
  const getBlock = jest.fn().mockResolvedValue({
    timestamp: BigInt(chain.chainSeconds ?? NOW_SECONDS),
  });

  const client: EvmEscrowIntentClient = {
    readContract: (args) => {
      if (args.functionName !== 'escrowOf') {
        throw new Error(`unexpected read of ${args.functionName}`);
      }
      return escrowOf(args) as Promise<unknown>;
    },
    getTransactionCount: async () => 7,
    estimateFeesPerGas: async () => ({ maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1n }),
    estimateGas: (args) => estimateGas(args) as Promise<bigint>,
    getBlock: (args) => getBlock(args) as Promise<{ timestamp: bigint }>,
  };

  const builder = new EvmEscrowIntentBuilder(
    new Map<ChainId, EvmEscrowIntentClient>([[TESTNET, client]]),
    new Map([[TESTNET, DEPLOYMENT]]),
    { now: () => (chain.serverSeconds ?? chain.chainSeconds ?? NOW_SECONDS) * 1000 },
  );
  return { builder, escrowOf, estimateGas, getBlock };
}

function request(overrides: Partial<EscrowIntentRequest> = {}): EscrowIntentRequest {
  return {
    kind: EscrowIntentKind.SET_LIMITS,
    account: BUYER_ACCOUNT,
    asset: USDG,
    amount: null,
    limits: { maxVoucherAmount: 1_000_000n, maxPerWindow: 20_000_000n },
    destination: null,
    ...overrides,
  };
}

/** The domain, written out by hand rather than imported. */
const DOMAIN: TypedDataDomain = {
  name: 'x402 Settlement',
  version: '2',
  chainId: 46630,
  verifyingContract: DEPLOYMENT.escrow,
};

function typedData(intent: UnsignedChainTransaction): Eip155TypedDataRequest {
  if (intent.kind !== 'typed-data') {
    throw new Error(`expected a typed-data intent, got ${intent.kind}`);
  }
  return intent;
}

/**
 * What `all-exceptions.filter.ts` reads off a thrown `BaseError`: `errorCode`
 * becomes the wire's `error.code` and `statusCode` becomes the HTTP status. Both
 * are `undefined` on a plain `Error`, which is the shape that reaches a buyer as
 * a 500.
 */
type AppFacingError = Error & { errorCode?: string; statusCode?: number };

function transaction(intent: UnsignedChainTransaction): Eip155UnsignedTransaction {
  if (intent.namespace !== 'eip155' || intent.kind !== 'transaction') {
    throw new Error(`expected an eip155 transaction, got ${intent.namespace}/${intent.kind}`);
  }
  return intent;
}

describe('EvmEscrowIntentBuilder', () => {
  it('SET_LIMITS is a SIGNATURE REQUEST, not a transaction', async () => {
    const { builder } = build();

    const intent = await builder.buildIntent(request());

    expect(intent).toEqual(
      expect.objectContaining({
        namespace: 'eip155',
        chainId: TESTNET,
        kind: 'typed-data',
        primaryType: 'SetLimits',
        relayed: true,
      }),
    );
    // A union with only a transaction member forces the frontend to
    // fabricate a transaction it must not send. These four are the fields that
    // would be there if this were one.
    expect(intent).not.toHaveProperty('data');
    expect(intent).not.toHaveProperty('to');
    expect(intent).not.toHaveProperty('gasLimit');
    expect(intent).not.toHaveProperty('nonce');
  });

  it('signs the SetLimits digest the contract will recover from', async () => {
    const { builder } = build();

    const intent = typedData(await builder.buildIntent(request()));

    // The independent source: viem's own hasher over a domain and a field list
    // written out here from `assay-evm/src/Types.sol`, not imported from `eip712/`.
    // The domain is held fixed on both sides — it is pinned field-by-field by
    // its own test below — so what this compares is the TYPES and the MESSAGE.
    expect(
      hashTypedData({
        domain: DOMAIN,
        types: intent.types,
        primaryType: intent.primaryType,
        message: intent.message,
      } as never),
    ).toBe(
      hashTypedData({
        domain: DOMAIN,
        types: {
          SetLimits: [
            { name: 'buyer', type: 'address' },
            { name: 'maxVoucherAmount', type: 'uint64' },
            { name: 'maxPerWindow', type: 'uint64' },
            { name: 'nonce', type: 'uint64' },
            { name: 'deadline', type: 'uint64' },
          ],
        },
        primaryType: 'SetLimits',
        message: {
          buyer: BUYER,
          maxVoucherAmount: 1_000_000n,
          maxPerWindow: 20_000_000n,
          nonce: 4n,
          deadline: BigInt(NOW_SECONDS + EVM_CONSTANTS.VOUCHER_MAX_LIFETIME_SECONDS),
        },
      }),
    );
  });

  it('REQUEST_WITHDRAW is a signature request carrying the CURRENT authNonce', async () => {
    const { builder } = build({ ...MATURED, authNonce: 9n });

    const intent = typedData(
      await builder.buildIntent(
        request({
          kind: EscrowIntentKind.REQUEST_WITHDRAW,
          amount: usdg('5000000'),
          limits: null,
        }),
      ),
    );

    expect(intent.primaryType).toBe('RequestWithdraw');
    expect(intent.message).toEqual(
      expect.objectContaining({ nonce: 9n, amount: 5_000_000n, buyer: BUYER }),
    );
  });

  it('the two BySig doors share ONE nonce counter', async () => {
    // `Escrow.authNonce` is one field. Two builders each keeping their own idea
    // of "my nonce" would produce a second signature that reverts BadNonce —
    // and it would revert only when both doors are used, which is rare enough
    // to reach production.
    const { builder } = build({ ...MATURED, authNonce: 4n });

    const limits = typedData(await builder.buildIntent(request()));
    const withdraw = typedData(
      await builder.buildIntent(
        request({
          kind: EscrowIntentKind.REQUEST_WITHDRAW,
          amount: usdg('1000000'),
          limits: null,
        }),
      ),
    );

    expect(limits.message.nonce).toBe(4n);
    expect(withdraw.message.nonce).toBe(4n);
  });

  it('deadlines both signature requests at now + 300, the widest a voucher lives', async () => {
    const { builder } = build();

    const limits = typedData(await builder.buildIntent(request()));
    const withdraw = typedData(
      await builder.buildIntent(
        request({ kind: EscrowIntentKind.REQUEST_WITHDRAW, amount: usdg('1'), limits: null }),
      ),
    );

    // A signature request that sat in a wallet window is refused rather than
    // replayed later.
    expect(limits.message.deadline).toBe(BigInt(NOW_SECONDS + 300));
    expect(withdraw.message.deadline).toBe(BigInt(NOW_SECONDS + 300));
    expect(EVM_CONSTANTS.VOUCHER_MAX_LIFETIME_SECONDS).toBe(300);
  });

  /*
    The deadline is a CHAIN quantity, and this is the test that says so.

    `X402Escrow._consumeAuth` refuses on `block.timestamp > deadline` — the
    chain's clock, exactly as `withdraw()` decides maturity on the chain's
    clock. A deadline stamped from `Date.now()` is therefore this process's
    opinion measured against somebody else's ruler, and the failure is not a
    boundary second: at 400 s of skew EVERY relayed request is born expired and
    BOTH `*BySig` doors are dead for every buyer, with nothing on this side
    reporting anything wrong. Measured live on a fork before the fix —
    `SignatureExpired`, and the same bytes SUCCESS the moment the two clocks were
    put back in step.

    This is an earlier fix's own ruling applied to the case it left behind: *"the wall
    clock is removed rather than widened … a wall clock never enters the
    contract's arithmetic at any point."*
  */
  it("deadlines both signature requests on the CHAIN's clock, not this process's", async () => {
    const CHAIN_AHEAD = NOW_SECONDS + 400;
    const { builder } = build(MATURED, { chainSeconds: CHAIN_AHEAD });

    const limits = typedData(await builder.buildIntent(request()));
    const withdraw = typedData(
      await builder.buildIntent(
        request({ kind: EscrowIntentKind.REQUEST_WITHDRAW, amount: usdg('1'), limits: null }),
      ),
    );

    expect(limits.message.deadline).toBe(BigInt(CHAIN_AHEAD + 300));
    expect(withdraw.message.deadline).toBe(BigInt(CHAIN_AHEAD + 300));
  });

  it('issues no signature request that the chain would refuse as already expired', async () => {
    // The property, stated as the contract states it, rather than as an
    // arithmetic identity: `_consumeAuth` reverts `SignatureExpired` when
    // `block.timestamp > deadline`, so a deadline at or below the chain's
    // current reading is a request nobody can ever land.
    for (const chainSeconds of [NOW_SECONDS - 400, NOW_SECONDS, NOW_SECONDS + 400]) {
      const { builder } = build(MATURED, { chainSeconds });

      for (const kind of [EscrowIntentKind.SET_LIMITS, EscrowIntentKind.REQUEST_WITHDRAW]) {
        const intent = typedData(
          await builder.buildIntent(
            kind === EscrowIntentKind.SET_LIMITS
              ? request()
              : request({ kind, amount: usdg('1'), limits: null }),
          ),
        );
        expect(intent.message.deadline).toBeGreaterThan(BigInt(chainSeconds));
      }
    }
  });

  /*
    ── The deadline is born against a block that may be old ────────────────

    `blockTag: 'latest'` is a LOWER bound on the timestamp of the block that
    includes the relayed call, and the whole window is 300 s. So the validity a
    buyer actually receives is `300 − (age of the latest block)`, and on a chain
    that has stopped producing blocks it is NEGATIVE: 2,001 s of staleness
    measured on the local fork, every request born 1,701 s expired, and the
    submit route reporting `SignatureExpired` for a signature made four seconds
    earlier.

    Measuring the age of a block is the one thing `block.timestamp` cannot do
    about itself, so these cases move the SERVER clock away from the chain's —
    the only reference there is. Nothing they assert changes what goes into a
    signed struct: the deadline is still `chainSeconds + 300` everywhere it is
    issued at all.
  */

  it("refuses to issue when the chain's latest block is too stale to sign against", async () => {
    // The measured fork reading, exactly: 2,001 s of staleness, which leaves
    // −1,701 s of validity.
    const stale = { chainSeconds: NOW_SECONDS - 2_001, serverSeconds: NOW_SECONDS };

    for (const kind of [EscrowIntentKind.SET_LIMITS, EscrowIntentKind.REQUEST_WITHDRAW]) {
      const { builder } = build(MATURED, stale);

      // The CODE, not merely "it threw": a `rejects.toThrow()` here passes on an
      // unsupported chain, a bad address and a `uint64` overflow alike.
      await expectErrorCodeAsync(
        () =>
          builder.buildIntent(
            kind === EscrowIntentKind.SET_LIMITS
              ? request()
              : request({ kind, amount: usdg('1'), limits: null }),
          ),
        ChainErrorCode.CHAIN_LATEST_BLOCK_STALE,
      );
    }
  });

  it('issues with exactly the minimum window still on the clock', async () => {
    // The control for the case above, and the boundary: `>` instead of `>=`
    // refuses a request that has its whole minute.
    const { builder } = build(MATURED, {
      chainSeconds: NOW_SECONDS - (300 - EVM_RELAYED_DEADLINE_MIN_WINDOW_SECONDS),
      serverSeconds: NOW_SECONDS,
    });

    const intent = typedData(await builder.buildIntent(request()));

    // Still `chainSeconds + 300`. The refusal is a gate on issuing, never an
    // adjustment to what is signed.
    expect(intent.message.deadline).toBe(
      BigInt(NOW_SECONDS + EVM_RELAYED_DEADLINE_MIN_WINDOW_SECONDS),
    );
  });

  it('refuses one second past that boundary', async () => {
    const { builder } = build(MATURED, {
      chainSeconds: NOW_SECONDS - (300 - EVM_RELAYED_DEADLINE_MIN_WINDOW_SECONDS) - 1,
      serverSeconds: NOW_SECONDS,
    });

    await expectErrorCodeAsync(
      () => builder.buildIntent(request()),
      ChainErrorCode.CHAIN_LATEST_BLOCK_STALE,
    );
  });

  it('does not refuse a chain whose clock runs AHEAD of this process', async () => {
    // The direction deliberately left unguarded. A chain ahead of this server
    // makes the window wider in wall time and no shorter in chain time, which is
    // the contract's own ruler; refusing there would be this process asserting
    // its clock over the chain's — the exact mistake being fixed.
    const { builder } = build(MATURED, {
      chainSeconds: NOW_SECONDS + 4_418,
      serverSeconds: NOW_SECONDS,
    });

    const intent = typedData(await builder.buildIntent(request()));

    expect(intent.message.deadline).toBe(BigInt(NOW_SECONDS + 4_418 + 300));
  });

  it("a stale chain does not block a buyer's WITHDRAW, which carries no deadline", async () => {
    /*
      The scope of the refusal, and the reason it lives at `deadline` rather
      than in `buildIntent`. `withdraw()` is a transaction the buyer sends
      themselves; it expires from nothing, and this domain's own rule is that a
      buyer's exit does not depend on the platform's cooperation. Refusing it
      because the chain looked idle would break that in the one situation where
      they most need it.
    */
    const chainSeconds = NOW_SECONDS - 2_001;
    const { builder } = build(
      { ...MATURED, withdrawAvailableAt: BigInt(chainSeconds - 1) },
      { chainSeconds, serverSeconds: NOW_SECONDS },
    );

    const intent = await builder.buildIntent(request({ kind: EscrowIntentKind.WITHDRAW }));

    expect(intent.kind).toBe('transaction');
  });

  it('names the escrow proxy as the verifyingContract, never the stake one', async () => {
    const { builder } = build();

    const intent = typedData(await builder.buildIntent(request()));

    // The two contracts share the domain name and version; this field is the
    // only thing separating them.
    expect(intent.domain.verifyingContract).toBe(DEPLOYMENT.escrow);
    expect(intent.domain.verifyingContract).not.toBe(DEPLOYMENT.stake);
    expect(intent.domain).toEqual({
      name: 'x402 Settlement',
      version: '2',
      chainId: '46630',
      verifyingContract: DEPLOYMENT.escrow,
    });
  });

  it('WITHDRAW is a TRANSACTION the buyer sends themselves, with no signature request', async () => {
    const { builder } = build();

    const intent = transaction(
      await builder.buildIntent(request({ kind: EscrowIntentKind.WITHDRAW })),
    );

    expect(intent).toEqual(
      expect.objectContaining({ namespace: 'eip155', kind: 'transaction', value: '0' }),
    );
    expect(intent.data).toBe(WITHDRAW_SELECTOR);
    expect(intent.from).toBe(BUYER);
    expect(intent.to).toBe(DEPLOYMENT.escrow);
    // Decoded through a different path than the one that built it.
    expect(
      decodeFunctionData({ abi: X402_ESCROW_ABI, data: intent.data as `0x${string}` }),
    ).toEqual({ functionName: 'withdraw', args: undefined });
  });

  it('gives WITHDRAW a 20 % margin over the estimate, and a nonce that is not a blockhash', async () => {
    const { builder, estimateGas } = build();

    const intent = transaction(
      await builder.buildIntent(request({ kind: EscrowIntentKind.WITHDRAW })),
    );

    expect(estimateGas).toHaveBeenCalled();
    expect(intent.gasLimit).toBe('60000');
    expect(intent.nonce).toBe('7');
    expect(intent.maxFeePerGas).toBe('1000000000');
    expect(intent.maxPriorityFeePerGas).toBe('1');
  });

  it('there is no withdrawBySig, and asking for one is refused by name', () => {
    // `requestWithdraw` already served the 1-hour delay, so by the time
    // `withdraw` is callable the delay is spent and a phished signature would
    // drain the escrow with no remaining brake. Requiring the buyer's own
    // transaction means an attacker needs the address itself.
    //
    // `Object.keys` alone would pass on ANY class — methods live on the
    // prototype — so the prototype chain is walked as well.
    const { builder } = build();
    const names = new Set<string>(Object.keys(builder));
    for (
      let proto: object | null = Object.getPrototypeOf(builder) as object | null;
      proto && proto !== Object.prototype;
      proto = Object.getPrototypeOf(proto) as object | null
    ) {
      for (const name of Object.getOwnPropertyNames(proto)) {
        names.add(name);
      }
    }

    expect([...names]).toContain('buildIntent');
    expect([...names].filter((n) => /withdrawBySig/i.test(n))).toEqual([]);
  });

  it('refuses WITHDRAW before the request has matured, naming when it will', async () => {
    const { builder } = build({
      ...MATURED,
      withdrawAvailableAt: BigInt(NOW_SECONDS + 600),
    });

    await expect(builder.buildIntent(request({ kind: EscrowIntentKind.WITHDRAW }))).rejects.toThrow(
      /available/i,
    );
  });

  it('refuses WITHDRAW when nothing was requested, and allows it when something was', async () => {
    // The positive control for the test above: without it, "refuses" is
    // satisfied by a builder that refuses always.
    const nothing = build({ ...MATURED, withdrawRequested: 0n });
    await expect(
      nothing.builder.buildIntent(request({ kind: EscrowIntentKind.WITHDRAW })),
    ).rejects.toThrow(/withdrawal/i);

    const matured = build(MATURED);
    await expect(
      matured.builder.buildIntent(request({ kind: EscrowIntentKind.WITHDRAW })),
    ).resolves.toBeDefined();
  });

  /**
   * The maturity boundary, where the server's clock and the chain's disagree.
   *
   * `X402Escrow.withdraw()` is `if (block.timestamp < e.withdrawAvailableAt)
   * revert WithdrawNotYetAvailable()` — the CHAIN's clock, and nothing else. A
   * check written against `Date.now()` is systematically ahead of it (the latest
   * block's timestamp stops advancing the moment it is sealed), so for about one
   * block after `withdrawAvailableAt` the server believes a withdrawal is legal
   * and the chain still refuses it. That window used to answer **500**: the
   * wall-clock check passed, `estimateGas` reverted, and an unhandled RPC error
   * reached a buyer who had waited out the whole hour and clicked at the first
   * legal instant.
   *
   * Every assertion below names the status AND the code. "not a 500" is
   * satisfied by any 4xx at all, including a wrong one.
   */
  describe('the maturity boundary, where the two clocks disagree', () => {
    /** Matured by the SERVER's clock, to the second — the old check passes here. */
    const AT_THE_BOUNDARY = { ...MATURED, withdrawAvailableAt: BigInt(NOW_SECONDS) };

    /**
     * `cast sig`, copied from the table `abi-selectors.spec.ts` pins — not
     * recomputed here with the same keccak the production code uses.
     */
    const WITHDRAW_NOT_YET_AVAILABLE = '0x27aa2f48';
    const NO_WITHDRAW_REQUESTED = '0x37c59471';
    const ESCROW_INSUFFICIENT = '0x71de3750';

    /**
     * What the transport really throws, wrapped the way viem wraps it: an
     * `EvmRpcError` carrying the selector, inside viem's `ExecutionRevertedError`,
     * inside its `EstimateGasExecutionError`. The mapping walks a `cause` chain,
     * so a test that handed it a bare error would prove the walk works at depth
     * one and nothing about the shape that actually arrives.
     */
    function revertingEstimate(selector: string): { estimateGas: jest.Mock; thrown: Error } {
      const raw = new EvmRpcError('EVM RPC eth_estimateGas failed: code 3', {
        code: 3,
        data: selector as `0x${string}`,
      });
      const reverted = Object.assign(new Error('Execution reverted for an unknown reason.'), {
        cause: raw,
      });
      const thrown = Object.assign(new Error('An unknown RPC error occurred.'), {
        cause: reverted,
      });
      return { estimateGas: jest.fn().mockRejectedValue(thrown), thrown };
    }

    async function caught(run: () => Promise<unknown>): Promise<AppFacingError> {
      try {
        await run();
      } catch (error) {
        return error as AppFacingError;
      }
      // Not `fail()`: a helper that returns `undefined` when the call SUCCEEDS
      // makes every assertion below vacuous.
      throw new Error('expected the builder to refuse, and it returned an intent');
    }

    it('refuses with the maturity 409 when the CHAIN is one second short of it', async () => {
      // The server says matured (`NOW_SECONDS >= withdrawAvailableAt`); the chain
      // has not got there. This is the whole defect, in one fixture.
      const { builder, estimateGas } = build(AT_THE_BOUNDARY, { chainSeconds: NOW_SECONDS - 1 });

      const error = await caught(() =>
        builder.buildIntent(request({ kind: EscrowIntentKind.WITHDRAW })),
      );

      expect(error.statusCode).toBe(409);
      expect(error.errorCode).toBe('SETTLEMENT_WITHDRAWAL_NOT_YET_AVAILABLE');
      expect(error.message).toMatch(/No withdrawal is available yet \(available at /);
      // And it never asked the chain to price a call it knew would revert.
      expect(estimateGas).not.toHaveBeenCalled();
    });

    it('allows it the instant the chain REACHES withdrawAvailableAt, equality included', async () => {
      // The positive control, and the contract's own boundary: `withdraw()`
      // reverts on `block.timestamp < availableAt`, so equality is legal. A gate
      // that refused here would be a second bug wearing the fix's name, and one
      // that refuses always would pass the test above on its own.
      const { builder } = build(AT_THE_BOUNDARY, { chainSeconds: NOW_SECONDS });

      await expect(
        builder.buildIntent(request({ kind: EscrowIntentKind.WITHDRAW })),
      ).resolves.toBeDefined();
    });

    it('allows it when the CHAIN has matured and the server clock is behind', async () => {
      // The mirror of the defect. The old check refused here — telling a buyer
      // to wait for a delay the contract had already served — and the chain is
      // the authority in both directions.
      const { builder } = build(
        { ...MATURED, withdrawAvailableAt: BigInt(NOW_SECONDS + 600) },
        { chainSeconds: NOW_SECONDS + 601 },
      );

      await expect(
        builder.buildIntent(request({ kind: EscrowIntentKind.WITHDRAW })),
      ).resolves.toBeDefined();
    });

    it('maps a WithdrawNotYetAvailable revert to the SAME 409, for the block mined mid-request', async () => {
      // The gate above reads one block; the estimate runs against another. A
      // block mined between the two calls — or two nodes behind one load
      // balancer at different heights — puts the revert back on the table, and
      // this is the layer that hears it.
      const { builder } = build(AT_THE_BOUNDARY, {
        chainSeconds: NOW_SECONDS,
        estimateGas: revertingEstimate(WITHDRAW_NOT_YET_AVAILABLE).estimateGas,
      });

      const error = await caught(() =>
        builder.buildIntent(request({ kind: EscrowIntentKind.WITHDRAW })),
      );

      expect(error.statusCode).toBe(409);
      expect(error.errorCode).toBe('SETTLEMENT_WITHDRAWAL_NOT_YET_AVAILABLE');
    });

    it('maps a NoWithdrawRequested revert to the same 409, with no maturity instant to quote', async () => {
      const { builder } = build(AT_THE_BOUNDARY, {
        chainSeconds: NOW_SECONDS,
        estimateGas: revertingEstimate(NO_WITHDRAW_REQUESTED).estimateGas,
      });

      const error = await caught(() =>
        builder.buildIntent(request({ kind: EscrowIntentKind.WITHDRAW })),
      );

      expect(error.statusCode).toBe(409);
      expect(error.errorCode).toBe('SETTLEMENT_WITHDRAWAL_NOT_YET_AVAILABLE');
      // The request is gone, so there is no `availableAt` — and quoting the
      // stale one would tell the buyer to wait for an instant that has passed.
      expect(error.message).toBe('No withdrawal is available yet');
    });

    it('leaves EVERY OTHER revert alone, so "wait a moment" is never the answer to an empty escrow', async () => {
      // The degenerate this whole describe exists to kill: a handler that maps
      // any revert to the maturity 409 passes both mapping tests above and tells
      // a buyer whose escrow is EMPTY that their money is a moment away.
      const { estimateGas, thrown } = revertingEstimate(ESCROW_INSUFFICIENT);
      const { builder } = build(AT_THE_BOUNDARY, { chainSeconds: NOW_SECONDS, estimateGas });

      const error = await caught(() =>
        builder.buildIntent(request({ kind: EscrowIntentKind.WITHDRAW })),
      );

      expect(error.errorCode).toBeUndefined();
      expect(error.statusCode).toBeUndefined();
      // The very object the transport threw, not a translation of it.
      expect(error).toBe(thrown);
    });

    it('leaves a transport failure carrying no revert data alone', async () => {
      // `UNKNOWN_REVERT:none` is not a maturity refusal. An HTTP 502 from the
      // node is an operational fault and must keep saying so.
      const thrown = new Error('EVM RPC eth_estimateGas failed: HTTP 502');
      const { builder } = build(AT_THE_BOUNDARY, {
        chainSeconds: NOW_SECONDS,
        estimateGas: jest.fn().mockRejectedValue(thrown),
      });

      const error = await caught(() =>
        builder.buildIntent(request({ kind: EscrowIntentKind.WITHDRAW })),
      );

      expect(error).toBe(thrown);
      expect(error.errorCode).toBeUndefined();
    });
  });

  it('refuses a WITHDRAW aimed anywhere but the buyer, because the chain cannot aim it', async () => {
    // `withdraw()` is `msg.sender`-only, pays `msg.sender` and takes NO
    // destination. Accepting a destination and quietly ignoring it would hand a
    // caller a transaction that pays somebody other than the party they named.
    const { builder } = build();

    await expect(
      builder.buildIntent(
        request({
          kind: EscrowIntentKind.WITHDRAW,
          destination: toAccountId(TESTNET, '0x0000000000000000000000000000000000000009'),
        }),
      ),
    ).rejects.toThrow(/destination/i);

    // The control: the buyer's OWN account is not a redirection and is allowed.
    await expect(
      builder.buildIntent(request({ kind: EscrowIntentKind.WITHDRAW, destination: BUYER_ACCOUNT })),
    ).resolves.toBeDefined();
  });

  it('reads the escrow ONCE per call', async () => {
    const { builder, escrowOf } = build();

    await builder.buildIntent(request({ kind: EscrowIntentKind.WITHDRAW }));

    expect(escrowOf).toHaveBeenCalledTimes(1);
  });

  it('refuses an account on a chain this builder does not serve', async () => {
    const { builder } = build();

    await expect(
      builder.buildIntent(request({ account: toAccountId(OTHER, BUYER) })),
    ).rejects.toThrow(/eip155:84532/);
  });

  it('refuses a mixed-case address whose EIP-55 checksum does not verify', async () => {
    // The reading door is strict too. viem's non-strict `getAddress` REPAIRS a
    // broken checksum downstream, so a door that only parses CAIP-10 grammar
    // builds a signature request for an address nobody verified.
    const { builder } = build();
    const typo = `${BUYER.slice(0, -1)}5`;

    await expect(
      builder.buildIntent(request({ account: `${TESTNET}:${typo}` as AccountId })),
    ).rejects.toThrow(/address/i);
  });

  it('refuses an amount that does not fit the uint64 the contract declares', async () => {
    const { builder } = build();
    // Built as a literal, NOT through `MoneyUtil.of`: `MONEY_MAX_ATOMIC_UNITS`
    // is already `2^64 - 1`, so the factory would refuse this before the
    // builder ever saw it and the assertion below would be about MoneyUtil.
    const tooBig = { amount: (2n ** 64n).toString(), asset: USDG, decimals: 6 };

    await expect(
      builder.buildIntent(
        request({
          kind: EscrowIntentKind.REQUEST_WITHDRAW,
          amount: tooBig,
          limits: null,
        }),
      ),
    ).rejects.toThrow(/uint64/i);

    // The control: the ceiling itself encodes.
    await expect(
      builder.buildIntent(
        request({
          kind: EscrowIntentKind.REQUEST_WITHDRAW,
          amount: usdg((2n ** 64n - 1n).toString()),
          limits: null,
        }),
      ),
    ).resolves.toBeDefined();
  });

  it('refuses a SET_LIMITS whose ceilings do not fit uint64 either', async () => {
    const { builder } = build();

    await expect(
      builder.buildIntent(request({ limits: { maxVoucherAmount: 2n ** 64n, maxPerWindow: 1n } })),
    ).rejects.toThrow(/uint64/i);
    await expect(
      builder.buildIntent(request({ limits: { maxVoucherAmount: 1n, maxPerWindow: 2n ** 64n } })),
    ).rejects.toThrow(/uint64/i);
  });

  it('reports the escrow asset from the REGISTRY, never decimals() off the token', async () => {
    const { builder } = build();

    await expect(builder.escrowAsset(BUYER_ACCOUNT)).resolves.toEqual({
      asset: USDG,
      decimals: 6,
    });
  });

  it('carries the contract constant for the withdraw delay', async () => {
    const { builder } = build();

    // The port's method takes the chain, because the delay is a
    // per-chain quantity: read off `Config` on Solana, a compile-time constant
    // in `Constants.sol` here with no getter at all.
    await expect(builder.withdrawDelaySeconds(TESTNET)).resolves.toBe(3_600);
    expect(EVM_CONSTANTS.WITHDRAW_DELAY_SECONDS).toBe(3_600);
  });

  it('refuses a withdraw delay for a chain this builder does not serve', async () => {
    // The control for the case above, and the reason the parameter exists: a
    // builder that ignored it would answer 3,600 for Solana too.
    const { builder } = build();

    await expect(builder.withdrawDelaySeconds(CHAIN_IDS.SOLANA_DEVNET)).rejects.toThrow();
  });

  it('refuses a SET_LIMITS with no limits and a REQUEST_WITHDRAW with no amount', async () => {
    const { builder } = build();

    await expect(builder.buildIntent(request({ limits: null }))).rejects.toThrow(/limits/i);
    await expect(
      builder.buildIntent(
        request({ kind: EscrowIntentKind.REQUEST_WITHDRAW, amount: null, limits: null }),
      ),
    ).rejects.toThrow(/amount/i);
  });
});

describe('EvmEscrowIntentBuilder — the on-chain pause and blocklist gate (D-19)', () => {
  it('asks the gate with the door each kind opens, and refuses before any read', async () => {
    const doors: string[] = [];
    const gate = {
      assertActive: async (door: string) => {
        doors.push(door);
        if (door === 'WITHDRAW') throw new Error('CHAIN_PROGRAM_PAUSED');
      },
      holdReason: async () => null,
    };
    const { escrowOf } = build();
    const builder = new EvmEscrowIntentBuilder(
      new Map([[TESTNET, { readContract: escrowOf } as never]]),
      new Map([[TESTNET, DEPLOYMENT]]),
      { now: () => NOW_SECONDS * 1000 },
      gate as never,
    );
    await expect(
      builder.buildIntent(request({ kind: EscrowIntentKind.REQUEST_WITHDRAW, amount: null })),
    ).rejects.toThrow(/PAUSED/);
    expect(doors).toEqual(['WITHDRAW']);
    expect(escrowOf).not.toHaveBeenCalled();
  });
});
