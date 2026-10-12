import { Injectable } from '@nestjs/common';
import { encodeFunctionData, getAddress, isAddress, TypedDataDomain } from 'viem';

import { SettlementErrors } from '@modules/settlement/errors/settlement.errors';
import {
  DelegationTerms,
  EscrowDelegation,
  EscrowDelegationPort,
  EscrowDelegationStatus,
} from '@modules/settlement/ports/escrow-delegation.port';
import {
  EscrowIntentBuilderPort,
  EscrowIntentKind,
  EscrowIntentRequest,
} from '@modules/settlement/ports/escrow-intent-builder.port';
import { MoneyUtil } from '@shared/utils/money.util';

import { ChainErrors } from '../errors/chains.errors';
import { getAssetMetadata } from '../ports/asset-registry';
import {
  AccountId,
  AssetId,
  ChainId,
  parseAccountId,
  toAccountId,
  toAssetId,
} from '../ports/caip.types';
import { EscrowLimits } from '../ports/escrow.types';
import { Eip712Domain, UnsignedChainTransaction } from '../ports/unsigned-chain-transaction';
import { evmErrorName, revertDataOf } from './abi/error-selectors';
import { X402_ESCROW_ABI } from './abi/x402.abi';
import { evmDomain } from './eip712/domain';
import { authorizeDelegateTypedData, revokeDelegateTypedData } from './eip712/delegation';
import { requestWithdrawTypedData, setLimitsTypedData } from './eip712/escrow-control';
import { decayWindow } from './evm-voucher-prevalidation';
import { isRevert } from './evm-voucher-authority';
import { EVM_CONSTANTS, EvmDeployment } from './evm.constants';

/**
 * The `Escrow` struct as `escrowOf` returns it. Only the five fields this
 * builder reads are named; the decode carries all twelve.
 */
export interface EvmEscrowRead {
  readonly authNonce: bigint;
  readonly maxVoucherAmount?: bigint;
  readonly maxPerWindow?: bigint;
  readonly withdrawRequested: bigint;
  readonly withdrawAvailableAt: bigint;
}

/**
 * The slice of a JSON-RPC client this builder uses — **four read calls and no
 * send**.
 *
 * That absence is the same structural guarantee `SolanaEscrowIntentBuilder`
 * makes with its two-method RPC interface: a class that cannot reach a
 * `sendRawTransaction` cannot acquire the capability by accident, and a
 * reviewer does not have to establish that nobody did.
 */
export interface EvmEscrowIntentClient {
  readContract(args: {
    address: `0x${string}`;
    abi: unknown;
    functionName: string;
    args: readonly unknown[];
  }): Promise<unknown>;
  getTransactionCount(args: { address: `0x${string}`; blockTag: 'pending' }): Promise<number>;
  estimateFeesPerGas(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
  estimateGas(args: {
    account: `0x${string}`;
    to: `0x${string}`;
    data: `0x${string}`;
    value: bigint;
  }): Promise<bigint>;
  /**
   * The chain's own clock. `X402Escrow.withdraw()` compares
   * `block.timestamp` — not this process's — against `withdrawAvailableAt`,
   * so the maturity decision has to be made against the same reading.
   */
  getBlock(args: { blockTag: 'latest' }): Promise<{ timestamp: bigint }>;
}

/** Every amount argument on `X402Escrow` is a `uint64`. */
const MAX_UINT64 = 2n ** 64n - 1n;

/** `X402Escrow.Delegation`, as `delegationOf` returns it. */
interface EvmDelegationRead {
  readonly maxVoucherAmount: bigint;
  readonly maxPerWindow: bigint;
  readonly spentInWindow: bigint;
  readonly windowStartedAt: bigint;
  readonly validUntil: bigint;
  readonly listPosition: number;
  readonly revoked: boolean;
}

/**
 * How much of a `*BySig` deadline must still be usable when it is issued.
 *
 * The deadline is `latest.timestamp + VOUCHER_MAX_LIFETIME_SECONDS` and the
 * contract judges it against the block that **includes** the relayed call, not
 * against the latest block at signing time. So the window a buyer actually gets
 * is `300 − (age of the latest block)`, and on a chain that has stopped
 * producing blocks it goes negative: 2,001 s of staleness measured on the local
 * fork, every issued request born 1,701 s expired, and the route answering
 * `SignatureExpired` for a signature made four seconds earlier. Nothing on the
 * issuing side reported anything wrong.
 *
 * **60 s, and what it is a floor on.** The window is not consumed by this
 * process — the encode is microseconds and the pre-flight is one round trip. It
 * is consumed by the buyer: a wallet prompt has to be read and approved. A
 * minute is the smallest window in which that is a request rather than a race,
 * and it puts the refusal at four minutes of chain idleness, which on
 * `eip155:4663`/`46630` — continuous blocks, a gap of a second or two — never
 * arrives.
 *
 * **It is deliberately not a wider `deadline`.** Extending the constant would
 * buy the same headroom by making every signature valid for longer, and a
 * signature's validity window is exactly the blast radius of a phished or
 * scraped one; `_consumeAuth`'s `SignatureExpired` is what bounds it. The
 * failure here is a chain that is not moving, and the honest answer to that is
 * to refuse to issue, not to sign for longer.
 */
export const EVM_RELAYED_DEADLINE_MIN_WINDOW_SECONDS = 60;

/**
 * The three buyer-facing escrow doors on `eip155`, and the one place the
 * difference between a signature request and a transaction is decided.
 *
 * ## Two of the three are not transactions at all
 *
 * `setLimitsBySig` and `requestWithdrawBySig` are EIP-712 **signature
 * requests** the platform's relayer submits. They come back as the
 * union's `typed-data` member with `relayed: true`, carrying no `to`, no
 * `data`, no `gasLimit` and no `nonce` — a wallet asked for one of these signs
 * and does not broadcast. That is why the union has three members and not two:
 * a transaction-only shape would force a frontend to fabricate a transaction it
 * must not send.
 *
 * ## One nonce, for both of them
 *
 * `Escrow.authNonce` is **one field**, consumed by whichever `*BySig` door
 * lands first. There is no separate "limits nonce" and no separate "withdraw
 * nonce", so this class reads the escrow once per call and hands the same value
 * to both encoders. Two counters for one on-chain field produces a second
 * signature that reverts `BadNonce`, and only when both doors are used — rare
 * enough to reach production.
 *
 * Since assay-evm D-18 the DIRECT `setLimits` and `requestWithdraw` (and the
 * delegation doors) consume it too: every payer decision advances it. So it is
 * read fresh for every build and never cached, and a buyer who acts directly
 * between build and submit turns the relayed request into a `BadNonce`, which
 * is the intended outcome — a withheld signature cannot land after a later
 * decision.
 *
 * ## There is no `withdrawBySig`, and there must never be one
 *
 * `withdraw()` on chain is `msg.sender`-only, pays `msg.sender` and takes no
 * destination. `requestWithdraw` has already served the one-hour delay
 * by the time `withdraw` is callable, so a phished `withdrawBySig` signature
 * would drain an escrow with no remaining brake. The buyer's own transaction
 * means an attacker needs the address itself. This class therefore has no
 * method by that name, and `EvmEscrowIntentClient` has no send method at all.
 *
 * ## What is NOT here that the Solana builder has
 *
 * **No `escrowNotOpen` refusal.** On EVM there is no escrow account to open:
 * one contract holds every buyer's USDG in an `escrows[buyer]` mapping, and a
 * buyer never touched reads back as an all-zero struct. `setLimitsBySig` on
 * that zero struct is exactly the call a new buyer has to make, so refusing it
 * for "no escrow" would make the first door unreachable. Absence is expressed
 * where it is real — on the withdraw path, as "nothing was requested".
 */
@Injectable()
export class EvmEscrowIntentBuilder implements EscrowIntentBuilderPort, EscrowDelegationPort {
  /**
   * **The wall clock is back, and it may never produce a value the contract
   * reads.**
   *
   * This constructor took `{ now: () => Date.now() }`, then lost it: every
   * instant this class puts into a signed struct, or compares against one, is
   * read by the CONTRACT off `block.timestamp`, so the only clock that can be
   * right about those is the chain's. That ruling stands and nothing below
   * changes it — `deadline` is still `chainSeconds + 300` and the maturity gate
   * is still `chainSeconds < withdrawAvailableAt`.
   *
   * What came back with it is a different question, and one the chain's clock
   * **cannot answer about itself**: *is the reading I just took fresh?* A block
   * timestamp says when a block was sealed, not how long ago that was, so
   * detecting a chain that has stopped producing blocks needs a second,
   * independent clock — and this process's is the only one there is. It is used
   * in exactly one place ({@link assertFreshEnoughToSign}), in exactly one
   * direction (refuse), and its value never reaches a signed struct.
   *
   * A server clock that is itself wrong therefore costs a false refusal — a 503
   * a caller can retry — and never a signature with the wrong lifetime.
   */
  constructor(
    private readonly clients: ReadonlyMap<ChainId, EvmEscrowIntentClient>,
    private readonly deployments: ReadonlyMap<ChainId, EvmDeployment>,
    /** Milliseconds, `Date.now()`'s own unit. The chain's timestamps are seconds. */
    private readonly config: { readonly now: () => number },
  ) {}

  /**
   * The chain's registered settlement asset, from the **registry**.
   *
   * Never `decimals()` off the token: `asset-registry.ts` gives the reason —
   * USDG is an upgradeable proxy, so a decimals read is a claim about
   * today's implementation, and every amount already written at six decimals
   * would silently re-scale if it ever answered differently. Reading the
   * deployment's own token address through the registry also pins the two
   * against each other: a deployment naming a token nobody registered is a
   * boot-time refusal rather than a payment at the wrong scale.
   */
  async escrowAsset(account: AccountId): Promise<{ asset: AssetId; decimals: number }> {
    const { chainId } = this.parse(account);
    const asset = toAssetId(chainId, 'erc20', getAddress(this.deployment(chainId).asset));
    return { asset, decimals: getAssetMetadata(asset).decimals };
  }

  /**
   * `Constants.WITHDRAW_DELAY_SECONDS` — a compile-time constant on
   * `X402Escrow`, not a `Config` field.
   *
   * There is nothing to read and nothing an `updateConfig` could move under a
   * cached copy: the value is baked into the deployed bytecode, and
   * `Constants.sol`'s own invariant note pins it above
   * `MAX_VOUCHER_REDEEMABLE_LIFE_SECONDS` so a withdraw request cannot outrun a
   * voucher already signed. `async` because the port's shape is one shape for
   * every chain.
   */
  async withdrawDelaySeconds(chainId: ChainId): Promise<number> {
    this.assertServes(chainId);
    return EVM_CONSTANTS.WITHDRAW_DELAY_SECONDS;
  }

  async buildIntent(request: EscrowIntentRequest): Promise<UnsignedChainTransaction> {
    const { chainId, address: buyer } = this.parse(request.account);
    const deployment = this.deployment(chainId);

    /*
      ONE escrow read and ONE clock reading, for every kind, issued together.

      `authNonce`, `withdrawRequested` and `withdrawAvailableAt` all come out of
      the same `escrowOf` call — the struct is returned whole, so a second read
      would cost a round trip to learn something already in hand and could
      disagree with the first. The clock is here for the same reason: all three
      kinds need it, and all three need the CHAIN's rather than this process's:

      - `withdraw()` decides maturity on `block.timestamp` (the long argument
        is at the gate itself), and
      - both `*BySig` doors carry a `deadline` that `_consumeAuth` refuses on
        `block.timestamp > deadline` — the same ruler.

      Read here rather than in each branch so there is ONE reading per request
      and the three cannot disagree about what time it is, and issued with
      `escrowOf` so the extra call costs no extra wall time.
    */
    const [escrow, chainSeconds] = await Promise.all([
      this.readEscrow(chainId, deployment, buyer),
      this.chainSeconds(chainId),
    ]);

    switch (request.kind) {
      case EscrowIntentKind.SET_LIMITS:
        return this.setLimits(
          chainId,
          deployment,
          buyer,
          this.requireLimits(request),
          escrow,
          chainSeconds,
        );

      case EscrowIntentKind.REQUEST_WITHDRAW:
        return this.requestWithdraw(chainId, deployment, buyer, request, escrow, chainSeconds);

      case EscrowIntentKind.WITHDRAW:
        return this.withdraw(chainId, deployment, buyer, request, escrow, chainSeconds);
    }
  }

  // ── The two signature requests ───────────────────────────────────────────

  // ── Agent payment delegation ───────────────────────────────────────────

  /**
   * The `AuthorizeDelegate` the payer signs, at the escrow's `authNonce` and a
   * chain-clock deadline, exactly like `SetLimits`.
   *
   * Every rule `X402Escrow._authorizeDelegate` will apply is checked here first
   * so a payer is never asked to sign something the chain refuses: the
   * delegate is an address on the payer's chain and not the payer, both caps
   * are non-zero with the per-call cap inside the window cap, neither cap
   * exceeds the escrow's OWN current ceiling, and `validUntil` is in the future
   * by the chain's clock and at most `MAX_DELEGATION_LIFETIME_SECONDS` out. The
   * chain re-checks all of it; this is the diagnosis, the chain is the rule.
   */
  async authorizeIntent(
    account: AccountId,
    terms: DelegationTerms,
  ): Promise<UnsignedChainTransaction> {
    const { chainId, address: payer } = this.parse(account);
    const deployment = this.deployment(chainId);
    const delegate = this.delegateOn(chainId, payer, terms.delegate);
    const maxVoucherAmount = this.uint64(terms.maxVoucherAmount, 'maxVoucherAmount');
    const maxPerWindow = this.uint64(terms.maxPerWindow, 'maxPerWindow');
    const validUntil = this.uint64(terms.validUntil, 'validUntil');

    if (maxVoucherAmount === 0n || maxPerWindow === 0n || maxVoucherAmount > maxPerWindow) {
      throw SettlementErrors.delegationInvalid({
        reason:
          'DelegateCapsInvalid — both caps must be above zero and the per-voucher cap may not ' +
          'exceed the per-window cap',
      });
    }

    const [escrow, chainSeconds, current] = await Promise.all([
      this.readEscrow(chainId, deployment, payer),
      this.chainSeconds(chainId),
      this.readDelegation(chainId, deployment, payer, delegate),
    ]);
    if (
      maxVoucherAmount > (escrow.maxVoucherAmount ?? 0n) ||
      maxPerWindow > (escrow.maxPerWindow ?? 0n)
    ) {
      throw SettlementErrors.delegationInvalid({
        reason:
          `DelegateCapsExceedEscrowLimits — the escrow allows ${escrow.maxVoucherAmount ?? 0n} ` +
          `per voucher and ${escrow.maxPerWindow ?? 0n} per window; set the escrow limits first`,
      });
    }
    if (
      validUntil <= chainSeconds ||
      validUntil - chainSeconds > BigInt(EVM_CONSTANTS.MAX_DELEGATION_LIFETIME_SECONDS)
    ) {
      throw SettlementErrors.delegationInvalid({
        reason:
          'DelegateValidUntilInvalid — validUntil must be in the future and at most ' +
          `${EVM_CONSTANTS.MAX_DELEGATION_LIFETIME_SECONDS / 86_400} days out`,
      });
    }

    // Re-authorising a standing grant UPDATES it (`DelegateUpdated`, the
    // window counter kept) — the "Edit limits" path (BUG-D1-04). The one
    // re-authorisation the chain refuses is an identical one.
    if (
      current.listPosition !== 0 &&
      !current.revoked &&
      current.maxVoucherAmount === maxVoucherAmount &&
      current.maxPerWindow === maxPerWindow &&
      current.validUntil === validUntil
    ) {
      throw SettlementErrors.delegationInvalid({
        reason: 'DelegationUnchanged — this key already holds exactly these caps and expiry',
      });
    }

    const typed = authorizeDelegateTypedData(
      {
        payer,
        delegate,
        maxVoucherAmount,
        maxPerWindow,
        validUntil,
        nonce: escrow.authNonce,
        deadline: this.deadline(chainId, chainSeconds),
      },
      this.domain(chainId, deployment),
    );
    return this.asTypedDataIntent(chainId, typed);
  }

  /** The `RevokeDelegate` the payer signs. Refused when there is nothing to revoke. */
  async revokeIntent(
    account: AccountId,
    delegateAccount: AccountId,
  ): Promise<UnsignedChainTransaction> {
    const { chainId, address: payer } = this.parse(account);
    const deployment = this.deployment(chainId);
    const delegate = this.delegateOn(chainId, payer, delegateAccount);

    const [escrow, chainSeconds, delegation] = await Promise.all([
      this.readEscrow(chainId, deployment, payer),
      this.chainSeconds(chainId),
      this.readDelegation(chainId, deployment, payer, delegate),
    ]);
    if (delegation.listPosition === 0) {
      throw SettlementErrors.delegationNotActive({ delegate: delegateAccount });
    }

    const typed = revokeDelegateTypedData(
      { payer, delegate, nonce: escrow.authNonce, deadline: this.deadline(chainId, chainSeconds) },
      this.domain(chainId, deployment),
    );
    return this.asTypedDataIntent(chainId, typed);
  }

  /**
   * The payer's standing delegates, from the chain: `delegatesOf` (authorised
   * and not revoked, an expired one included until revoked), then each one's
   * `delegationOf`, with its window decayed by the chain's clock.
   */
  async list(account: AccountId): Promise<readonly EscrowDelegation[]> {
    const { chainId, address: payer } = this.parse(account);
    const deployment = this.deployment(chainId);
    const client = this.client(chainId);
    const [delegates, chainSeconds] = await Promise.all([
      (
        client.readContract({
          address: getAddress(deployment.escrow),
          abi: X402_ESCROW_ABI,
          functionName: 'delegatesOf',
          args: [payer],
        }) as Promise<readonly `0x${string}`[]>
      ).catch((error: unknown) => {
        // An escrow not yet upgraded has no `delegatesOf`: it has no delegates,
        // exactly as the voucher authority reads it (review S3-18). An outage
        // is still an error.
        if (isRevert(error)) return [] as readonly `0x${string}`[];
        throw error;
      }),
      this.chainSeconds(chainId),
    ]);
    const records = await Promise.all(
      delegates.map((delegate) => this.readDelegation(chainId, deployment, payer, delegate)),
    );
    return delegates.map((delegate, i) => {
      const record = records[i];
      return {
        delegate: toAccountId(chainId, getAddress(delegate)),
        maxVoucherAmount: record.maxVoucherAmount,
        maxPerWindow: record.maxPerWindow,
        spentInWindow: decayWindow({
          spentInWindow: record.spentInWindow,
          windowStartedAt: Number(record.windowStartedAt),
          nowSeconds: Number(chainSeconds),
        }),
        validUntil: record.validUntil,
        status:
          chainSeconds > record.validUntil
            ? EscrowDelegationStatus.EXPIRED
            : EscrowDelegationStatus.ACTIVE,
      };
    });
  }

  private delegateOn(
    chainId: ChainId,
    payer: `0x${string}`,
    delegateAccount: AccountId,
  ): `0x${string}` {
    let parsed: { chainId: ChainId; address: string };
    try {
      parsed = parseAccountId(delegateAccount);
    } catch {
      throw SettlementErrors.delegationInvalid({ reason: 'the delegate is not a CAIP-10 account' });
    }
    if (parsed.chainId !== chainId || !isAddress(parsed.address, { strict: false })) {
      throw SettlementErrors.delegationInvalid({
        reason: `the delegate must be an address on ${chainId}`,
      });
    }
    const delegate = getAddress(parsed.address);
    if (delegate === payer) {
      throw SettlementErrors.delegationInvalid({
        reason: 'DelegateIsPayer — the payer’s own key already signs',
      });
    }
    if (delegate === '0x0000000000000000000000000000000000000000') {
      throw SettlementErrors.delegationInvalid({
        reason: 'ZeroAddress — the delegate is the zero address',
      });
    }
    return delegate;
  }

  private async readDelegation(
    chainId: ChainId,
    deployment: EvmDeployment,
    payer: `0x${string}`,
    delegate: `0x${string}`,
  ): Promise<EvmDelegationRead> {
    return (await this.client(chainId).readContract({
      address: getAddress(deployment.escrow),
      abi: X402_ESCROW_ABI,
      functionName: 'delegationOf',
      args: [payer, delegate],
    })) as EvmDelegationRead;
  }

  private setLimits(
    chainId: ChainId,
    deployment: EvmDeployment,
    buyer: `0x${string}`,
    limits: EscrowLimits,
    escrow: EvmEscrowRead,
    chainSeconds: bigint,
  ): UnsignedChainTransaction {
    const typed = setLimitsTypedData(
      {
        buyer,
        maxVoucherAmount: this.uint64(limits.maxVoucherAmount, 'maxVoucherAmount'),
        maxPerWindow: this.uint64(limits.maxPerWindow, 'maxPerWindow'),
        nonce: escrow.authNonce,
        deadline: this.deadline(chainId, chainSeconds),
      },
      this.domain(chainId, deployment),
    );
    return this.asTypedDataIntent(chainId, typed);
  }

  private requestWithdraw(
    chainId: ChainId,
    deployment: EvmDeployment,
    buyer: `0x${string}`,
    request: EscrowIntentRequest,
    escrow: EvmEscrowRead,
    chainSeconds: bigint,
  ): UnsignedChainTransaction {
    const typed = requestWithdrawTypedData(
      {
        buyer,
        // `0` retracts a standing request in one call, and is passed through
        // rather than special-cased so the chain's own semantics are the only
        // ones in play.
        amount: this.uint64(MoneyUtil.toAtomic(this.requireAmount(request)), 'amount'),
        nonce: escrow.authNonce,
        deadline: this.deadline(chainId, chainSeconds),
      },
      this.domain(chainId, deployment),
    );
    return this.asTypedDataIntent(chainId, typed);
  }

  /**
   * The CHAIN's `now + 300`, the same width as a voucher's maximum lifetime.
   *
   * A signature request that sat open in a wallet window is refused rather than
   * replayed later — the deadline is inside the signed struct, so nothing on
   * this side can extend it after the fact.
   *
   * **The 300 is a width; the instant it is added to is the chain's.**
   * `X402Escrow._consumeAuth` refuses on `block.timestamp > deadline`, so a
   * deadline stamped from `Date.now()` measures this process's clock against
   * the chain's ruler. That is not a boundary-second problem like the maturity
   * gate's was: a chain running 300 s ahead of this server makes EVERY relayed
   * request born expired, so both `*BySig` doors — the whole of a gasless
   * buyer's ability to lower a ceiling or start an exit — fail for every buyer,
   * and nothing on this side reports anything wrong. Measured live on a fork at
   * 400 s of skew.
   *
   * **And `blockTag: 'latest'` is a LOWER bound, which is not the same as a
   * close one.** The window a buyer really gets is `300 − (age of the latest
   * block)`, because the contract judges the deadline against the block that
   * *includes* the call. This comment used to say that could only make the
   * window "slightly shorter"; on a chain that stops producing blocks it makes
   * it NEGATIVE — 2,001 s of staleness measured on the local fork, every request
   * born 1,701 s expired, and `SignatureExpired` reported for a signature made
   * four seconds earlier. Harmless on a busy L2 and fatal on a quiet one, silent either way.
   *
   * The constant is unchanged; what was added is a refusal. See
   * {@link assertFreshEnoughToSign} and
   * {@link EVM_RELAYED_DEADLINE_MIN_WINDOW_SECONDS} for why the fix is to stop
   * issuing rather than to sign for longer.
   */
  private deadline(chainId: ChainId, chainSeconds: bigint): bigint {
    const deadline = chainSeconds + BigInt(EVM_CONSTANTS.VOUCHER_MAX_LIFETIME_SECONDS);
    this.assertFreshEnoughToSign(chainId, chainSeconds, deadline);
    return deadline;
  }

  /**
   * Refuse to issue a deadline that is already dead, or nearly.
   *
   * The window above is stated in CHAIN seconds; what a buyer actually gets is
   * that window minus however long ago the latest block was sealed, because the
   * including block is later than the one this was read from. Measuring "how
   * long ago" is the one thing `block.timestamp` cannot do about itself, so the
   * comparison is against this process's clock — see the constructor for why
   * that is not a reintroduction of the bug this class removed.
   *
   * **Applied here and not in `buildIntent`, so `WITHDRAW` is untouched.** A
   * `withdraw()` transaction carries no deadline and expires from nothing; the
   * same stale reading only makes its maturity gate conservative, and
   * `estimateWithdrawGas` hears the chain's own answer regardless. Refusing a
   * buyer's exit because the chain looked idle would break this domain's own
   * rule that a buyer's exit does not depend on the platform's cooperation —
   * and it would do it in the one situation where they most need it.
   *
   * The negative direction is deliberately not guarded. A chain whose
   * timestamps run AHEAD of this server makes the window wider than 300 s of
   * wall time and no shorter in chain time, which is the contract's own ruler;
   * refusing there would be this process asserting its clock over the chain's.
   */
  private assertFreshEnoughToSign(chainId: ChainId, chainSeconds: bigint, deadline: bigint): void {
    const nowSeconds = BigInt(Math.floor(this.config.now() / 1000));
    const usableWindow = deadline - nowSeconds;
    if (usableWindow >= BigInt(EVM_RELAYED_DEADLINE_MIN_WINDOW_SECONDS)) {
      return;
    }

    throw ChainErrors.latestBlockStale({
      chainId,
      ageSeconds: Number(nowSeconds - chainSeconds),
      usableWindowSeconds: Number(usableWindow),
      minimumSeconds: EVM_RELAYED_DEADLINE_MIN_WINDOW_SECONDS,
    });
  }

  /** The chain's own clock, in seconds — `block.timestamp` of the latest block. */
  private async chainSeconds(chainId: ChainId): Promise<bigint> {
    return (await this.client(chainId).getBlock({ blockTag: 'latest' })).timestamp;
  }

  // ── The one transaction ──────────────────────────────────────────────────

  private async withdraw(
    chainId: ChainId,
    deployment: EvmDeployment,
    buyer: `0x${string}`,
    request: EscrowIntentRequest,
    escrow: EvmEscrowRead,
    chainSeconds: bigint,
  ): Promise<UnsignedChainTransaction> {
    // `withdraw()` pays `msg.sender` and takes NO destination argument. A
    // caller naming somewhere else is asking for something this chain cannot
    // do, and quietly ignoring the field would hand them a transaction that
    // pays a different party than the one they named.
    if (request.destination !== null) {
      const destination = this.parse(request.destination);
      if (destination.chainId !== chainId || destination.address !== buyer) {
        throw SettlementErrors.withdrawalDestinationInvalid({
          destination: request.destination,
        });
      }
    }

    const data = encodeFunctionData({ abi: X402_ESCROW_ABI, functionName: 'withdraw' });
    const client = this.client(chainId);
    const to = getAddress(deployment.escrow);

    // The contract's own two refusals, made here so the buyer does not pay a
    // network fee to be told. `NoWithdrawRequested` first, then
    // `WithdrawNotYetAvailable` — `X402Escrow.withdraw()`'s order.
    if (escrow.withdrawRequested === 0n) {
      throw SettlementErrors.withdrawalNotYetAvailable({});
    }

    /*
      Maturity, against the CHAIN's clock and not this process's.

      `X402Escrow.withdraw()` reads `if (block.timestamp < e.withdrawAvailableAt)
      revert WithdrawNotYetAvailable()` — so the authority on whether the money
      may move is a value the chain publishes, and `Date.now()` is a proxy for
      it that is systematically ahead: the latest block's timestamp was stamped
      when it was sealed and does not advance again until the next one is. Every
      buyer who asks within about one block time of `withdrawAvailableAt` sits in
      that gap, and this is the worst moment to be wrong about them — they waited
      out the hour and clicked at the first legal instant.

      Wall-clock here made that a **500**: the check passed, `estimateGas` ran
      the call against the latest block, the chain reverted `WithdrawNotYetAvailable`,
      and an unhandled RPC error came back for a condition this file already has
      a 409 and a sentence for. Measured on a fork.

      `blockTag: 'latest'` is the same context `eth_estimateGas` executes in, so
      this predicts that call rather than guessing at it, and it is a LOWER bound
      on the timestamp of the block that will actually include the transaction —
      whatever mines it is later than the one already mined. So it cannot tell a
      buyer their withdrawal is legal when the contract would refuse it; it can
      only, for at most one block, tell them to wait a moment longer.

      The reading itself is taken by `buildIntent`, ISSUED WITH `escrowOf` rather
      than serialised after it, because the two `*BySig` branches need the same
      clock for their `deadline`. That makes it one round trip earlier in time
      than it used to be, which strengthens the argument above rather than
      weakening it: an earlier reading is a smaller lower bound, so it still
      cannot tell a buyer their withdrawal is legal when the contract would
      refuse it, and `estimateWithdrawGas` below is the layer that hears the
      chain's own answer either way.
    */
    if (chainSeconds < escrow.withdrawAvailableAt) {
      throw SettlementErrors.withdrawalNotYetAvailable({
        availableAt: new Date(Number(escrow.withdrawAvailableAt) * 1000).toISOString(),
      });
    }

    const [nonce, fees, gas] = await Promise.all([
      client.getTransactionCount({ address: buyer, blockTag: 'pending' }),
      client.estimateFeesPerGas(),
      this.estimateWithdrawGas(client, buyer, to, data, escrow),
    ]);

    return {
      namespace: 'eip155',
      chainId,
      kind: 'transaction',
      from: buyer,
      to,
      data,
      value: '0',
      nonce: nonce.toString(),
      // 20 % margin. `withdraw` writes five storage slots and makes one ERC-20
      // transfer whose cost depends on the token's own state — a blocklist
      // read, a fresh recipient slot — so the estimate is a floor rather than
      // an answer, and a transaction that runs out of gas has still spent it.
      gasLimit: ((gas * 12n) / 10n).toString(),
      maxFeePerGas: fees.maxFeePerGas.toString(),
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
    };
  }

  /**
   * `eth_estimateGas` for `withdraw()`, with the chain's own two refusals
   * translated back into the 409 they already have a name for.
   *
   * The gate above closes the window this exists for — but it closes it with a
   * reading taken a round trip earlier, and a block can be mined between the two
   * calls, or a load balancer can answer them from two nodes at different
   * heights. When that happens the revert is the truth and this is the layer
   * that hears it, so the buyer is told "not yet" instead of being handed a
   * 500 for a condition the catalogue names.
   *
   * **Only these two selectors.** Mapping every revert here would answer "wait a
   * moment longer" to an empty escrow (`EscrowInsufficient`) or a paused
   * program (`ProgramPaused`) — a wrong answer that reads like a reassuring one,
   * and one the buyer would act on by waiting. Everything else, including a
   * revert with no data and every transport failure, propagates untouched.
   */
  private async estimateWithdrawGas(
    client: EvmEscrowIntentClient,
    buyer: `0x${string}`,
    to: `0x${string}`,
    data: `0x${string}`,
    escrow: EvmEscrowRead,
  ): Promise<bigint> {
    try {
      return await client.estimateGas({ account: buyer, to, data, value: 0n });
    } catch (error) {
      switch (evmErrorName(revertDataOf(error))) {
        case 'WithdrawNotYetAvailable':
          throw SettlementErrors.withdrawalNotYetAvailable({
            availableAt: new Date(Number(escrow.withdrawAvailableAt) * 1000).toISOString(),
          });
        case 'NoWithdrawRequested':
          throw SettlementErrors.withdrawalNotYetAvailable({});
        default:
          throw error;
      }
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * The reading door, applying EIP-55 **strictly**.
   *
   * CAIP-10's grammar is chain-agnostic, so a mixed-case address with a broken
   * checksum satisfies `parseAccountId` — and viem's non-strict `getAddress`
   * downstream then *repairs* it, so a signature request would be built for an
   * address nobody verified. Observed on the adapter's own reading door before
   * it gained the check; every new entry point gets the same check.
   */
  private parse(account: AccountId): { chainId: ChainId; address: `0x${string}` } {
    const parsed = parseAccountId(account);
    this.assertServes(parsed.chainId);
    if (!isAddress(parsed.address, { strict: true })) {
      throw ChainErrors.invalidAddress({ chainId: parsed.chainId, address: parsed.address });
    }
    return { chainId: parsed.chainId, address: getAddress(parsed.address) };
  }

  private assertServes(chainId: ChainId): void {
    if (!this.deployments.has(chainId)) {
      throw ChainErrors.unsupportedChain({ chainId });
    }
  }

  private deployment(chainId: ChainId): EvmDeployment {
    const deployment = this.deployments.get(chainId);
    if (!deployment) {
      throw ChainErrors.unsupportedChain({ chainId });
    }
    return deployment;
  }

  private client(chainId: ChainId): EvmEscrowIntentClient {
    const client = this.clients.get(chainId);
    if (!client) {
      throw ChainErrors.programNotConfigured({
        what: `a JSON-RPC client for ${chainId}`,
        variable: 'EVM_RPC_URLS',
      });
    }
    return client;
  }

  private domain(chainId: ChainId, deployment: EvmDeployment): TypedDataDomain {
    return evmDomain(chainId, getAddress(deployment.escrow));
  }

  private async readEscrow(
    chainId: ChainId,
    deployment: EvmDeployment,
    buyer: `0x${string}`,
  ): Promise<EvmEscrowRead> {
    return (await this.client(chainId).readContract({
      address: getAddress(deployment.escrow),
      abi: X402_ESCROW_ABI,
      functionName: 'escrowOf',
      args: [buyer],
    })) as EvmEscrowRead;
  }

  /**
   * The wire form of the typed-data member.
   *
   * `domain.chainId` is a **decimal string** here and a `number` inside viem:
   * the union's own comment settles it — it is a `uint256` in the typed-data
   * encoding, `JSON.stringify` throws on a `bigint`, and a `number` loses
   * precision above 2^53. The conversion happens once, at this boundary.
   */
  private asTypedDataIntent(
    chainId: ChainId,
    typed: {
      domain: TypedDataDomain;
      types: Record<string, readonly { name: string; type: string }[]>;
      primaryType: string;
      message: object;
    },
  ): UnsignedChainTransaction {
    const domain: Eip712Domain = {
      name: String(typed.domain.name),
      version: String(typed.domain.version),
      chainId: String(typed.domain.chainId),
      verifyingContract: String(typed.domain.verifyingContract),
    };
    return {
      namespace: 'eip155',
      chainId,
      kind: 'typed-data',
      domain,
      types: typed.types,
      primaryType: typed.primaryType,
      message: { ...typed.message },
      relayed: true,
    };
  }

  /**
   * Every amount argument on `X402Escrow` is a `uint64`.
   *
   * `Money` is already bounded at `2^64 - 1` by `MONEY_MAX_ATOMIC_UNITS`, so
   * that half is belt-and-braces; `EscrowLimits` carries raw `bigint`s and is
   * not bounded anywhere else. Encoding an out-of-range value would throw deep
   * inside viem's encoder with a message about a word, at a point where the
   * caller can no longer tell which field it was.
   */
  private uint64(value: bigint, field: string): bigint {
    if (value < 0n || value > MAX_UINT64) {
      throw ChainErrors.payloadMalformed({
        reason: `${field} does not fit the uint64 the escrow declares`,
      });
    }
    return value;
  }

  private requireLimits(request: EscrowIntentRequest): EscrowLimits {
    if (!request.limits) {
      throw ChainErrors.programNotConfigured({
        what: `escrow limits for a ${request.kind} intent`,
        variable: 'limits',
      });
    }
    return request.limits;
  }

  private requireAmount(request: EscrowIntentRequest) {
    if (!request.amount) {
      throw ChainErrors.programNotConfigured({
        what: `an amount for a ${request.kind} escrow intent`,
        variable: 'amount',
      });
    }
    return request.amount;
  }
}
