import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getAddress } from 'viem';

import { ProviderRepository } from '@database/postgres/repositories/provider.repository';
import { VerificationPolicyEntity } from '@database/postgres/entities/verification-policy.entity';
import { VerificationPolicyRepository } from '@database/postgres/repositories/verification-policy.repository';
import { VerifierSigningKeyEntity } from '@database/postgres/entities/verifier-signing-key.entity';
import { VerifierSigningKeyRepository } from '@database/postgres/repositories/verifier-signing-key.repository';
import { ASSAY_CONFIG_ABI } from '@modules/chains/evm/abi/assay.abi';
import { EvmReaderClient } from '@modules/chains/evm/evm-escrow-balance-reader.service';
import { EVM_DEPLOYMENTS, EVM_RPC_CLIENTS, EvmDeployment } from '@modules/chains/evm/evm.constants';
import { getAssetMetadata } from '@modules/chains/ports/asset-registry';
import { ChainId, toAssetId } from '@modules/chains/ports/caip.types';
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
    // The EVM settlement contracts, for `params().minimumStake` — the same
    // value the operator Contracts page reads. Optional so a process (or a
    // test) without EVM chains still lists the panel from config.
    @Optional()
    @Inject(EVM_RPC_CLIENTS)
    private readonly evmClients: ReadonlyMap<ChainId, EvmReaderClient> | null = null,
    @Optional()
    @Inject(EVM_DEPLOYMENTS)
    private readonly evmDeployments: ReadonlyMap<ChainId, EvmDeployment> | null = null,
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
        unreadableReason: `chain unreadable: ${reason}`,
        expiresAt: null,
      };
    }
  }

  // ── Economic parameters ──────────────────────────────────────────────────

  /**
   * The six economic parameters, read from the same configuration
   * `loadProviderTerms`/`loadMinimumStakeParameters` already read — never a
   * second, independently-typed copy of the same numbers. The minimum stake
   * is the exception: it is read from the settlement contract's own
   * `params()`, the value the Contracts page shows and the stake contract
   * enforces (see {@link minimumStakeRow}).
   */
  async listEconomicParameters(): Promise<EconomicParameterRowDto[]> {
    // `PLATFORM_FEE_BPS`, the rate a call is charged at (R17-R-03).
    const takeRatePercent = platformTakeRatePercent(this.config);
    const penaltySplitRaw =
      this.config.get<string>('PROVIDER_TERMS_PENALTY_SPLIT') ?? '60 / 30 / 10';
    const stakeParameters = loadMinimumStakeParameters(this.config);
    const minimumStakeOverrideCount = await this.minimumStakeOverrideCount();
    const split = parsePenaltySplit(penaltySplitRaw);

    return [
      {
        key: 'takeRate',
        label: 'Take rate',
        value: `${takeRatePercent}%`,
        source: 'config',
        overrideCount: null,
        note: null,
      },
      await this.minimumStakeRow(toDisplayAmount(stakeParameters.floor), minimumStakeOverrideCount),
      {
        key: 'penaltySize',
        label: 'Penalty size',
        value: null,
        source: 'config',
        overrideCount: null,
        note:
          'No fixed penalty-size parameter exists in this codebase. An SLA-strike penalty is ' +
          'computed dynamically per window — totalCallAmount × excessRate × penaltyMultiplier ' +
          '(2x, `SLA_PENALTY_MULTIPLIER`) — with no per-call or per-strike ceiling. ' +
          '`SlashConfig.secondSignatureThresholdMinor` and `deMinimisMinor` are a materiality ' +
          'threshold and a floor, neither of which is "the penalty size".',
      },
      splitRow('splitAgent', 'Split — agent', split?.agent ?? null, split === null),
      splitRow('splitPlatform', 'Split — platform', split?.platform ?? null, split === null),
      splitRow('splitProvider', 'Split — provider', split?.provider ?? null, split === null),
    ];
  }

  /**
   * `params().minimumStake` of every EVM settlement deployment, read live.
   * One value when the chains agree, one `chain value` pair per chain when
   * they do not. When the configured routing floor
   * (`PROVIDER_MINIMUM_STAKE_FLOOR`) differs, `note` names it so the panel
   * does not hide the gap. With no EVM deployment, or when the chain cannot
   * be read, the row falls back to the configured floor and says why.
   */
  private async minimumStakeRow(
    configured: string,
    overrideCount: number,
  ): Promise<EconomicParameterRowDto> {
    const configRow = (note: string | null): EconomicParameterRowDto => ({
      key: 'minimumStake',
      label: 'Minimum stake',
      value: configured,
      source: 'config',
      overrideCount,
      note,
    });

    const deployments = [...(this.evmDeployments?.values() ?? [])].filter((deployment) =>
      this.evmClients?.has(deployment.chainId),
    );
    if (deployments.length === 0) return configRow(null);

    let perChain: { chainId: ChainId; value: string }[];
    try {
      perChain = await Promise.all(
        deployments.map(async (deployment) => ({
          chainId: deployment.chainId,
          value: await this.readChainMinimumStake(deployment),
        })),
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Minimum stake read from the settlement contract failed: ${reason}`);
      return configRow(`chain unreadable: ${reason}. Showing the configured floor.`);
    }

    const distinct = new Set(perChain.map((entry) => entry.value));
    const value =
      distinct.size === 1
        ? perChain[0].value
        : perChain.map((entry) => `${entry.chainId} ${entry.value}`).join(' · ');
    const differs = perChain.some((entry) => entry.value !== configured);
    return {
      key: 'minimumStake',
      label: 'Minimum stake',
      value,
      source: 'chain',
      overrideCount,
      note: differs
        ? `The configured routing floor (PROVIDER_MINIMUM_STAKE_FLOOR) is ${configured}.`
        : null,
    };
  }

  private async readChainMinimumStake(deployment: EvmDeployment): Promise<string> {
    const client = this.evmClients!.get(deployment.chainId)!;
    const params = (await client.readContract({
      address: getAddress(deployment.config),
      abi: ASSAY_CONFIG_ABI,
      functionName: 'params',
      args: [],
    })) as { minimumStake: bigint };
    const asset = toAssetId(deployment.chainId, 'erc20', getAddress(deployment.asset));
    return toDisplayAmount(
      MoneyUtil.of(BigInt(params.minimumStake).toString(), asset, getAssetMetadata(asset).decimals),
    );
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

function splitRow(
  key: string,
  label: string,
  value: string | null,
  malformed: boolean,
): EconomicParameterRowDto {
  return {
    key,
    label,
    value,
    source: 'config',
    overrideCount: null,
    note: malformed
      ? `PROVIDER_TERMS_PENALTY_SPLIT did not parse as "agent / platform / provider" percentages.`
      : null,
  };
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
