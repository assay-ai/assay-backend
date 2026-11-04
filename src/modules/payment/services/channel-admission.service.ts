import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { PaymentIntentEntity } from '@database/postgres/entities/payment-intent.entity';
import {
  VoucherChannelEntity,
  VoucherChannelStatus,
} from '@database/postgres/entities/voucher-channel.entity';
import { OpenVoucherTotals } from '@database/postgres/repositories/payment-intent.repository';
import { VoucherChannelRepository } from '@database/postgres/repositories/voucher-channel.repository';
import { BlockedRole, BlockSubjectKind } from '@modules/blocklist/domain/account-block';
import { AccountBlocklistService } from '@modules/blocklist/services/account-blocklist.service';
import { ChainAdapterRegistry } from '@modules/chains/chain-adapter.registry';
import {
  CHAIN_STATE_GATE,
  ChainDoor,
  ChainStateGatePort,
} from '@modules/chains/ports/chain-state-gate.port';
import { sameAccountSpelling } from '@modules/chains/evm/eip55';
import {
  PAID_CALLS_PAUSED_RETRY_AFTER_SECONDS,
  RedeemerFloatGate,
} from '@modules/chains/evm/evm-redeemer-float.gate';
import {
  AccountId,
  AssetId,
  ChainId,
  parseAccountId,
  toAccountId,
} from '@modules/chains/ports/caip.types';
import { Money } from '@modules/chains/ports/money.types';
import {
  VoucherAuthorityKind,
  VoucherAuthorityRefusal,
  VoucherDelegationTerms,
} from '@modules/chains/ports/voucher-authority.types';
import { LedgerErrors } from '@modules/ledger/errors/ledger.errors';
import { EscrowChainBalance } from '@modules/ledger/ports/escrow-balance-reader.port';

import {
  CHANNEL_LIVE_CHAINS,
  CHANNEL_REQUIRED_CHAINS,
  CHANNEL_POLICY,
  CHANNEL_SCHEME,
  maxOpenChannelsOn,
} from '../constants/channel.constants';
import { VOUCHER_ADMISSION_CHAIN_LAG_MS } from '../constants/voucher.constants';
import {
  ChannelPolicy,
  DEFAULT_CHANNEL_POLICY,
  reservationUrgent,
} from '../domain/channel/channel-policy';
import {
  CHANNEL_CALLS_LIMIT,
  CHANNEL_TIME_RULES,
  CHANNEL_VOUCHER_PRIMARY_TYPE,
  CHANNEL_VOUCHER_TYPES,
  channelKeyOf,
  ChannelVoucherMessage,
  ChannelVoucherShapeError,
  channelTimeRefusal,
  parseChannelVoucher,
  checksumAddress,
} from '../domain/channel/channel-voucher';
import { decayVoucherWindow } from '../domain/voucher-window';
import { ChannelErrors } from '../errors/channel.errors';
import { PaymentErrors } from '../errors/payment.errors';
import { CHANNEL_DOOR, ChannelDoorPort } from '../ports/channel-door.port';
import {
  PaymentIntent,
  PaymentIntentCallClass,
  PaymentRail,
  VoucherFormat,
} from '../ports/payment.types';
import { PaymentIntentService } from './payment-intent.service';

/** What the MCP layer read off `_meta["assay/channelVoucher"]` (API-W2 §1.3). */
export interface ChannelVoucherEnvelope {
  readonly voucher: unknown;
  readonly signature: unknown;
  readonly providerId: string;
  readonly contractVersion?: number;
}

export interface AdmitChannelCallInput {
  readonly organizationId: string;
  readonly agentId: string;
  readonly agentAccount: AccountId;
  readonly chainId: ChainId;
  readonly providerId: string;
  readonly providerAccount: AccountId;
  readonly toolId: string;
  readonly requestHash: string;
  readonly resource: string;
  readonly price: Money;
  readonly platformFee: Money;
  readonly envelope: ChannelVoucherEnvelope;
  /** The delegate key bound to the calling credential, or `null`. */
  readonly boundDelegate: AccountId | null;
  readonly credentialId: string | null;
  /** The escrow read for this call (balance, limits, window); `null` = no escrow. */
  readonly escrow: EscrowChainBalance | null;
  readonly idempotencyKey: string | null;
  readonly beforeHold?: () => Promise<void>;
}

/** What admission answers: the call's intent, and whether it is a replay of an earlier one. */
export interface ChannelAdmission {
  readonly intent: PaymentIntent;
  readonly replayed: boolean;
  readonly channel: { channelId: string; cumulative: string; calls: number; key: string };
}

/** The `channel-v1` requirement the server offers (API-W2 §1.2). */
export interface ChannelRequirement {
  readonly scheme: typeof CHANNEL_SCHEME;
  readonly network: ChainId;
  readonly payer: AccountId;
  readonly provider: AccountId;
  readonly providerId: string;
  readonly price: Money;
  readonly contractVersion?: number;
  readonly domain: { name: string; version: string; chainId: number; verifyingContract: string };
  readonly primaryType: typeof CHANNEL_VOUCHER_PRIMARY_TYPE;
  readonly types: typeof CHANNEL_VOUCHER_TYPES;
  readonly minLifeSeconds: number;
  readonly maxLifeSeconds: number;
  readonly maxOpenChannels: number;
  readonly maxPendingPerChannel: Money;
  readonly signers: readonly ('payer' | 'delegate')[];
  readonly delegate: AccountId | null;
}

/** A lane refusal decided under the lock that must be recorded after the rollback. */
class LaneDesync extends Error {
  constructor(readonly channelRowId: string) {
    super('channel lane desync');
  }
}

/** The payer reached its open-channel cap, counted under its lock (review 2026-10-31 L5). */
class LaneLimit extends Error {
  constructor() {
    super('channel open cap');
  }
}

/** A_cap refused under the lock: an urgent round is asked for after the rollback. */
class LanePendingCap extends Error {
  constructor(
    readonly channelRowId: string,
    readonly pending: bigint,
    readonly settling: boolean,
  ) {
    super('channel pending cap');
  }
}

/** How long a chain-time reading stands in before it is read again. */
const CHAIN_CLOCK_TTL_MS = 30_000;
/** The channel scheduler's cron second (`ChannelSettlementJob`, `15 * * * * *`). */
const CHANNEL_TICK_SECOND = 15;

/** The exact voucher was admitted by a concurrent copy of this request (a network retry). */
class LaneReplay extends Error {
  constructor(
    readonly organizationId: string,
    readonly intentId: string,
  ) {
    super('channel voucher replay');
  }
}

/**
 * Admits a paid call on a CHANNEL voucher (spec P2 v3.1 §5.3, SPEC-W2 §4).
 *
 * The voucher binds no request: what makes the step pay for THIS call is the
 * order of checks below, all done before the call is served, and the
 * contract's own bound on what a settlement can charge (I2: never more than
 * the signed step; I3: never more than `Δcalls · maxVoucherAmount` on average).
 *
 * ```text
 *  1  offered          — the chain is live, the escrow has the door, hold ≤ 1 h
 *  2  canonical form   — shape, ranges, times (life ≤ 300 s, ≥ 60 s left)
 *  3  binding          — payer = this session's account, provider = the offer's
 *  4  signer           — the payer, or a live delegate bound to this credential,
 *                        not within U + O + tick of its validUntil
 *  5  replay           — the exact (channel, cumulative, calls, signature) again
 *  6  open             — a new lane: cumulative = price, calls = 1, chain settled 0,
 *                        under the payer's open-channel cap
 *  7  under the payer's advisory lock, atomic with the intent insert:
 *     continuity       — cumulative = last + price, calls = last + 1, issuedAt ≥ last
 *     the lane's binding (org, agent, credential), status, A_cap
 *     ONE global reservation across both doors and every provider: Σ pending +
 *     price ≤ min(balance − withdrawal, escrow-window headroom, delegate headroom)
 * ```
 *
 * A gap or rewind kills the lane (DESYNC); a dispute's kept money or a lane the
 * contract cannot bucket ROTATES it; a refusal caused only by unsettled value
 * (`A_cap`) is `PAYMENT_UNSETTLED_LIMIT`, retryable, and starts a round.
 */
@Injectable()
export class ChannelAdmissionService {
  private readonly logger = new Logger(ChannelAdmissionService.name);
  /** Per chain: the latest block's time and when it was read (review 2026-10-31 M7). */
  private readonly chainClock = new Map<string, { chainSeconds: number; readAt: number }>();

  constructor(
    private readonly intents: PaymentIntentService,
    private readonly channels: VoucherChannelRepository,
    private readonly chains: ChainAdapterRegistry,
    private readonly blocklist: AccountBlocklistService,
    @Inject(CHANNEL_DOOR) private readonly door: ChannelDoorPort,
    @Optional()
    @Inject(CHANNEL_LIVE_CHAINS)
    private readonly liveChains: ReadonlySet<string> = new Set(),
    @Optional()
    @Inject(CHANNEL_POLICY)
    private readonly policy: ChannelPolicy = DEFAULT_CHANNEL_POLICY,
    @Optional() private readonly redeemerFloat?: RedeemerFloatGate,
    @Optional() private readonly now: () => number = () => Date.now(),
    // The on-chain pause / blocklist and the EIP-712 domain guard, as the
    // per-call door applies them (sec-audit 2026-11-01 M-2).
    @Optional()
    @Inject(CHAIN_STATE_GATE)
    private readonly chainState: ChainStateGatePort | null = null,
    // `EVM_CHANNELS_REQUIRED_CHAINS` (owner decision 2026-11-04).
    @Optional()
    @Inject(CHANNEL_REQUIRED_CHAINS)
    private readonly requiredChains: ReadonlySet<string> = new Set(),
  ) {
    const unenforced = [...this.requiredChains].filter((chain) => !this.liveChains.has(chain));
    if (unenforced.length > 0) {
      this.logger.warn(
        `EVM_CHANNELS_REQUIRED_CHAINS names ${unenforced.join(', ')}, which ` +
          'EVM_CHANNELS_LIVE_CHAINS does not: channels are not required there',
      );
    }
  }

  /**
   * Whether a paid call on `chainId` must come from a client that offers
   * `channel-v1` (`PAYMENT_CHANNEL_REQUIRED` otherwise). Only where the door
   * is live: a required chain without the door would refuse every paid call.
   */
  channelsRequiredOn(chainId: ChainId): boolean {
    return this.requiredChains.has(chainId) && this.liveChains.has(chainId);
  }

  /**
   * Whether a paid call from a client that did NOT offer `channel-v1` is
   * refused (`PAYMENT_CHANNEL_REQUIRED`): on a required chain, unless the payer
   * used a lane within `requiredRecentLaneDays` (0 = never) — its client
   * signs channel vouchers and is only paused or sharing its key. A failed
   * read refuses: the refusal charges nothing and the client may retry.
   */
  async refusesPerCallOnly(input: {
    chainId: ChainId;
    asset: AssetId;
    payer: AccountId;
  }): Promise<boolean> {
    if (!this.channelsRequiredOn(input.chainId)) return false;
    const days = this.policy.requiredRecentLaneDays ?? 7;
    if (days === 0) return true;
    const recent = await this.channels
      .usedChannelsRecently(input.payer, input.asset, days)
      .catch(() => false);
    return !recent;
  }

  /**
   * The chain-state gate of the per-call door (`PaymentIntentService.create`):
   * a paused escrow, a blocked party or an EIP-712 domain mismatch refuses
   * the channel too, with the same error, before anything is signed or served.
   */
  private async assertChainActive(parties: {
    payer: AccountId;
    payee: AccountId;
    delegate: AccountId | null;
  }): Promise<void> {
    await this.chainState?.assertActive(ChainDoor.REDEEM, [
      { role: 'PAYER', account: parties.payer },
      { role: 'PAYEE', account: parties.payee },
      { role: 'DELEGATE', account: parties.delegate },
    ]);
  }

  /**
   * Whether a channel may be offered on `chainId` (API-W2 §1.2), or why not.
   * `null` = offered.
   */
  async notOfferedReason(chainId: ChainId, asset: AssetId): Promise<string | null> {
    if (!this.liveChains.has(chainId)) return 'channels are not enabled on this chain';
    try {
      if (!(await this.door.doorLive(asset))) return 'the escrow has no channel door';
      const hold = await this.door.collectHoldSeconds(asset);
      if (hold === null || hold > 3_600) return 'the dispute hold is above one hour';
    } catch {
      return 'the channel door could not be read';
    }
    return null;
  }

  /** The `assay/channelRequired` offer for this call, or `null` when none is made. */
  async requirement(input: {
    chainId: ChainId;
    asset: AssetId;
    payer: AccountId;
    provider: AccountId;
    providerId: string;
    price: Money;
    contractVersion?: number;
    delegate: AccountId | null;
  }): Promise<ChannelRequirement | null> {
    if ((await this.notOfferedReason(input.chainId, input.asset)) !== null) return null;
    await this.assertChainActive({
      payer: input.payer,
      payee: input.provider,
      delegate: input.delegate,
    });
    const adapter = this.chains.resolve(input.chainId);
    if (typeof adapter.channelDomain !== 'function') return null;
    const open = await this.channels.countOpen(this.channels.manager, input.payer, input.asset);
    if (open >= this.maxOpen(input.chainId)) return null;
    const domain = adapter.channelDomain(input.chainId);
    return {
      scheme: CHANNEL_SCHEME,
      network: input.chainId,
      payer: input.payer,
      provider: input.provider,
      providerId: input.providerId,
      price: input.price,
      ...(input.contractVersion !== undefined ? { contractVersion: input.contractVersion } : {}),
      domain: {
        name: String(domain.name),
        version: String(domain.version),
        chainId: Number(domain.chainId),
        verifyingContract: String(domain.verifyingContract),
      },
      primaryType: CHANNEL_VOUCHER_PRIMARY_TYPE,
      types: CHANNEL_VOUCHER_TYPES,
      minLifeSeconds: CHANNEL_TIME_RULES.minRemainingSeconds,
      maxLifeSeconds: CHANNEL_TIME_RULES.maxLifeSeconds,
      maxOpenChannels: this.maxOpen(input.chainId),
      maxPendingPerChannel: {
        amount: this.policy.aCapAtomic.toString(),
        asset: input.price.asset,
        decimals: input.price.decimals,
      },
      signers: ['payer', 'delegate'],
      delegate: input.delegate,
    };
  }

  async admit(input: AdmitChannelCallInput): Promise<ChannelAdmission> {
    const asset = input.price.asset as AssetId;

    // 1. Offered at all.
    const notOffered = await this.notOfferedReason(input.chainId, asset);
    if (notOffered !== null) throw ChannelErrors.notOffered({ reason: notOffered });
    // The per-call door's chain-state gate, first (M-2); the delegate, once
    // known, is checked again below.
    await this.assertChainActive({
      payer: input.agentAccount,
      payee: input.providerAccount,
      delegate: input.boundDelegate,
    });
    if (await this.redeemerFloat?.isPaused(input.chainId)) {
      throw PaymentErrors.settlementGasPaused({
        retryAfter: PAID_CALLS_PAUSED_RETRY_AFTER_SECONDS,
      });
    }
    // CHAIN time for every `issuedAt` / `expiresAt` check (SPEC-W2 §3): the
    // contract decides on `block.timestamp`.
    const nowSeconds = await this.chainSeconds(input.chainId, asset);

    // 2. Canonical form.
    let message: ChannelVoucherMessage;
    try {
      message = parseChannelVoucher(input.envelope.voucher, input.envelope.signature);
    } catch (error) {
      if (error instanceof ChannelVoucherShapeError) {
        throw PaymentErrors.voucherMalformed({ field: error.field, reason: error.reason });
      }
      throw error;
    }
    const signature = (input.envelope.signature as string).toLowerCase() as `0x${string}`;
    const timing = channelTimeRefusal(message, nowSeconds);
    if (timing) {
      if (timing.expired) {
        throw PaymentErrors.voucherExpired({
          expiresAt: Number(message.expiresAt),
          now: nowSeconds,
        });
      }
      throw PaymentErrors.voucherMalformed({ field: timing.field, reason: timing.reason });
    }

    // 3. Binding.
    const payerAddress = checksumAddress(parseAccountId(input.agentAccount).address);
    const providerAddress = checksumAddress(parseAccountId(input.providerAccount).address);
    if (message.payer !== payerAddress) {
      throw PaymentErrors.voucherBindingMismatch({
        field: 'payer',
        expected: payerAddress,
        actual: message.payer,
      });
    }
    if (message.provider !== providerAddress) {
      throw PaymentErrors.voucherBindingMismatch({
        field: 'provider',
        expected: providerAddress,
        actual: message.provider,
      });
    }
    const price = BigInt(input.price.amount);
    if (price <= 0n) {
      throw PaymentErrors.voucherBindingMismatch({ field: 'price', expected: '> 0', actual: '0' });
    }

    // 4. Signer.
    const { signer, terms, readAt } = await this.signer(input, message, signature, nowSeconds);
    this.blocklist.assertNotBlocked([
      { role: BlockedRole.PAYER, kind: BlockSubjectKind.WALLET, subject: input.agentAccount },
      { role: BlockedRole.PAYEE, kind: BlockSubjectKind.WALLET, subject: input.providerAccount },
      ...(terms
        ? [
            {
              role: BlockedRole.DELEGATE,
              kind: BlockSubjectKind.WALLET,
              subject: toAccountId(input.chainId, signer),
            },
          ]
        : []),
    ]);
    if (
      terms &&
      !sameAccountSpelling(toAccountId(input.chainId, signer), input.boundDelegate ?? '')
    ) {
      await this.assertChainActive({
        payer: input.agentAccount,
        payee: input.providerAccount,
        delegate: toAccountId(input.chainId, signer),
      });
    }
    // The per-call cap, as the contract averages it: one call, one price.
    if (input.escrow && price > input.escrow.maxVoucherAmount) {
      throw PaymentErrors.voucherEscrowLimitExceeded({
        limit: 'maxVoucherAmount',
        allowed: input.escrow.maxVoucherAmount.toString(),
      });
    }
    if (terms && price > terms.maxVoucherAmount) {
      throw PaymentErrors.voucherDelegateLimitExceeded({
        limit: 'maxVoucherAmount',
        allowed: terms.maxVoucherAmount.toString(),
      });
    }
    if (input.escrow && input.escrow.withdrawRequested > 0n) {
      throw PaymentErrors.withdrawalPending({});
    }

    const key = channelKeyOf(message.payer, signer, message.provider, message.channelId);
    const signerAccount = toAccountId(input.chainId, signer);
    const lane = {
      chainId: input.chainId,
      payer: input.agentAccount,
      signer: signerAccount,
      providerAccount: input.providerAccount,
      channelId: message.channelId,
    };

    // 5. Replay: the exact voucher again answers what it answered.
    const existing = await this.channels.findLaneByKey(input.chainId, key);
    if (existing) {
      // Only the session the lane is bound to gets a stored answer (L4).
      this.assertLaneBinding(existing, input, message);
      const replay = await this.channels.findReplay(
        existing.id,
        message.cumulative,
        message.calls,
        message,
      );
      if (replay?.intentId) {
        const intent = await this.intents.findById(existing.organizationId, replay.intentId);
        return {
          intent,
          replayed: true,
          channel: this.describe(message, key),
        };
      }
    } else {
      // 6. Open: the first voucher of a lane.
      if (message.cumulative !== price || message.calls !== 1) {
        throw ChannelErrors.desync({ channelId: message.channelId });
      }
      const books = await this.door.readBooks(asset, key);
      if (books === null || books.slot.settled !== 0n) {
        throw ChannelErrors.desync({ channelId: message.channelId });
      }
      // A fast refusal; the binding count is made again under the payer's lock (L5).
      const open = await this.channels.countOpen(this.channels.manager, input.agentAccount, asset);
      if (open >= this.maxOpen(input.chainId)) await this.refuseOpenCap(input, asset);
    }

    // 7. Under the payer's lock, atomic with the insert.
    const escrow = input.escrow;
    const lagged = (at: Date) => new Date(at.getTime() - VOUCHER_ADMISSION_CHAIN_LAG_MS);
    const escrowCarried =
      escrow === null
        ? 0n
        : decayVoucherWindow(escrow.spentInWindow, escrow.windowStartedAt, nowSeconds);
    let urgentReservation = false;
    let atCap: string | null = null;
    let created: PaymentIntent;
    try {
      created = await this.intents.create(
        {
          organizationId: input.organizationId,
          agentId: input.agentId,
          agentAccount: input.agentAccount,
          providerId: input.providerId,
          providerAccount: input.providerAccount,
          toolId: input.toolId,
          rail: PaymentRail.RAIL_B_VOUCHER,
          callId: randomUUID(),
          callClass: PaymentIntentCallClass.PAID,
          price: input.price,
          platformFee: input.platformFee,
          requestHash: input.requestHash,
          chainId: input.chainId,
          voucherResource: input.resource,
          voucherIssuedAt: Number(message.issuedAt),
          voucherDelegate: terms ? signerAccount : null,
          credentialId: input.credentialId,
          idempotencyKey: input.idempotencyKey,
          expiresAt: new Date(Number(message.expiresAt) * 1000),
          voucherFormat: VoucherFormat.CHANNEL,
          channelCumulative: message.cumulative.toString(),
          channelCalls: message.calls,
        },
        {
          scope: {
            payer: input.agentAccount,
            assetId: asset,
            delegate: terms ? signerAccount : null,
            escrowSince: lagged(escrow?.observedAt ?? readAt),
            delegateSince: terms ? lagged(readAt) : null,
            organizationId: input.organizationId,
          },
          admit: (open) => {
            this.admitReservation(open, input, price, escrowCarried, terms);
            if (escrow !== null && open.reserved !== undefined) {
              const available = BigInt(escrow.balance.amount) - escrow.withdrawRequested;
              urgentReservation = reservationUrgent(
                { availableAtomic: available, pendingAtomic: open.reserved, priceAtomic: price },
                this.policy.urgentReservationBps,
              );
            }
          },
          withinLock: async (manager, row) => {
            const id = await this.withinLock(
              manager,
              row,
              input,
              lane,
              key,
              message,
              signature,
              price,
              terms?.validUntil ?? null,
            );
            atCap = id.atCap;
          },
        },
      );
    } catch (error) {
      if (error instanceof LaneLimit) await this.refuseOpenCap(input, asset);
      if (error instanceof LanePendingCap) {
        // Settling clears it: a round is asked for, and the retry comes after it.
        await this.channels
          .requestUrgent({ channelRowId: error.channelRowId }, 'A_CAP')
          .catch(() => undefined);
        throw PaymentErrors.unsettledLimit({
          // The scheduler's cron runs on the wall clock.
          retryAfter: this.retryAfterRound(Math.floor(this.now() / 1000), error.settling),
          reason: 'CHANNEL_PENDING_CAP',
          pending: error.pending.toString(),
        });
      }
      if (error instanceof LaneReplay) {
        const intent = await this.intents.findById(error.organizationId, error.intentId);
        return { intent, replayed: true, channel: this.describe(message, key) };
      }
      if (error instanceof LaneDesync) {
        await this.channels.setStatus(
          error.channelRowId,
          VoucherChannelStatus.DESYNC,
          'CONTINUITY',
        );
        throw ChannelErrors.desync({ channelId: message.channelId });
      }
      if (
        isUniqueViolation(error, 'uq_voucher_channels_lane') ||
        isUniqueViolation(error, 'uq_voucher_channels_key')
      ) {
        // Two first vouchers raced on one lane: one opened it, this one is a different step.
        throw ChannelErrors.desync({ channelId: message.channelId });
      }
      throw error;
    }
    if (atCap) {
      await this.channels.requestUrgent({ channelRowId: atCap }, 'A_CAP').catch(() => undefined);
    }
    if (urgentReservation) {
      // "Start a round instead of refusing" (POLICY §2.3): the scheduler bounds it.
      await this.channels
        .requestUrgent({ payer: input.agentAccount, assetId: asset }, 'RESERVATION')
        .catch(() => undefined);
    }

    // The idempotency key answered an earlier attempt of this call.
    if (input.idempotencyKey && created.channelCumulative !== message.cumulative.toString()) {
      return { intent: created, replayed: true, channel: this.describe(message, key) };
    }

    await input.beforeHold?.();
    try {
      const secured = await this.intents.secureFunds(input.organizationId, created.id);
      return { intent: secured, replayed: false, channel: this.describe(message, key) };
    } catch (error) {
      // The step is accepted on the lane but holds nothing: the call is never
      // served, the row expires and is waived at settlement.
      await this.intents
        .abandonUnsecuredVoucher(input.organizationId, created.id)
        .catch(() => undefined);
      throw error;
    }
  }

  /**
   * A buyer-debt replacement on a channel (v3 §5.6): a RENEW of the exact
   * `(cumulative, calls)` pair of a voucher this lane already stored, with
   * fresh times, by the lane's own signer. Never a new pair, never another
   * lane. The lapsed calls up to that pair go back to settlement (REPLACING)
   * and an urgent round is asked for (SPEC-H H-1, bounded by the scheduler).
   */
  async renew(input: {
    organizationId: string;
    /** The calling session's agent: only the agent that opened the lane renews it (B-L1). */
    agentId: string;
    intentId: string;
    agentAccount: AccountId;
    boundDelegate: AccountId | null;
    envelope: { voucher: unknown; signature: unknown };
  }): Promise<{ intentId: string; replaced: number }> {
    const intent = await this.intents.findById(input.organizationId, input.intentId);
    if (intent.voucherFormat !== VoucherFormat.CHANNEL || !intent.channelRowId) {
      // A channel debt the payer settled per call left its lane for good
      // (client review M-2): renewing it would charge the call twice.
      if (await this.channels.replacedPerCall(intent.id)) {
        throw ChannelErrors.notOffered({
          reason:
            'this channel debt was settled with a per-call voucher; there is nothing to renew',
        });
      }
      throw ChannelErrors.notOffered({
        reason: 'this debt was paid per call; renew it with a voucher',
      });
    }
    const lane = await this.channels.findById(intent.channelRowId);
    if (!lane || !sameAccountSpelling(lane.payer, input.agentAccount)) {
      throw PaymentErrors.voucherBindingMismatch({
        field: 'payer',
        expected: lane?.payer ?? 'unknown',
        actual: input.agentAccount,
      });
    }
    // The lane's own organization and agent (sec-audit B-L1), as admission
    // binds it; a rotated API key of the same agent may still renew.
    if (lane.organizationId !== input.organizationId || lane.agentId !== input.agentId) {
      throw PaymentErrors.voucherBindingMismatch({
        field: 'agent',
        expected: 'the agent that opened this channel',
        actual: input.agentId,
      });
    }
    // Only a lapsed debt is renewed (review 2026-10-31 L6): this call must be
    // one of the lane's open or written-off debts, not replaced yet.
    const debts = await this.channels.lapsedDebtsUpTo(
      lane.id,
      BigInt(intent.channelCumulative ?? '0'),
    );
    const own = debts.find((d) => d.intentId === intent.id);
    if (!own) throw PaymentErrors.debtNotFound({ intentId: intent.id });
    if (own.replaced) throw PaymentErrors.debtReplacementPending({ intentId: intent.id });
    // Fast refusal before any signature work; the binding check is repeated
    // under the payer's lock below (re-review L4).
    await this.refuseRenewRate(lane.id);
    let message: ChannelVoucherMessage;
    try {
      message = parseChannelVoucher(input.envelope.voucher, input.envelope.signature);
    } catch (error) {
      if (error instanceof ChannelVoucherShapeError) {
        throw PaymentErrors.voucherMalformed({ field: error.field, reason: error.reason });
      }
      throw error;
    }
    const signature = (input.envelope.signature as string).toLowerCase() as `0x${string}`;
    const nowSeconds = await this.chainSeconds(lane.chainId, lane.assetId as AssetId);
    const timing = channelTimeRefusal(message, nowSeconds);
    if (timing)
      throw PaymentErrors.voucherMalformed({ field: timing.field, reason: timing.reason });
    if (
      message.channelId !== lane.channelId.toLowerCase() ||
      message.provider !==
        checksumAddress(parseAccountId(lane.providerAccount as AccountId).address)
    ) {
      throw PaymentErrors.voucherBindingMismatch({
        field: 'channelId',
        expected: lane.channelId,
        actual: message.channelId,
      });
    }
    const { signer } = await this.signer(
      {
        chainId: lane.chainId as ChainId,
        agentAccount: input.agentAccount,
        boundDelegate: input.boundDelegate,
      } as AdmitChannelCallInput,
      message,
      signature,
      nowSeconds,
    );
    if (
      channelKeyOf(message.payer, signer, message.provider, message.channelId) !==
      lane.channelKey.toLowerCase()
    ) {
      throw PaymentErrors.voucherSignatureInvalid({ payer: input.agentAccount });
    }
    // Only a pair this lane already signed: the renew moves no value.
    const stored = await this.channels.vouchers(lane.id, BigInt(lane.settledCumulative));
    const pair = stored.find(
      (v) => BigInt(v.cumulative) === message.cumulative && v.calls === message.calls,
    );
    if (!pair || message.cumulative < BigInt(intent.channelCumulative ?? '0')) {
      throw ChannelErrors.desync({ channelId: message.channelId });
    }
    // At most one renew per lane per urgent interval (each inserts a voucher
    // row and asks for an urgent round): the rate read, the insert and the
    // REPLACING mark run in one transaction under the payer's admission lock,
    // so two concurrent renews cannot both pass the read (re-review L4).
    let replaced = await this.channels.manager.transaction(async (manager) => {
      await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `voucher-admission:${input.agentAccount}`,
      ]);
      await this.refuseRenewRate(lane.id, manager);
      await this.channels.insertVoucher(manager, {
        channelRowId: lane.id,
        intentId: null,
        cumulative: message.cumulative.toString(),
        calls: message.calls,
        issuedAt: message.issuedAt.toString(),
        expiresAt: message.expiresAt.toString(),
        signature,
      });
      return this.channels.markReplaced(lane.id, message.cumulative, manager);
    });
    // A WRITTEN-OFF debt had its hold released: a fresh one is opened, priced
    // against the chain, so the renew settles it like any other and its
    // refusal ends once it is held (review 2026-10-31 H6).
    for (const debt of await this.channels.lapsedDebtsUpTo(lane.id, message.cumulative)) {
      if (!debt.writtenOff || debt.replaced) continue;
      const row = await this.intents
        .findById(input.organizationId, debt.intentId)
        .catch(() => null);
      if (!row) continue;
      const holdId = await this.intents.reopenDebtHold({
        id: row.id,
        organizationId: row.organizationId,
        agentAccount: row.agentAccount,
        assetId: row.price.asset,
        decimals: row.price.decimals,
        priceAmount: row.price.amount,
      } as never);
      if (await this.channels.markWrittenOffReplaced(lane.id, row.id, holdId)) {
        replaced += 1;
      } else {
        await this.intents.releaseUnusedHold(row.organizationId, holdId).catch(() => undefined);
      }
    }
    await this.channels.requestUrgent({ channelRowId: lane.id }, 'DEBT');
    return { intentId: intent.id, replaced };
  }

  /** `PAYMENT_UNSETTLED_LIMIT` (`CHANNEL_RENEW_RATE`) while the lane renewed within the urgent interval. */
  /**
   * One renew per lane per `urgentIntervalSeconds`. The age of the last renew
   * is computed by the database from its own `received_at` (`now() -
   * MAX(received_at)`): ONE clock (final review backend F5), never the app
   * clock against the database's.
   */
  private async refuseRenewRate(channelRowId: string, manager?: EntityManager): Promise<void> {
    const interval = this.policy.urgentIntervalSeconds * 1000;
    let ageMs: number | null;
    if (typeof this.channels.lastRenewAgeSeconds === 'function') {
      const age = await this.channels.lastRenewAgeSeconds(channelRowId, manager);
      ageMs = age === null ? null : age * 1000;
    } else {
      const last = await this.channels.lastRenewAt(channelRowId, manager);
      ageMs = last ? this.now() - last.getTime() : null;
    }
    if (ageMs !== null && ageMs < interval) {
      throw PaymentErrors.unsettledLimit({
        retryAfter: Math.ceil((interval - ageMs) / 1000),
        reason: 'CHANNEL_RENEW_RATE',
      });
    }
  }

  /** The lane's checks and writes, under the payer's lock (see the class comment, step 7). */
  private async withinLock(
    manager: EntityManager,
    row: Partial<PaymentIntentEntity>,
    input: AdmitChannelCallInput,
    lane: {
      chainId: string;
      payer: string;
      signer: string;
      providerAccount: string;
      channelId: string;
    },
    key: `0x${string}`,
    message: ChannelVoucherMessage,
    signature: string,
    price: bigint,
    signerValidUntil: number | null,
  ): Promise<{ atCap: string | null }> {
    let channel = await this.channels.lockLane(manager, lane, key);
    if (!channel) {
      // Under the payer's advisory lock: two concurrent opens cannot both pass (L5).
      const open = await this.channels.countOpen(manager, input.agentAccount, input.price.asset);
      if (open >= this.maxOpen(input.chainId)) throw new LaneLimit();
      channel = await this.channels.insertLane(manager, {
        chainId: lane.chainId,
        assetId: input.price.asset,
        payer: lane.payer,
        signer: lane.signer,
        providerAccount: lane.providerAccount,
        providerId: input.providerId,
        channelId: lane.channelId,
        channelKey: key.toLowerCase(),
        organizationId: input.organizationId,
        agentId: input.agentId,
        credentialId: input.credentialId,
      });
    }
    // A concurrent copy of this very voucher won the lock: answer what it got.
    const replay = await this.channels.findReplay(
      channel.id,
      message.cumulative,
      message.calls,
      message,
      manager,
    );
    if (replay?.intentId) {
      this.assertLaneBinding(channel, input, message);
      throw new LaneReplay(channel.organizationId, replay.intentId);
    }
    this.assertLaneOpen(channel, input, message);
    const lastCumulative = BigInt(channel.lastAcceptedCumulative);
    if (
      message.cumulative !== lastCumulative + price ||
      message.calls !== channel.lastAcceptedCalls + 1 ||
      (channel.lastIssuedAt !== null && Number(message.issuedAt) < Number(channel.lastIssuedAt))
    ) {
      throw new LaneDesync(channel.id);
    }
    if (message.calls + 1 >= CHANNEL_CALLS_LIMIT) {
      throw ChannelErrors.rotate({ channelId: message.channelId, reason: 'CALLS_LIMIT' });
    }
    // A_cap: the channel's unsettled value. Settling clears it, so the refusal is retryable.
    const pending = await this.channels.pendingOf(manager, channel.id);
    if (pending + price > this.policy.aCapAtomic) {
      throw new LanePendingCap(channel.id, pending, (channel.settlingTo ?? null) !== null);
    }
    row.channelRowId = channel.id;
    const voucherId = await this.channels.insertVoucher(manager, {
      channelRowId: channel.id,
      intentId: row.id as string,
      cumulative: message.cumulative.toString(),
      calls: message.calls,
      issuedAt: message.issuedAt.toString(),
      expiresAt: message.expiresAt.toString(),
      signature,
    });
    const moved = await this.channels.advanceAccepted(
      manager,
      channel.id,
      { cumulative: lastCumulative, calls: channel.lastAcceptedCalls },
      {
        cumulative: message.cumulative,
        calls: message.calls,
        issuedAt: Number(message.issuedAt),
        signerValidUntil: signerValidUntil,
      },
    );
    if (!moved) throw new LaneDesync(channel.id);
    this.logger.debug(`channel ${key}: voucher ${voucherId} admitted at ${message.cumulative}`);
    return { atCap: pending + price * 2n > this.policy.aCapAtomic ? channel.id : null };
  }

  private assertLaneOpen(
    channel: VoucherChannelEntity,
    input: AdmitChannelCallInput,
    message: ChannelVoucherMessage,
  ): void {
    if (
      channel.status === VoucherChannelStatus.ROTATED ||
      channel.status === VoucherChannelStatus.CLOSED ||
      channel.status === VoucherChannelStatus.REVOKED
    ) {
      throw ChannelErrors.rotate({
        channelId: message.channelId,
        reason: channel.statusReason ?? channel.status,
      });
    }
    if (channel.status !== VoucherChannelStatus.OPEN) {
      throw ChannelErrors.desync({ channelId: message.channelId });
    }
    this.assertLaneBinding(channel, input, message);
  }

  /**
   * Bound at open: another session on the lane is refused (v3 §5.3.3) — also
   * for a replay, which must not hand one tenant's stored intent to another
   * that shares the payer key (review 2026-10-31 L4). A rotated API key opens
   * new channels.
   */
  private assertLaneBinding(
    channel: VoucherChannelEntity,
    input: Pick<AdmitChannelCallInput, 'organizationId' | 'agentId' | 'credentialId'>,
    message: ChannelVoucherMessage,
  ): void {
    if (
      channel.organizationId !== input.organizationId ||
      channel.agentId !== input.agentId ||
      (channel.credentialId ?? null) !== (input.credentialId ?? null)
    ) {
      throw ChannelErrors.desync({ channelId: message.channelId });
    }
  }

  /** The open-channel cap on `chainId` (4 on mainnet whatever the env says, L2). */
  private maxOpen(chainId: string): number {
    return maxOpenChannelsOn(chainId, this.policy.maxOpenPerPayer);
  }

  /** `CHANNEL_LIMIT`, after asking for a round: settling frees lanes (POLICY §2.3). */
  private async refuseOpenCap(input: AdmitChannelCallInput, asset: AssetId): Promise<never> {
    await this.channels
      .requestUrgent({ payer: input.agentAccount, assetId: asset }, 'CHANNEL_CAP')
      .catch(() => undefined);
    throw ChannelErrors.limit({
      retryAfter: this.policy.tickSeconds * 2,
      maxOpenChannels: this.maxOpen(input.chainId),
    });
  }

  /**
   * Seconds until a retry can pass after an A_cap refusal: the next scheduler
   * tick (which runs the urgent round), plus one tick for the settle to land;
   * one tick when a settlement is already in flight.
   */
  private retryAfterRound(nowSeconds: number, settling: boolean): number {
    const tick = this.policy.tickSeconds;
    if (settling) return tick;
    const toTick = (CHANNEL_TICK_SECOND - (nowSeconds % tick) + tick) % tick || tick;
    return toTick + tick;
  }

  /**
   * The chain's time (the latest block's timestamp), read at most every
   * {@link CHAIN_CLOCK_TTL_MS} and advanced by the wall clock in between; the
   * wall clock when the chain cannot be read (review 2026-10-31 M7).
   */
  private async chainSeconds(chainId: string, asset: AssetId): Promise<number> {
    const wall = this.now();
    const cached = this.chainClock.get(chainId);
    if (cached && wall - cached.readAt < CHAIN_CLOCK_TTL_MS) {
      return cached.chainSeconds + Math.floor((wall - cached.readAt) / 1000);
    }
    if (typeof this.door.chainNow === 'function') {
      try {
        const chainSeconds = await this.door.chainNow(asset);
        if (Number.isFinite(chainSeconds) && chainSeconds > 0) {
          this.chainClock.set(chainId, { chainSeconds, readAt: wall });
          return chainSeconds;
        }
      } catch (error) {
        this.logger.warn(`chain time on ${chainId} unreadable, using the wall clock: ${error}`);
      }
    }
    return Math.floor(wall / 1000);
  }

  /**
   * The ONE reservation across both doors and every provider (SPEC-W2 §4,
   * POLICY §2.3), with the per-call checks under the same lock: an admission
   * pause, a debt, affordability against the balance less every open hold and
   * in-flight admission, and both windows against everything the chain has
   * not counted yet.
   */
  private admitReservation(
    open: OpenVoucherTotals,
    input: AdmitChannelCallInput,
    price: bigint,
    escrowCarried: bigint,
    terms: VoucherDelegationTerms | null,
  ): void {
    if (open.pausedFor) throw PaymentErrors.voucherAdmissionPaused({ retryAfter: open.pausedFor });
    if (open.debts) {
      throw PaymentErrors.debtOutstanding({
        count: open.debts,
        settleWith: 'GET /escrow/debts, then POST /escrow/debts/{intentId}/voucher',
      });
    }
    const escrow = input.escrow;
    if (escrow !== null && open.reserved !== undefined) {
      const available = BigInt(escrow.balance.amount) - escrow.withdrawRequested;
      const spendable = available > open.reserved ? available - open.reserved : 0n;
      if (spendable < price) {
        throw LedgerErrors.insufficientAvailableBalance({
          accountId: input.agentAccount,
          required: price.toString(),
          available: spendable.toString(),
        });
      }
    }
    if (escrow !== null) {
      const used = escrowCarried + open.escrow;
      if (used + price > escrow.maxPerWindow) {
        throw PaymentErrors.voucherEscrowLimitExceeded({
          limit: 'maxPerWindow',
          allowed: (escrow.maxPerWindow > used ? escrow.maxPerWindow - used : 0n).toString(),
        });
      }
    }
    if (terms !== null) {
      const used = terms.carriedInWindow + open.delegate;
      if (used + price > terms.maxPerWindow) {
        throw PaymentErrors.voucherDelegateLimitExceeded({
          limit: 'maxPerWindow',
          allowed: (terms.maxPerWindow > used ? terms.maxPerWindow - used : 0n).toString(),
        });
      }
    }
  }

  private async signer(
    input: AdmitChannelCallInput,
    message: ChannelVoucherMessage,
    signature: `0x${string}`,
    nowSeconds: number,
  ): Promise<{ signer: `0x${string}`; terms: VoucherDelegationTerms | null; readAt: Date }> {
    const adapter = this.chains.resolve(input.chainId);
    if (typeof adapter.authorizeChannelSigner !== 'function') {
      throw ChannelErrors.notOffered({ reason: 'this chain has no channel door' });
    }
    const readAt = new Date();
    const answer = await adapter.authorizeChannelSigner(
      input.agentAccount,
      message,
      signature,
      nowSeconds,
    );
    if (answer.kind === VoucherAuthorityKind.PAYER) {
      return { signer: message.payer, terms: null, readAt };
    }
    if (answer.kind === VoucherAuthorityKind.DELEGATE) {
      const bound = input.boundDelegate;
      if (bound === null || !sameAccountSpelling(bound, answer.delegate)) {
        throw PaymentErrors.voucherDelegateNotBound({ delegate: answer.delegate, bound });
      }
      // Refused after `validUntil − (U + O + tick)`: a settle must land before the grant ends.
      const margin = this.policy.deadlineMarginSeconds + this.policy.tickSeconds;
      if (nowSeconds > answer.terms.validUntil - margin) {
        throw ChannelErrors.signerExpiring({
          validUntil: new Date(answer.terms.validUntil * 1000).toISOString(),
        });
      }
      return {
        signer: checksumAddress(parseAccountId(answer.delegate).address),
        terms: answer.terms,
        readAt,
      };
    }
    if (
      answer.reason === VoucherAuthorityRefusal.DELEGATE_REVOKED ||
      answer.reason === VoucherAuthorityRefusal.DELEGATE_EXPIRED
    ) {
      throw PaymentErrors.voucherDelegateInactive({
        payer: input.agentAccount,
        delegate: answer.signer,
        reason: answer.reason,
      });
    }
    throw PaymentErrors.voucherSignatureInvalid({ payer: input.agentAccount });
  }

  private describe(message: ChannelVoucherMessage, key: string) {
    return {
      channelId: message.channelId,
      cumulative: message.cumulative.toString(),
      calls: message.calls,
      key,
    };
  }
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  const violation = error as { code?: string; constraint?: string };
  return violation?.code === '23505' && violation.constraint === constraint;
}
