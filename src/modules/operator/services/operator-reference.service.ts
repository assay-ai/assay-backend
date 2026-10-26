import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ProviderRepository } from '@database/postgres/repositories/provider.repository';
import { VerificationPolicyEntity } from '@database/postgres/entities/verification-policy.entity';
import { VerificationPolicyRepository } from '@database/postgres/repositories/verification-policy.repository';
import { VerifierSigningKeyEntity } from '@database/postgres/entities/verifier-signing-key.entity';
import { VerifierSigningKeyRepository } from '@database/postgres/repositories/verifier-signing-key.repository';
import { ChainId } from '@modules/chains/ports/caip.types';
import {
  CHAIN_PARAMS,
  ChainParams,
  ChainParamsPort,
} from '@modules/chains/ports/chain-params.port';
import { Money } from '@modules/chains/ports/money.types';
import { PolicyLifecycle } from '@modules/verification/domain/aggregation/decision-policy.types';
import {
  PROVIDER_REGISTRY,
  ProviderRegistryPort,
} from '@modules/provider/ports/provider-registry.port';
import { platformTakeRatePercent } from '@modules/mcp/services/mcp-pricing.config';
import { loadMinimumStakeParameters } from '@modules/provider/services/provider-stake.service';
import {
  RegisteredVerifierStatus,
  VERIFIER_REGISTRY,
  VerifierRegistryPort,
} from '@modules/verification/signing/ports/verifier-registry.port';
import { MoneyUtil } from '@shared/utils/money.util';

import { OperatorRole, OVERRIDE_CODES, OVERRIDE_REGISTER } from '../domain/override-register';
import {
  EconomicParameterRowDto,
  OverrideRegisterRowDto,
  PolicyLifecycleRowDto,
  VerifierRegistryRowDto,
} from '../dto/operator-reference.dto';

/**
 * The three read-only reference panels behind `GET /operator/policies`,
 * `/verifiers`, `/economics` and `/override-register`.
 *
 * Thin on purpose, in the style of `ProviderSlaWindowsService`: each method
 * reads what it needs, derives what it honestly can, and returns `null`
 * rather than a guess for anything it cannot — see each DTO field's own doc
 * for exactly where that line falls.
 */
@Injectable()
export class OperatorReferenceService {
  private readonly logger = new Logger(OperatorReferenceService.name);

  constructor(
    private readonly policies: VerificationPolicyRepository,
    private readonly verifierKeys: VerifierSigningKeyRepository,
    @Inject(VERIFIER_REGISTRY) private readonly verifierRegistry: VerifierRegistryPort,
    private readonly providers: ProviderRepository,
    @Inject(PROVIDER_REGISTRY) private readonly providerRegistry: ProviderRegistryPort,
    private readonly config: ConfigService,
    // The settlement contracts' own parameters (the on-chain params cache) —
    // the values the operator Contracts page reads. Optional so a process (or
    // a test) without it still lists the panel from config.
    @Optional()
    @Inject(CHAIN_PARAMS)
    private readonly chainParams: ChainParamsPort | null = null,
  ) {}

  // ── Policy lifecycle ─────────────────────────────────────────────────────

  /**
   * One row per `policyId` — the version `VerificationPolicyRepository.findServing`
   * would resolve for it: `ACTIVE` if one exists, else the newest `SHADOW`,
   * else the newest of whatever remains. `find()` here is the plain,
   * unguarded method `AbstractRepository` inherits from TypeORM's own
   * `Repository` — `VerificationPolicyRepository` carries no organization
   * guard to begin with (see the entity: the catalogue is platform-level),
   * so this is not a scope exception, just a read of every row.
   */
  async listPolicies(): Promise<PolicyLifecycleRowDto[]> {
    const rows = await this.policies.find({
      order: { policyId: 'ASC', policyVersion: 'DESC' },
    });

    const byPolicyId = new Map<string, VerificationPolicyEntity[]>();
    for (const row of rows) {
      const group = byPolicyId.get(row.policyId) ?? [];
      group.push(row);
      byPolicyId.set(row.policyId, group);
    }

    return [...byPolicyId.values()]
      .map((versions) => toPolicyRow(currentVersionOf(versions)))
      .sort((a, b) => a.policyId.localeCompare(b.policyId));
  }

  // ── Verifier registry ────────────────────────────────────────────────────

  /**
   * The verifier signing keys this deployment has ever known about
   * (`verifier_signing_keys`), each cross-referenced against the on-chain
   * allowlist right now.
   *
   * `VerifierRegistryPort` has no bulk read — it was deliberately given
   * only a single-key `lookup`, so `slash`'s attestation check never depends
   * on an enumeration RPC. This does `N` single lookups in parallel instead,
   * which is the pattern the port leaves available for it; `N` is the number of
   * signing keys this platform has ever rotated through, not the number of
   * verifiers on chain, and is small by construction.
   */
  async listVerifiers(): Promise<VerifierRegistryRowDto[]> {
    const rows = await this.verifierKeys.findAllOrdered();
    return Promise.all(rows.map((row) => this.toVerifierRow(row)));
  }

  private async toVerifierRow(row: VerifierSigningKeyEntity): Promise<VerifierRegistryRowDto> {
    const publicKeyBytes = Buffer.from(row.publicKey, 'hex');
    // The chain the key signs for, off the row. `chain_id` is NOT NULL since
    // the per-chain migration, so this needs no fallback — and a fallback is
    // exactly what would send an EVM key's lookup to the Solana registry.
    const chainId = row.chainId as ChainId;
    // Prefer the cached on-chain address so a truncated key never needs a
    // round trip on its own; `addressOf` is a pure rendering, not an RPC call,
    // so falling back to it costs nothing when the cache is empty.
    const address = row.chainAddress ?? this.verifierRegistry.addressOf(chainId, publicKeyBytes);
    const truncatedKey = truncateAddress(address);

    try {
      const entry = await this.verifierRegistry.lookup(chainId, publicKeyBytes);
      if (!entry) {
        return {
          verifierId: row.keyId,
          truncatedKey,
          state: null,
          unreadableReason: 'never registered on the on-chain allowlist',
          expiresAt: null,
        };
      }
      return {
        verifierId: row.keyId,
        truncatedKey,
        state: entry.status === RegisteredVerifierStatus.ACTIVE ? 'approved' : 'revoked',
        unreadableReason: null,
        expiresAt: entry.expiresAt.toISOString(),
      };
    } catch (error) {
      // The chain is unreachable, or the account did not decode as a
      // `VerifierKey`. Either way this is one row of a list, not the whole
      // request — degrade this row to unknown rather than fail the panel.
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Verifier registry lookup failed for ${row.keyId}: ${reason}`);
      return {
        verifierId: row.keyId,
        truncatedKey,
        state: null,
        // Fixed text: the error can carry an internal RPC address; the log has it.
        unreadableReason: 'chain unreadable',
        expiresAt: null,
      };
    }
  }

  // ── Economic parameters ──────────────────────────────────────────────────

  /**
   * The six economic parameters. Each is the settlement contracts' own value
   * (the on-chain params cache, `source: 'chain'`) once a chain was read, and
   * the env value kept as its fallback (`source: 'config'`) until then: the
   * take rate (`takeRateBps` / `PLATFORM_FEE_BPS`), the minimum stake
   * (`minimumStake` / `PROVIDER_MINIMUM_STAKE_FLOOR`), the per-record penalty
   * ceiling (`penaltyAmount`, no env fallback) and the split
   * (`slashAgentBps` / `slashPlatformBps` / `PROVIDER_TERMS_PENALTY_SPLIT`).
   * One value when the chains agree, one `chain value` pair per chain when
   * they do not.
   */
  async listEconomicParameters(): Promise<EconomicParameterRowDto[]> {
    const read = (this.chainParams?.all() ?? []).filter((params) => params.source === 'chain');
    const stakeParameters = loadMinimumStakeParameters(this.config);
    const minimumStakeOverrideCount = await this.minimumStakeOverrideCount();
    const split = parsePenaltySplit(
      this.config.get<string>('PROVIDER_TERMS_PENALTY_SPLIT') ?? '60 / 30 / 10',
    );
    const percent = (bps: number | null) => (bps === null ? null : `${bps / 100}%`);

    return [
      chainRow('takeRate', 'Take rate', read, (params) => percent(params.takeRateBps), {
        value: `${platformTakeRatePercent(this.config)}%`,
        note: null,
      }),
      this.minimumStakeRow(read, toDisplayAmount(stakeParameters.floor), minimumStakeOverrideCount),
      this.penaltySizeRow(read),
      chainRow('splitAgent', 'Split — agent', read, (params) => percent(params.slashAgentBps), {
        value: split?.agent ?? null,
        note: split ? null : SPLIT_MALFORMED,
      }),
      chainRow(
        'splitPlatform',
        'Split — platform',
        read,
        (params) => percent(params.slashPlatformBps),
        { value: split?.platform ?? null, note: split ? null : SPLIT_MALFORMED },
      ),
      chainRow(
        'splitProvider',
        'Split — provider',
        read,
        (params) =>
          params.slashAgentBps === null || params.slashPlatformBps === null
            ? null
            : percent(10_000 - params.slashAgentBps - params.slashPlatformBps),
        { value: split?.provider ?? null, note: split ? null : SPLIT_MALFORMED },
      ),
    ];
  }

  /**
   * The minimum stake of every settlement deployment (`params().minimumStake`).
   * When the configured fallback (`PROVIDER_MINIMUM_STAKE_FLOOR`) differs,
   * `note` names it so the panel does not hide the gap. With no chain read,
   * the row is the configured floor.
   */
  private minimumStakeRow(
    read: readonly ChainParams[],
    configured: string,
    overrideCount: number,
  ): EconomicParameterRowDto {
    const row = chainRow(
      'minimumStake',
      'Minimum stake',
      read,
      (params) => (params.minimumStake ? toDisplayAmount(params.minimumStake) : null),
      { value: configured, note: null },
    );
    const differs = read.some(
      (params) => params.minimumStake && toDisplayAmount(params.minimumStake) !== configured,
    );
    return {
      ...row,
      overrideCount,
      note: differs
        ? `The configured fallback (PROVIDER_MINIMUM_STAKE_FLOOR) is ${configured}; the chain ` +
          `value is the one enforced.`
        : row.note,
    };
  }

  /**
   * The most one attestation (one record) can slash: `params().penaltyAmount`.
   * The window penalty the platform computes (`totalCallAmount × excessRate ×
   * penaltyMultiplier`, `SLA_PENALTY_MULTIPLIER` 2x) is clipped to it on chain,
   * and to `slashCapBps` of the provider's stake per rolling 24 h.
   */
  private penaltySizeRow(read: readonly ChainParams[]): EconomicParameterRowDto {
    const row = chainRow(
      'penaltySize',
      'Penalty size',
      read,
      (params) =>
        params.penaltyAmount ? `${toDisplayAmount(params.penaltyAmount)} per record` : null,
      {
        value: null,
        note:
          'The per-record ceiling is set on chain (params().penaltyAmount) and the chain has ' +
          'not been read yet.',
      },
    );
    if (row.source !== 'chain') return row;
    const caps = distinctValue(
      read.map((params) => ({
        chainId: params.chainId,
        value: params.slashCapBps === null ? null : `${params.slashCapBps / 100}%`,
      })),
    );
    return {
      ...row,
      note:
        'The most one attestation can slash, set on chain (params().penaltyAmount). An ' +
        'SLA-strike penalty is computed per window — totalCallAmount × excessRate × ' +
        'penaltyMultiplier (2x, `SLA_PENALTY_MULTIPLIER`) — and the chain clips it to this ' +
        `ceiling and to ${caps ?? 'the slash cap'} of the provider's stake per rolling 24 h ` +
        '(params().slashCapBps).',
    };
  }

  /**
   * Providers with a negotiated `minimumStakeOverride`, out of every
   * registered provider — the only one of the six parameters with an actual
   * override mechanism in the schema today.
   */
  private async minimumStakeOverrideCount(): Promise<number> {
    const providers = await this.providers.findAllProviders();
    const providerIds = providers.map((provider) => provider.organizationId);
    if (providerIds.length === 0) return 0;

    const states = await this.providerRegistry.findRoutingStates(providerIds);
    let count = 0;
    for (const state of states.values()) {
      if (state.minimumStakeOverride) count += 1;
    }
    return count;
  }

  // ── Override register ────────────────────────────────────────────────────

  /**
   * `OVERRIDE_REGISTER`, as a list in the register's own order — including
   * the `implemented: false` rows. Pure and synchronous: the register is a
   * frozen in-memory table, not a query.
   */
  listOverrideRegister(): OverrideRegisterRowDto[] {
    return OVERRIDE_CODES.map((code) => {
      const definition = OVERRIDE_REGISTER[code];
      return {
        code: definition.code,
        family: definition.family,
        action: definition.action,
        label: definition.label,
        roles: [...definition.roles] as OperatorRole[],
        approval: definition.approval,
        reversible: definition.reversible,
        implemented: definition.implemented,
      };
    });
  }
}

/**
 * `ACTIVE` beats `SHADOW` beats "whatever else there is" — the same priority
 * `VerificationPolicyRepository.findServing` applies per tool, applied here
 * per policy id across every version on record.
 */
function currentVersionOf(versions: readonly VerificationPolicyEntity[]): VerificationPolicyEntity {
  const active = versions.find((version) => version.lifecycle === PolicyLifecycle.ACTIVE);
  if (active) return active;

  const shadow = [...versions]
    .filter((version) => version.lifecycle === PolicyLifecycle.SHADOW)
    .sort((a, b) => b.policyVersion - a.policyVersion);
  if (shadow.length > 0) return shadow[0];

  return [...versions].sort((a, b) => b.policyVersion - a.policyVersion)[0];
}

function toPolicyRow(row: VerificationPolicyEntity): PolicyLifecycleRowDto {
  const lifecycle = row.lifecycle as PolicyLifecycle;

  return {
    policyId: row.policyId,
    policyVersion: row.policyVersion,
    toolId: row.toolId,
    state: row.lifecycle,
    // See the DTO field's own doc for why `ACTIVE` is always "slashing live"
    // and `SHADOW` is always null rather than "above gate".
    qualifier: lifecycle === PolicyLifecycle.ACTIVE ? 'slashing live' : null,
    falsePositiveRate: storedFalsePositiveRate(row.promotionEvidence),
    votingVerifierIds: extractVerifierIds(row.decisionDocument),
    actionWord:
      lifecycle === PolicyLifecycle.ACTIVE
        ? 'kill'
        : lifecycle === PolicyLifecycle.SHADOW
          ? 'promote'
          : null,
  };
}

/**
 * Reads exactly the number `DecisionPolicyService.promote()` wrote —
 * `decision.falsePositiveRate` — rather than recomputing it, so this panel
 * can never disagree with the value that actually cleared the gate.
 */
function storedFalsePositiveRate(promotionEvidence: Record<string, unknown> | null): number | null {
  const rate = promotionEvidence?.['falsePositiveRate'];
  return typeof rate === 'number' && Number.isFinite(rate) ? rate : null;
}

function extractVerifierIds(decisionDocument: Record<string, unknown> | null): string[] {
  const verifiers = decisionDocument?.['verifiers'];
  if (!Array.isArray(verifiers)) return [];

  const ids: string[] = [];
  for (const entry of verifiers) {
    if (
      entry &&
      typeof entry === 'object' &&
      typeof (entry as Record<string, unknown>).verifierId === 'string'
    ) {
      ids.push((entry as Record<string, unknown>).verifierId as string);
    }
  }
  return ids;
}

function truncateAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

interface PenaltySplit {
  readonly agent: string;
  readonly platform: string;
  readonly provider: string;
}

/**
 * `"60 / 30 / 10"` → three display strings. `null` on anything that does not
 * parse into exactly three numbers — a malformed override must not silently
 * render as a plausible-looking split.
 */
function parsePenaltySplit(raw: string): PenaltySplit | null {
  const parts = raw.split('/').map((part) => part.trim());
  if (parts.length !== 3 || parts.some((part) => part === '' || Number.isNaN(Number(part)))) {
    return null;
  }
  const [agent, platform, provider] = parts;
  return { agent: `${agent}%`, platform: `${platform}%`, provider: `${provider}%` };
}

const SPLIT_MALFORMED =
  'PROVIDER_TERMS_PENALTY_SPLIT did not parse as "agent / platform / provider" percentages.';

/**
 * One economics row: the chains' own value when any chain was read (one
 * value when they agree, `chain value` pairs when they do not), else the
 * configured fallback.
 */
function chainRow(
  key: string,
  label: string,
  read: readonly ChainParams[],
  valueOf: (params: ChainParams) => string | null,
  configured: { value: string | null; note: string | null },
): EconomicParameterRowDto {
  const value =
    read.length > 0
      ? distinctValue(read.map((params) => ({ chainId: params.chainId, value: valueOf(params) })))
      : null;
  if (value === null) {
    return {
      key,
      label,
      value: configured.value,
      source: 'config',
      overrideCount: null,
      note: configured.note,
    };
  }
  return { key, label, value, source: 'chain', overrideCount: null, note: null };
}

/** One value when every chain agrees, `chainId value` pairs otherwise; `null` when none has one. */
function distinctValue(rows: readonly { chainId: string; value: string | null }[]): string | null {
  const known = rows.filter((row): row is { chainId: string; value: string } => row.value !== null);
  if (known.length === 0) return null;
  const distinct = new Set(known.map((row) => row.value));
  return distinct.size === 1
    ? known[0].value
    : known.map((row) => `${row.chainId} ${row.value}`).join(' · ');
}

/**
 * `$50.00`, trimmed to two decimals for display — never rounded up, so a
 * displayed floor is never lower than the one the gate enforces. Mirrors
 * `toDisplayAmount` in `provider-terms.ts`, which is file-private there.
 */
function toDisplayAmount(money: Money): string {
  const [whole, fraction = ''] = MoneyUtil.format(money).split('.');
  return `$${whole}.${fraction.slice(0, 2).padEnd(2, '0')}`;
}
