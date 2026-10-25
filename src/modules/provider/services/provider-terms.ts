import { ConfigService } from '@nestjs/config';

import { parsePenaltySplitBps } from '@modules/chains/evm/chain-params-fallback';
import { chainIdOf } from '@modules/chains/ports/caip.types';
import { ChainParams, ChainParamsPort } from '@modules/chains/ports/chain-params.port';
import { Money } from '@modules/chains/ports/money.types';
import { platformTakeRatePercent } from '@modules/mcp/services/mcp-pricing.config';
import { loadCollectionHoldWindowSeconds } from '@modules/payment/constants/collection-hold.constants';
import { MinimumStakeParameters } from '@modules/tool/domain/routing/routing.types';
import { durationText } from '@shared/utils/duration-text.util';
import { MoneyUtil } from '@shared/utils/money.util';

import { loadMinimumStakeParameters } from './provider-stake.service';

/** DI token for a {@link ProviderTermsSource}. */
export const PROVIDER_TERMS = 'PROVIDER_TERMS';

/** The published terms, built at every call from the live values (never once at boot). */
export interface ProviderTermsSource {
  current(): ProviderTerms;
}

/**
 * The terms of the platform stake chain, from the routing floor the Capital
 * screen shows (`PROVIDER_MINIMUM_STAKE_PARAMETERS`, the contract's minimum
 * once read) and the on-chain params cache. Rebuilt per call, so a changed
 * contract value shows on the next request.
 */
export function providerTermsSource(
  config: ConfigService,
  stake: MinimumStakeParameters | null,
  params: ChainParamsPort | null,
): ProviderTermsSource {
  return {
    current: () =>
      loadProviderTerms(config, {
        minimumStake: stake?.floor ?? null,
        params: stake ? (params?.current(chainIdOf(stake.floor.asset)) ?? null) : null,
      }),
  };
}

/** What the chain says, when it was read; each `null` falls back to config. */
export interface ProviderTermsLiveValues {
  readonly minimumStake?: Money | null;
  readonly params?: ChainParams | null;
}

/**
 * One row of the commercial-terms table (onboarding step 4).
 *
 * `label`/`value`/`caption` are already the strings the console renders — the
 * table is presentation content, not a set of numbers a client is expected to
 * recompute or reason about. `key` exists only so a client can diff the table
 * across a terms-version bump without string-matching on `label`.
 */
export interface ProviderCommercialTerm {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly caption: string;
}

/**
 * The published terms — three document versions plus the commercial terms
 * table, as of right now. There is exactly one current version of each
 * document; there is no history here and no "what a provider agreed to
 * last year" — that lives on the row, in `AcceptedTerms`
 * (`ports/provider-registration.types.ts`), not in this port.
 */
export interface ProviderTerms {
  readonly providerAgreementVersion: string;
  readonly payoutTermsVersion: string;
  readonly slashPolicyVersion: string;
  /** The acceptance checkbox line, built from the three versions above. */
  readonly acceptanceLine: string;
  readonly commercialTerms: readonly ProviderCommercialTerm[];
}

/**
 * Reads the published terms from configuration, in the style of
 * `loadMinimumStakeParameters` — same idea: a value the platform can move
 * without a deploy, with a default that matches what is currently true.
 *
 * ## The one row this function does not get to invent
 *
 * The onboarding mockup printed "Stake required $100 minimum". That number was
 * typed into a mockup, not read from anywhere the platform enforces.
 * The number the platform actually enforces is `PROVIDER_MINIMUM_STAKE_FLOOR`
 * (default `50000000`, i.e. $50 USDC at 6 decimals) via `minimumStakeFor` in
 * `tool/domain/routing/stake-gate.ts` — the same floor `ProviderStakeService`
 * reports on `GET /providers/me/stake` and the same one the router's stake
 * gate actually rejects calls against. Printing the mockup's `$100` here would
 * make the onboarding screen tell a provider a number the gate does not agree
 * with — first noticed on the day their stake sits at $75 and the screen said
 * they had cleared the bar. So this function calls the same
 * `loadMinimumStakeParameters` the stake endpoint calls, rather than a second,
 * independently-typed constant, and renders whatever that returns. Code wins
 * over the mockup.
 */
export function loadProviderTerms(
  config: ConfigService,
  live: ProviderTermsLiveValues = {},
): ProviderTerms {
  const providerAgreementVersion = config.get<string>('PROVIDER_TERMS_AGREEMENT_VERSION') ?? 'v1.0';
  const payoutTermsVersion = config.get<string>('PROVIDER_TERMS_PAYOUT_VERSION') ?? 'v1.0';
  const slashPolicyVersion = config.get<string>('PROVIDER_TERMS_SLASH_POLICY_VERSION') ?? 'v1.0';

  const params = live.params ?? null;
  // The rate a call is actually charged at: the contract's `takeRateBps` once
  // read, `PLATFORM_FEE_BPS` until then (R17-R-03).
  const takeRatePercent =
    params?.takeRateBps !== null && params?.takeRateBps !== undefined
      ? params.takeRateBps / 100
      : platformTakeRatePercent(config);
  const reserveHeldUsd = config.get<string>('PROVIDER_TERMS_RESERVE_HELD_USD') ?? '0.00';
  const clawback = config.get<string>('PROVIDER_TERMS_CLAWBACK') ?? 'never';
  const slashTrigger = config.get<string>('PROVIDER_TERMS_SLASH_TRIGGER') ?? 'DATA_FAIL only';
  const split = penaltySplitOf(config, params);
  const hold = durationText(
    params?.collectHoldSeconds ??
      loadCollectionHoldWindowSeconds({
        CALL_DISPUTE_HOLD_WINDOW_MINUTES: config.get<string>('CALL_DISPUTE_HOLD_WINDOW_MINUTES'),
      } as NodeJS.ProcessEnv),
  );

  // The real floor — see the function comment: the routing floor (the
  // contract's minimum once read), else `PROVIDER_MINIMUM_STAKE_FLOOR` via
  // `loadMinimumStakeParameters`, the pair `ProviderStakeService` reads, so
  // this table and that endpoint cannot print two different numbers.
  const stakeFloor = live.minimumStake ?? loadMinimumStakeParameters(config).floor;
  const stakeRequiredValue = `$${toDisplayAmount(stakeFloor)} minimum`;

  return {
    providerAgreementVersion,
    payoutTermsVersion,
    slashPolicyVersion,
    acceptanceLine:
      `I accept the provider agreement ${providerAgreementVersion}, the payout terms ` +
      `${payoutTermsVersion} and the slash policy ${slashPolicyVersion}`,
    commercialTerms: [
      {
        key: 'takeRate',
        label: 'Take rate',
        value: `${takeRatePercent}%`,
        caption: 'flat, no per-call fee floor',
      },
      {
        key: 'payouts',
        label: 'Payouts',
        // There is no payout batch: a provider is paid on chain when each
        // call's voucher is redeemed, and the payment is final once the
        // buyer report window (the on-chain collect hold) has closed.
        value: 'as each call settles',
        caption: `on chain; final ${hold} after each call`,
      },
      {
        key: 'reserveHeld',
        label: 'Reserve held',
        value: `$${reserveHeldUsd}`,
        caption: `no standing reserve; each paid call is held ${hold} for buyer reports`,
      },
      {
        key: 'clawback',
        label: 'Clawback',
        value: clawback,
        caption: 'a paid payout stays paid',
      },
      {
        key: 'stakeRequired',
        label: 'Stake required',
        value: stakeRequiredValue,
        caption: 'before paid traffic — the free path needs none',
      },
      {
        key: 'slashedWhen',
        label: 'Slashed when',
        value: slashTrigger,
        caption: 'never for upstream failure or a bad request from the agent',
      },
      {
        key: 'penaltySplit',
        label: 'Where a penalty goes',
        value: split.value,
        caption: split.caption,
      },
      ...(params?.unbondingPeriodSeconds
        ? [
            {
              key: 'unbondingPeriod',
              label: 'Unbonding',
              value: durationText(params.unbondingPeriodSeconds),
              caption: 'a stake withdrawal waits this long on chain before it can be claimed',
            },
          ]
        : []),
    ],
  };
}

/**
 * A money amount as a price tag, not as a ledger value.
 *
 * `MoneyUtil.format` renders every one of the asset's decimals — `50.000000`
 * for USDC — which is right for a ledger line, where a truncated fraction is a
 * lost cent, and wrong for a terms table, where a provider reading
 * "$50.000000 minimum" learns that a machine wrote it. So this trims to two
 * decimals *for display only*, and never rounds up: a floor shown as lower
 * than it is would be a bar somebody clears on screen and fails at the gate.
 * Truncation is the safe direction, and the stake floors this renders are
 * whole dollars anyway.
 */
function toDisplayAmount(money: Money): string {
  const [whole, fraction = ''] = MoneyUtil.format(money).split('.');
  return `${whole}.${fraction.slice(0, 2).padEnd(2, '0')}`;
}

/**
 * The penalty split row: the contract's `slashAgentBps` / `slashPlatformBps`
 * once read (the provider keeps the rest), else `PROVIDER_TERMS_PENALTY_SPLIT`.
 */
function penaltySplitOf(
  config: ConfigService,
  params: ChainParams | null,
): { value: string; caption: string } {
  const configured = config.get<string>('PROVIDER_TERMS_PENALTY_SPLIT') ?? '60 / 30 / 10';
  const bps =
    params?.slashAgentBps !== null &&
    params?.slashAgentBps !== undefined &&
    params.slashPlatformBps !== null
      ? { agentBps: params.slashAgentBps, platformBps: params.slashPlatformBps }
      : parsePenaltySplitBps(configured);
  if (!bps) {
    return {
      value: configured,
      caption: 'to the agent served the bad result, the platform, and what stays yours',
    };
  }
  const agent = bps.agentBps / 100;
  const platform = bps.platformBps / 100;
  const provider = (10_000 - bps.agentBps - bps.platformBps) / 100;
  return {
    value: `${agent} / ${platform} / ${provider}`,
    caption:
      `${agent}% to the agent served the bad result, ${platform}% platform, ` +
      `${provider}% stays yours`,
  };
}
