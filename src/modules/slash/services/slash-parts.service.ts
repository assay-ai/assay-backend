import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { SlashProposalEntity } from '@database/postgres/entities/slash-proposal.entity';
import { SlashProposalPartEntity } from '@database/postgres/entities/slash-proposal-part.entity';
import { SlaWindowCallRepository } from '@database/postgres/repositories/sla-window-call.repository';
import { SlashProposalPartRepository } from '@database/postgres/repositories/slash-proposal-part.repository';
import { ChainErrors } from '@modules/chains/errors/chains.errors';
import { ALERT_PORT, AlertAggregation, AlertPort, AlertSeverity } from '@shared/alerting';
import {
  AssetId,
  ChainId,
  ChainNamespace,
  chainIdOf,
  namespaceOf,
  parseAccountId,
} from '@modules/chains/ports/caip.types';

import {
  DISPUTE_TIMEOUT_MS,
  ProRataSlashConfig,
  SLASH_PRORATA_CONFIG,
} from '../constants/slash.constants';
import {
  ChainFailureKind,
  chainErrorName,
  classifyChainFailure,
} from '../domain/chain-slash-outcome';
import {
  aggregateSlashParts,
  slashRecordMismatch,
  findDustParts,
  HarmedAgentWeight,
  minimumSplittablePenalty,
  normalizeAgentAccount,
  planProRataSlash,
  ProRataCapBinding,
  SlashPartChainStatus,
  SlashPartView,
  slashPartRequestId,
} from '../domain/prorata-slash';
import {
  BeneficiaryEvidence,
  beneficiaryEvidence,
  FailedCallPayment,
} from '../domain/slash-beneficiary-evidence';
import { planEvidenceMismatch } from '../domain/slash-plan-evidence';
import { SlashErrors } from '../errors/slash.errors';
import { SLASH_CAPS_READER, SlashCapsReaderPort } from '../ports/slash-caps-reader.port';
import {
  SLASH_EXECUTOR,
  SlashBatchOutcome,
  SlashCancelIntent,
  SlashCancelResult,
  SlashExecutionResult,
  SlashExecutorPort,
  SlashProposalResult,
  SlashRecordSnapshot,
  SlashRecordStatus,
} from '../ports/slash-executor.port';

/**
 * `SLASH_EXECUTION_GRACE_SECONDS` (7 days) — after `executableAt + grace` a
 * record can only be expired. Mirrored, as `SlashExecutionService` does.
 */
const SLASH_EXECUTION_GRACE_MS_FOR_PARTS = 7 * 24 * 60 * 60 * 1000;

/** Alert name: a withdrawn judgement executed on chain while its cancel waited. */
export const EXECUTED_WHILE_CANCEL_WAITED_ALERT = 'slash_executed_while_cancel_waited';

/** One case handed to {@link SlashPartsService.executeMany}. */
export interface PartitionedCase {
  readonly proposal: SlashProposalEntity;
  /** The provider's stake authority, bare address. */
  readonly provider: string;
}

/**
 * A window-level case on EVM, as the set of per-agent judgements it is on
 * chain.
 *
 * `SlashExecutionService` still runs the one state machine — dispute window,
 * arbitration, the 72-hour timelock, cancel-and-bump, reconcile, expire —
 * over ONE case. For a case {@link appliesTo} answers `true` for, each of its
 * chain calls is routed here instead of to the executor directly, and this
 * class answers in the executor's own result shapes, folded over the parts by
 * `aggregateSlashParts`. The state machine therefore cannot tell a
 * partitioned judgement from a single one, which is the point: none of its
 * guarantees had to be re-argued.
 *
 * ## What it adds, and nothing else
 *
 * - **The plan**, computed once per case epoch from the window's DATA_FAIL
 *   calls and the live on-chain caps, persisted before anything is signed
 *   (`slash_proposal_parts`), and re-read rather than recomputed on every
 *   retry — so a retry cannot change a penalty an earlier attempt already put
 *   on chain.
 * - **Batching**: the parts of a case are proposed in one
 *   `SlashExecutorPort.proposeBatch`, and every due case's parts are executed
 *   in one `executeBatch` ({@link executeMany}) — on EVM, `Multicall3`.
 * - **Partial outcomes, never silent**: a part refused while its siblings
 *   landed is marked `REFUSED` and the case proceeds with the rest; a part
 *   that executed while a sibling failed keeps the case out of any state that
 *   would call the penalty dropped.
 *
 * ## Money
 *
 * The agent share is paid on chain to each agent's own account by
 * `executeSlash`. Nothing is booked to the ledger for it — the vault is not
 * involved — so `SlashExecutionService.compensate` skips these cases.
 */
@Injectable()
export class SlashPartsService {
  private readonly logger = new Logger(SlashPartsService.name);

  constructor(
    private readonly parts: SlashProposalPartRepository,
    private readonly windowCalls: SlaWindowCallRepository,
    @Inject(SLASH_EXECUTOR) private readonly executor: SlashExecutorPort,
    @Inject(SLASH_PRORATA_CONFIG) private readonly config: ProRataSlashConfig,
    @Optional() @Inject(SLASH_CAPS_READER) private readonly caps: SlashCapsReaderPort | null = null,
    @Optional() @Inject(ALERT_PORT) private readonly alerts: AlertPort | null = null,
  ) {}

  /**
   * Pro-rata on chain: an EVM case raised for a window. A Solana window keeps
   * the vault-and-ledger split it has always had; a call-level case (no
   * window) is not partitioned.
   */
  appliesTo(proposal: Pick<SlashProposalEntity, 'assetId' | 'windowId'>): boolean {
    return (
      proposal.windowId !== null &&
      namespaceOf(proposal.assetId as AssetId) === ChainNamespace.EIP155
    );
  }

  // ── propose ─────────────────────────────────────────────────────────────

  async propose(
    proposal: SlashProposalEntity,
    provider: string,
    now: Date = new Date(),
  ): Promise<SlashProposalResult> {
    const chainId = chainIdOf(proposal.assetId as AssetId);
    const parts = await this.plan(proposal, chainId, provider);

    const todo = parts.filter((part) => part.chainStatus === 'NONE');
    let transient: unknown = null;
    let refusal: unknown = null;
    let signature = '';
    const stragglers: { part: SlashProposalPartEntity; attempts: number; reason: string }[] = [];

    if (todo.length > 0) {
      // Review H-2: never sign a stored plan the evidence does not produce.
      await this.assertPlanFollowsEvidence(proposal, chainId, parts);
      // Follow-up C5: every beneficiary is a payer of the failed calls, and no
      // part exceeds that payer's share of the formula penalty.
      await this.assertBeneficiariesPaid(proposal, provider, chainId, todo);
      const outcomes = await this.executor.proposeBatch(
        todo.map((part) => ({
          chainId,
          requestId: part.chainRequestId,
          provider,
          beneficiary: parseAccountId(part.beneficiaryAccount).address,
          penaltyMinor: part.penaltyAmount,
          policy: proposal.toolId,
          responseClass: 'dataFail' as const,
        })),
      );

      for (const [index, outcome] of outcomes.entries()) {
        const part = todo[index];
        if (outcome.ok) {
          signature ||= outcome.result.signature;
          await this.mirrorProposal(part, proposal, outcome.result, provider, chainId);
          continue;
        }
        const name = chainErrorName(outcome.error);
        // Before any refusal is believed, ask the chain. A record at this
        // request id — from a slow earlier send, or a stranger relaying our
        // own attestation — IS the judgement, whatever this attempt was told.
        const found = await this.adoptFromChain(part, proposal, provider, chainId);
        if (found === 'adopted') continue;
        if (found === 'mismatch') {
          // Our request id is taken by a different judgement: nothing we sign
          // can land there. Already REFUSED with the reason by `readMatching`.
          refusal ??= outcome.error;
          continue;
        }

        if (classifyChainFailure(outcome.error) === ChainFailureKind.VOID) {
          // Refused for good. Its siblings go on; the agent's share is not
          // levied, and the row says why. `readRecord` keeps re-reading it.
          refusal = outcome.error;
          await this.parts.updatePart(part.organizationId, part.id, {
            chainStatus: 'REFUSED',
            chainLastError: name ?? 'unknown',
          });
          this.logger.error(
            `slash part ${part.chainRequestId} (case ${proposal.id}, ${part.agentAccount}) ` +
              `was refused permanently on chain (${name ?? 'unnamed'}); its share is not levied`,
          );
        } else {
          const attempts = part.proposeAttempts + 1;
          await this.parts.updatePart(part.organizationId, part.id, {
            chainLastError: name ?? 'transport',
            proposeAttempts: attempts,
          });
          stragglers.push({ part, attempts, reason: name ?? 'transport' });
          transient ??= outcome.error;
        }
      }
    }

    // A part still unproposed keeps the case in PROPOSING — the sweep retries
    // it, and the parts already on chain are adopted, not re-sent — but not
    // for ever: a straggler beside siblings that stand on chain is given up on
    // once it has had its attempts, or once those siblings' door is near.
    if (transient) {
      const landed = (
        await this.parts.findForEpoch(proposal.organizationId, proposal.id, proposal.chainEpoch)
      ).filter((part) => part.chainStatus === 'PENDING' && part.chainExecutableAt);
      const earliestDoor = landed.length
        ? Math.min(...landed.map((part) => (part.chainExecutableAt as Date).getTime()))
        : null;
      const nearTheDoor =
        earliestDoor !== null && now.getTime() >= earliestDoor - this.config.stragglerDeadlineMs;
      const outOfAttempts = stragglers.every(
        (straggler) => straggler.attempts >= this.config.stragglerMaxAttempts,
      );
      if (landed.length === 0 || (!nearTheDoor && !outOfAttempts)) throw transient;

      for (const { part, attempts, reason } of stragglers) {
        await this.parts.updatePart(part.organizationId, part.id, {
          chainStatus: 'REFUSED',
          chainLastError: `Straggler:${reason}`.slice(0, 64),
        });
        this.logger.error(
          `slash part ${part.chainRequestId} (case ${proposal.id}, ${part.agentAccount}) could not ` +
            `be proposed after ${attempts} attempt(s) (${reason}); given up so the case can ` +
            `proceed with its ${landed.length} other part(s). readRecord keeps re-reading it.`,
        );
      }
    }

    const reloaded = await this.parts.findForEpoch(
      proposal.organizationId,
      proposal.id,
      proposal.chainEpoch,
    );
    const view = aggregateSlashParts(reloaded.map(toView));
    if (!view) {
      throw refusal ?? SlashErrors.noHarmedAgents({ windowId: proposal.windowId });
    }

    return {
      signature,
      status: view.status,
      proposedAt: view.proposedAt,
      executableAt: view.executableAt,
      reservedMinor: view.reservedMinor,
      adopted: todo.length === 0 || signature === '',
    };
  }

  /** Mirror a record already at the part's request id. `true` when there was one. */
  private async adoptFromChain(
    part: SlashProposalPartEntity,
    proposal: SlashProposalEntity,
    provider: string,
    chainId: ChainId,
  ): Promise<'adopted' | 'mismatch' | 'absent'> {
    let mismatched = false;
    const record = await this.readMatching(part, proposal, provider, chainId, () => {
      mismatched = true;
    }).catch(() => null);
    if (mismatched) return 'mismatch';
    if (!record) return 'absent';
    await this.mirrorRecord(part, record);
    return 'adopted';
  }

  /**
   * The record at a part's request id — but only if it IS this part's
   * judgement, by the one rule `slashRecordMismatch` states (beneficiary,
   * penalty and policy must match; a different verifier only while it may
   * still sign). A record with other terms is somebody else's: the part is
   * marked REFUSED (`RecordMismatch:<field>`), loudly, and `null` returned so
   * nothing is mirrored, executed or expired on the strength of it.
   */
  private async readMatching(
    part: SlashProposalPartEntity,
    proposal: SlashProposalEntity,
    provider: string,
    chainId: ChainId,
    onMismatch?: () => void,
  ): Promise<SlashRecordSnapshot | null> {
    const record = await this.executor.readRecord(part.chainRequestId, provider, chainId);
    if (!record) return null;
    const mismatch = slashRecordMismatch(record, {
      beneficiary: parseAccountId(part.beneficiaryAccount).address,
      penaltyMinor: part.penaltyAmount,
      policy: proposal.toolId,
    });
    if (!mismatch) return record;
    onMismatch?.();
    await this.parts.updatePart(part.organizationId, part.id, {
      chainStatus: 'REFUSED',
      chainLastError: `RecordMismatch:${mismatch}`,
    });
    this.logger.error(
      `slash part ${part.chainRequestId} (case ${proposal.id}): the record at this request id ` +
        `carries a different ${mismatch}; it is not this judgement and is left alone`,
    );
    return null;
  }

  /**
   * The case's parts at its current epoch — planned and persisted now if this
   * is the first time anybody asked.
   */
  private async plan(
    proposal: SlashProposalEntity,
    chainId: ChainId,
    provider: string,
  ): Promise<SlashProposalPartEntity[]> {
    const existing = await this.parts.findForEpoch(
      proposal.organizationId,
      proposal.id,
      proposal.chainEpoch,
    );
    if (existing.length > 0) return existing;

    if (!proposal.windowId) {
      throw SlashErrors.beneficiaryUnsupported({ chainId, reason: 'the case has no window' });
    }
    if (!this.caps) {
      throw ChainErrors.programNotConfigured({ what: 'a slash caps reader for ' + chainId });
    }

    const agents = await this.harmedAgents(proposal, chainId);
    const caps = await this.caps.readCaps({ chainId, provider });
    const totalCeiling = [
      caps.windowAllowanceMinor,
      caps.freeStakeMinor,
      caps.verifierDailyCapMinor,
    ].reduce((min, value) => (value < min ? value : min));

    const plan = planProRataSlash({
      windowPenalty: BigInt(proposal.penaltyAmount),
      agents,
      caps: {
        perPartCeiling: caps.penaltyCeilingMinor,
        totalCeiling,
        // Always the contract's floor: a smaller part could never execute.
        minimumPart: minimumSplittablePenalty(caps.agentBps, caps.platformBps),
      },
    });

    if (plan.parts.length === 0) {
      throw SlashErrors.noHarmedAgents({
        windowId: proposal.windowId,
        reason:
          agents.length === 0
            ? 'no agent had a priced DATA_FAIL call in the window'
            : `every share was capped to nothing (${plan.binding})`,
      });
    }

    if (plan.binding !== ProRataCapBinding.NONE) {
      this.logger.warn(
        `slash case ${proposal.id}: the pro-rata plan was reduced by ${plan.binding} — ` +
          `${plan.cappedTotal} of ${plan.windowPenalty} is signed for across ` +
          `${plan.parts.length} agent(s); ${plan.unpaid.length} left unpaid`,
      );
    }
    const dust = findDustParts(plan.parts, caps.agentBps, this.config.dustReportBelowMinor);
    if (dust.length > 0) {
      // Reported, never dropped: see `ProRataSlashConfig.dustReportBelowMinor`.
      this.logger.warn(
        `slash case ${proposal.id}: ${dust.length} part(s) pay the agent less than ` +
          `${this.config.dustReportBelowMinor} minor units: ` +
          dust.map((part) => `${part.agentAccount}=${part.penalty}`).join(', '),
      );
    }

    return this.parts.insertPlan(
      proposal.organizationId,
      proposal.id,
      proposal.chainEpoch,
      plan.parts.map((part) => ({
        windowId: proposal.windowId as string,
        agentAccount: part.agentAccount,
        // On EVM the 60% is paid to the buyer's own account: the CAIP-10 the
        // agent paid from, which is the account that was harmed.
        beneficiaryAccount: part.agentAccount,
        weightAmount: part.weight.toString(),
        uncappedShareAmount: part.uncappedShare.toString(),
        penaltyAmount: part.penalty.toString(),
        planPenaltyAmount: plan.windowPenalty.toString(),
        planCappedTotal: plan.cappedTotal.toString(),
        capBinding: plan.binding,
        chainRequestId: slashPartRequestId(
          proposal.windowId as string,
          proposal.chainRequestId,
          part.agentAccount,
        ),
        chainStatus: 'NONE',
      })),
    );
  }

  /**
   * Refuse (log, throw, sign nothing) when the case's stored parts are not the
   * plan its evidence produces — see `planEvidenceMismatch`. Every part of the
   * epoch is checked, not only the unsent ones, so a part that landed earlier
   * still counts toward the sum and an edited row cannot be skipped past.
   */
  private async assertPlanFollowsEvidence(
    proposal: SlashProposalEntity,
    chainId: ChainId,
    parts: readonly SlashProposalPartEntity[],
  ): Promise<void> {
    const weights = await this.harmedAgents(proposal, chainId, proposal.providerId);
    const reason = planEvidenceMismatch({
      casePenalty: BigInt(proposal.penaltyAmount),
      evidence: new Map(weights.map((row) => [row.agentAccount, row.weight])),
      parts,
    });
    if (!reason) return;
    this.logger.error(
      `slash case ${proposal.id}: refusing to sign; the stored plan does not match the ` +
        `evidence: ${reason}`,
    );
    throw SlashErrors.planEvidenceMismatch({ proposalId: proposal.id, reason });
  }

  /**
   * The C5 evidence of `parts`: per part, the payer of the failed calls, what
   * it paid, what the penalty formula gives it, and the share it would receive. `agentBps` is the contract's
   * `slashAgentBps` (read live when not given).
   */
  async beneficiaryEvidenceOf(
    proposal: Pick<SlashProposalEntity, 'windowId' | 'assetId' | 'providerId' | 'penaltyAmount'>,
    parts: readonly SlashProposalPartEntity[],
    agentBps: number,
  ): Promise<BeneficiaryEvidence[]> {
    if (!proposal.windowId) return [];
    const rows = await this.windowCalls.failedCallPaymentsByAgent(
      proposal.windowId,
      proposal.assetId,
      proposal.providerId,
    );
    const payments = new Map<string, FailedCallPayment>();
    const chainId = chainIdOf(proposal.assetId as AssetId);
    for (const row of rows) {
      const account = normalizeAgentAccount(row.agentAccount);
      // As the plan does: a payer on another chain is not in the on-chain split.
      if (!account.startsWith(`${chainId}:`)) continue;
      const prior = payments.get(account);
      payments.set(account, {
        agentAccount: account,
        failedCalls: (prior?.failedCalls ?? 0) + Number(row.failedCalls),
        paidMinor: (prior?.paidMinor ?? 0n) + BigInt(row.paid ?? '0'),
        redeemedMinor: (prior?.redeemedMinor ?? 0n) + BigInt(row.redeemed ?? '0'),
      });
    }
    return beneficiaryEvidence(parts, payments, BigInt(proposal.penaltyAmount), agentBps);
  }

  /** Refuse (sign nothing) when a part fails the C5 check — see `beneficiaryEvidence`. */
  private async assertBeneficiariesPaid(
    proposal: SlashProposalEntity,
    provider: string,
    chainId: ChainId,
    parts: readonly SlashProposalPartEntity[],
  ): Promise<void> {
    if (!this.caps) {
      throw ChainErrors.programNotConfigured({ what: 'a slash caps reader for ' + chainId });
    }
    const { agentBps } = await this.caps.readCaps({ chainId, provider });
    const failed = (await this.beneficiaryEvidenceOf(proposal, parts, agentBps)).filter(
      (row) => !row.ok,
    );
    if (failed.length === 0) return;
    const reason = failed.map((row) => `part 0x${row.requestId}: ${row.reason}`).join('; ');
    this.logger.error(`slash case ${proposal.id}: refusing to sign (C5): ${reason}`);
    throw SlashErrors.beneficiaryEvidenceRefused({ proposalId: proposal.id, reason });
  }

  /** The window's DATA_FAIL weight per agent, merged on the normalised account, on this chain only. */
  private async harmedAgents(
    proposal: SlashProposalEntity,
    chainId: ChainId,
    providerId?: string,
  ): Promise<HarmedAgentWeight[]> {
    const rows = await this.windowCalls.sumFailedPriceByAgent(
      proposal.windowId as string,
      proposal.assetId,
      providerId,
    );
    const merged = new Map<string, bigint>();
    for (const row of rows) {
      const account = normalizeAgentAccount(row.agentAccount);
      if (!account.startsWith(`${chainId}:`)) {
        // Paid from another chain: the contract on this chain cannot pay it.
        this.logger.warn(
          `slash case ${proposal.id}: agent ${row.agentAccount} paid on another chain than ` +
            `${chainId} and is left out of the on-chain split`,
        );
        continue;
      }
      merged.set(account, (merged.get(account) ?? 0n) + BigInt(row.spend ?? '0'));
    }
    return [...merged].map(([agentAccount, weight]) => ({ agentAccount, weight }));
  }

  private async mirrorProposal(
    part: SlashProposalPartEntity,
    proposal: SlashProposalEntity,
    result: SlashProposalResult,
    provider: string,
    chainId: ChainId,
  ): Promise<void> {
    if (result.status === 'PENDING') {
      await this.parts.updatePart(part.organizationId, part.id, {
        chainStatus: 'PENDING',
        chainProposedAt: result.proposedAt,
        chainExecutableAt: result.executableAt,
        chainReserved: result.reservedMinor,
        chainProposalSignature: result.signature || null,
        chainLastError: null,
      });
      return;
    }
    // Adopted a record that already left Pending: read it whole.
    const record = await this.readMatching(part, proposal, provider, chainId);
    if (record) await this.mirrorRecord(part, record);
  }

  // ── execute ─────────────────────────────────────────────────────────────

  /**
   * Execute every pending part of every case handed in, in ONE batch, and say
   * per case what `SlashExecutorPort.executeProposal` would have.
   *
   * Never throws for one case's sake; a case's failure is its outcome. The
   * per-case rules, in order:
   *
   * - a part still live and pending after the batch (a WAIT or a transport
   *   failure) fails the case — with the part's own error when nothing of the
   *   case has executed, so the state machine's existing classification
   *   applies; with an UNNAMED error when something has, so the case stays
   *   `EXECUTING` for the reconciler and is never voided over money that moved;
   * - parts the chain refused for good (a revoked key) void the case when none
   *   of its parts executed, and are expired when some did;
   * - every part cancelled → the `SlashNotPending` read-the-record path.
   */
  async executeMany(
    cases: readonly PartitionedCase[],
  ): Promise<Map<string, SlashBatchOutcome<SlashExecutionResult>>> {
    const results = new Map<string, SlashBatchOutcome<SlashExecutionResult>>();
    const work: { case: PartitionedCase; chainId: ChainId; parts: SlashProposalPartEntity[] }[] =
      [];

    for (const entry of cases) {
      const { proposal } = entry;
      const parts = await this.parts.findForEpoch(
        proposal.organizationId,
        proposal.id,
        proposal.chainEpoch,
      );
      work.push({ case: entry, chainId: chainIdOf(proposal.assetId as AssetId), parts });
    }

    const requests = work.flatMap((item) =>
      item.parts.filter((part) => part.chainStatus === 'PENDING').map((part) => ({ item, part })),
    );

    const errors = new Map<string, { transient: unknown[]; dead: unknown[] }>();
    const record = (caseId: string) => {
      if (!errors.has(caseId)) errors.set(caseId, { transient: [], dead: [] });
      return errors.get(caseId) as { transient: unknown[]; dead: unknown[] };
    };
    const deadParts = new Set<string>();

    if (requests.length > 0) {
      const outcomes = await this.executor.executeBatch(
        requests.map(({ item, part }) => ({
          chainId: item.chainId,
          requestId: part.chainRequestId,
          provider: item.case.provider,
          beneficiary: parseAccountId(part.beneficiaryAccount).address,
          // One case executes whole or is deferred whole — never cut by order.
          atomicGroup: item.case.proposal.id,
        })),
      );

      for (const [index, outcome] of outcomes.entries()) {
        const { item, part } = requests[index];
        const caseId = item.case.proposal.id;
        if (outcome.ok) {
          await this.parts.updatePart(part.organizationId, part.id, {
            chainStatus: 'EXECUTED',
            appliedAmount: outcome.result.appliedMinor,
            agentAmount: outcome.result.agentAmountMinor,
            platformAmount: outcome.result.platformAmountMinor,
            executedAt: outcome.result.executedAt,
            executionSignature: outcome.result.signature,
            chainLastError: null,
          });
          continue;
        }

        const name = chainErrorName(outcome.error);
        const notFound =
          (outcome.error as { errorCode?: string })?.errorCode === 'CHAIN_SLASH_RECORD_NOT_FOUND';
        if (name === 'SlashNotPending' || notFound) {
          // Somebody else moved it. Only the record can say which way.
          const snapshot = await this.readMatching(
            part,
            item.case.proposal,
            item.case.provider,
            item.chainId,
          ).catch(() => null);
          if (snapshot && snapshot.status !== 'PENDING') {
            await this.mirrorRecord(part, snapshot);
            continue;
          }
          record(caseId).transient.push(outcome.error);
          continue;
        }

        await this.parts
          .updatePart(part.organizationId, part.id, { chainLastError: name ?? 'transport' })
          .catch(() => undefined);
        if (classifyChainFailure(outcome.error) === ChainFailureKind.VOID) {
          deadParts.add(part.id);
          record(caseId).dead.push(outcome.error);
        } else {
          record(caseId).transient.push(outcome.error);
        }
      }
    }

    for (const item of work) {
      const { proposal } = item.case;
      try {
        results.set(
          proposal.id,
          await this.settleCase(item.case, item.chainId, deadParts, errors.get(proposal.id)),
        );
      } catch (error) {
        results.set(proposal.id, { ok: false, error });
      }
    }
    return results;
  }

  private async settleCase(
    entry: PartitionedCase,
    chainId: ChainId,
    deadParts: ReadonlySet<string>,
    errors: { transient: unknown[]; dead: unknown[] } | undefined,
  ): Promise<SlashBatchOutcome<SlashExecutionResult>> {
    const { proposal, provider } = entry;
    const parts = await this.parts.findForEpoch(
      proposal.organizationId,
      proposal.id,
      proposal.chainEpoch,
    );
    const executed = parts.filter((part) => part.chainStatus === 'EXECUTED');
    const pending = parts.filter((part) => part.chainStatus === 'PENDING');
    const livePending = pending.filter((part) => !deadParts.has(part.id));
    // A DISPUTED part (D-19) is frozen on its own (audit E-4): it is a standing
    // reservation the arbiter may still uphold, but it does not hold the
    // case's other parts. Once they have executed, the case closes on what
    // moved and the disputed part is left to `sweepStrandedParts`, which pays
    // it after an uphold or expires it after the 30-day timeout.
    const disputed = parts.filter((part) => part.chainStatus === 'DISPUTED');

    if (livePending.length > 0) {
      if (executed.length > 0) {
        return {
          ok: false,
          error: partialExecution(proposal.id, executed.length, livePending.length),
        };
      }
      return {
        ok: false,
        error:
          errors?.transient[0] ??
          ChainErrors.transactionFailed({
            instruction: 'executeSlash',
            reason: `case ${proposal.id} has parts still pending after the batch`,
            customErrorCode: null,
          }),
      };
    }

    if (pending.length > 0) {
      // Only parts the chain will never pay are left.
      if (executed.length === 0) return { ok: false, error: errors?.dead[0] };
      for (const part of pending) {
        try {
          const expired = await this.executor.expire({
            chainId,
            requestId: part.chainRequestId,
            provider,
          });
          await this.parts.updatePart(part.organizationId, part.id, {
            chainStatus: 'CANCELLED',
            cancelledAt: expired.cancelledAt,
            cancelReason: expired.reason ?? null,
          });
        } catch (error) {
          this.logger.error(
            `slash part ${part.chainRequestId} can never execute and could not be expired yet; ` +
              `its reservation stands until expireSlash succeeds`,
            error instanceof Error ? error.stack : String(error),
          );
        }
      }
    }

    if (executed.length === 0 && disputed.length > 0) {
      // Nothing executed and only disputed parts stand: the case waits for the
      // arbiter. Transient, so the reconciler reads the aggregate (DISPUTED).
      return {
        ok: false,
        error: ChainErrors.transactionFailed({
          instruction: 'executeSlash',
          reason: `case ${proposal.id}: every live part is disputed on chain`,
          customErrorCode: null,
        }),
      };
    }
    if (disputed.length > 0) {
      this.logger.log(
        `slash case ${proposal.id}: ${executed.length} part(s) executed; ${disputed.length} ` +
          `disputed part(s) wait for the arbiter on their own`,
      );
    }

    if (executed.length === 0) {
      // Every part was cancelled or expired. Same door as a single record
      // answering `SlashNotPending`: the case stays EXECUTING and the
      // reconciler reads the aggregate, which says CANCELLED.
      return {
        ok: false,
        error: ChainErrors.transactionFailed({
          instruction: 'executeSlash',
          reason: 'SlashNotPending',
          customErrorCode: null,
          programErrorName: 'SlashNotPending',
        }),
      };
    }

    const view = aggregateSlashParts(executed.map(toView)) as SlashRecordSnapshot;
    const latest = [...executed].sort(
      (left, right) => (right.executedAt?.getTime() ?? 0) - (left.executedAt?.getTime() ?? 0),
    )[0];
    return {
      ok: true,
      result: {
        signature: latest.executionSignature ?? '',
        appliedMinor: view.appliedMinor,
        agentAmountMinor: view.agentAmountMinor,
        platformAmountMinor: view.platformAmountMinor,
        executedAt: view.executedAt ?? new Date(),
      },
    };
  }

  // ── read, expire, cancel ────────────────────────────────────────────────

  /**
   * The case's judgement as the chain says it is now: every part not already
   * terminal is re-read and its row brought up to date, then folded.
   */
  async readRecord(
    proposal: SlashProposalEntity,
    provider: string,
  ): Promise<SlashRecordSnapshot | null> {
    const chainId = chainIdOf(proposal.assetId as AssetId);
    const parts = await this.parts.findForEpoch(
      proposal.organizationId,
      proposal.id,
      proposal.chainEpoch,
    );
    for (const part of parts) {
      // REFUSED is re-read on purpose: a refusal was this process's reading
      // of one attempt, and a slow transaction can still land behind it. Only
      // the two terminal on-chain states are skipped.
      if (['EXECUTED', 'CANCELLED'].includes(part.chainStatus)) continue;
      const snapshot = await this.readMatching(part, proposal, provider, chainId);
      if (snapshot) await this.mirrorRecord(part, snapshot);
    }
    const reloaded = await this.parts.findForEpoch(
      proposal.organizationId,
      proposal.id,
      proposal.chainEpoch,
    );
    return aggregateSlashParts(reloaded.map(toView));
  }

  /**
   * Review R2-4: what the case's current-epoch parts say was taken, summed
   * from the stored parts alone (no chain read): the applied, agent and
   * platform amounts of every `EXECUTED` part, and the latest execution's
   * signature. `executed` is how many parts executed; `agentAmountAfterMinor`
   * is the agent share of the parts executed after `since` (the late ones).
   */
  async executedTotals(
    proposal: SlashProposalEntity,
    since: Date | null = null,
  ): Promise<{
    appliedMinor: string;
    agentAmountMinor: string;
    agentAmountAfterMinor: string;
    platformAmountMinor: string;
    signature: string | null;
    executed: number;
  }> {
    const parts = await this.parts.findForEpoch(
      proposal.organizationId,
      proposal.id,
      proposal.chainEpoch,
    );
    const executed = parts.filter((part) => part.chainStatus === 'EXECUTED');
    const sum = (pick: (part: SlashProposalPartEntity) => string | null) =>
      executed.reduce((total, part) => total + BigInt(pick(part) ?? '0'), 0n).toString();
    const latest = [...executed].sort(
      (left, right) => (right.executedAt?.getTime() ?? 0) - (left.executedAt?.getTime() ?? 0),
    )[0];
    return {
      appliedMinor: sum((part) => part.appliedAmount),
      agentAmountMinor: sum((part) => part.agentAmount),
      agentAmountAfterMinor: executed
        .filter((part) => !since || (part.executedAt?.getTime() ?? 0) > since.getTime())
        .reduce((total, part) => total + BigInt(part.agentAmount ?? '0'), 0n)
        .toString(),
      platformAmountMinor: sum((part) => part.platformAmount),
      signature: latest?.executionSignature ?? null,
      executed: executed.length,
    };
  }

  /**
   * `expireSlash` on every part still pending. Throws — so the caller does
   * NOT mirror the case `CANCELLED` — if any part of the case executed: that
   * is money that moved, and the next sweep's read records it as such.
   */
  async expire(proposal: SlashProposalEntity, provider: string): Promise<SlashCancelResult> {
    const chainId = chainIdOf(proposal.assetId as AssetId);
    await this.readRecord(proposal, provider);
    const parts = await this.parts.findForEpoch(
      proposal.organizationId,
      proposal.id,
      proposal.chainEpoch,
    );

    let signature = '';
    let cancelledAt: Date | null = null;
    let failure: unknown = null;
    for (const part of parts.filter((row) => ['PENDING', 'DISPUTED'].includes(row.chainStatus))) {
      try {
        const result = await this.executor.expire({
          chainId,
          requestId: part.chainRequestId,
          provider,
        });
        signature ||= result.signature;
        cancelledAt = result.cancelledAt;
        await this.parts.updatePart(part.organizationId, part.id, {
          chainStatus: 'CANCELLED',
          cancelledAt: result.cancelledAt,
          cancelReason: result.reason ?? null,
        });
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;

    if (parts.some((part) => part.chainStatus === 'EXECUTED')) {
      throw partialExecution(proposal.id, 1, 0);
    }
    return { signature, cancelledAt: cancelledAt ?? new Date() };
  }

  /**
   * When every standing part of the case can be expired (audit E-8): a part
   * `DISPUTED` on chain at `disputedAt + 30 d`, a `PENDING` one — including a
   * part that was disputed and then upheld — at its own `executableAt + 7 d`.
   * The latest of those, or `null` when nothing stands. Reads the stored
   * parts; call after {@link readRecord} has brought them up to date.
   */
  async expirableAt(proposal: SlashProposalEntity): Promise<Date | null> {
    const parts = await this.parts.findForEpoch(
      proposal.organizationId,
      proposal.id,
      proposal.chainEpoch,
    );
    const doors = parts.flatMap((part) => {
      if (part.chainStatus === 'DISPUTED' && part.chainDisputedAt) {
        return [part.chainDisputedAt.getTime() + DISPUTE_TIMEOUT_MS];
      }
      if (part.chainStatus === 'PENDING' && part.chainExecutableAt) {
        return [part.chainExecutableAt.getTime() + SLASH_EXECUTION_GRACE_MS_FOR_PARTS];
      }
      return [];
    });
    return doors.length > 0 ? new Date(Math.max(...doors)) : null;
  }

  /**
   * The admin's unsigned `cancelSlash` for the FIRST part still pending. The
   * case stays `CANCEL_REQUESTED` until every part has left `Pending`, so the
   * operator route hands out the next part's intent on the next request.
   */
  async buildCancel(proposal: SlashProposalEntity, provider: string): Promise<SlashCancelIntent> {
    const chainId = chainIdOf(proposal.assetId as AssetId);
    await this.readRecord(proposal, provider);
    const parts = await this.parts.findForEpoch(
      proposal.organizationId,
      proposal.id,
      proposal.chainEpoch,
    );
    // `cancelSlash` takes a `Pending` or (D-19) a `Disputed` record.
    const next = parts.find((part) => ['PENDING', 'DISPUTED'].includes(part.chainStatus));
    if (!next) return this.cancelWithNoPartStanding(proposal, parts, chainId, provider);
    return this.executor.buildCancel({ chainId, requestId: next.chainRequestId, provider });
  }

  /**
   * No part of the case stands, so there is nothing to sign. What is on chain
   * is read (or, for a case with parts, taken from the parts the sweeps keep
   * in step) — never assumed — and said in a 409 `SLASH_NOTHING_STANDING`
   * whose context names it (`chainStatus`). Nothing is written: the case keeps
   * its status for an operator (or the sweeps) to settle.
   *
   * - **A case with parts** never reads the case's own request id (parts live
   *   at their own ids): `EXECUTED` if any part executed (money moved:
   *   alerted), `PROPOSING` while a part is still `NONE` (it may land), else
   *   `CANCELLED`.
   * - **A case with no parts** (opened before the parts model) is the single
   *   record under its own `chainRequestId`, read live: `Pending`/`Disputed`
   *   stands and its cancel is built; `Executed` is a withdrawn judgement
   *   executed while the cancel waited (alerted; recording it is the
   *   admin-cancel sweep's `recordAnExecutionNobodyAskedFor`); `Cancelled`;
   *   or `NOT_FOUND` (logged as an anomaly when a record was written).
   *
   * An unreadable chain stays a 503.
   */
  private async cancelWithNoPartStanding(
    proposal: SlashProposalEntity,
    parts: readonly SlashProposalPartEntity[],
    chainId: ChainId,
    provider: string,
  ): Promise<SlashCancelIntent> {
    const refuse = (chainStatus: string): never => {
      throw SlashErrors.nothingStanding({ proposalId: proposal.id, chainStatus });
    };

    if (parts.length > 0) {
      if (parts.some((part) => part.chainStatus === 'EXECUTED')) {
        await this.alertExecutedWhileCancelWaited(proposal, 'part');
        return refuse('EXECUTED');
      }
      return refuse(parts.some((part) => part.chainStatus === 'NONE') ? 'PROPOSING' : 'CANCELLED');
    }

    let record: SlashRecordSnapshot | null;
    try {
      record = await this.executor.readRecord(proposal.chainRequestId, provider, chainId);
    } catch (error) {
      throw SlashErrors.chainUnavailable({
        proposalId: proposal.id,
        reason: `its on-chain record could not be read (${chainErrorName(error) ?? 'transport'})`,
      });
    }

    if (record?.status === 'PENDING' || record?.status === 'DISPUTED') {
      return this.executor.buildCancel({ chainId, requestId: proposal.chainRequestId, provider });
    }
    if (record?.status === 'EXECUTED') {
      await this.alertExecutedWhileCancelWaited(proposal, 'record');
      return refuse('EXECUTED');
    }
    if (!record && proposal.chainProposedAt) {
      this.logger.error(
        `slash proposal ${proposal.id}: a record was written on chain (${proposal.chainProposedAt.toISOString()}) ` +
          `but none is found at ${proposal.chainRequestId}; left for a human`,
      );
    }
    return refuse(record?.status ?? 'NOT_FOUND');
  }

  /**
   * A judgement this platform had withdrawn was executed on chain while its
   * cancel waited. Money left the provider's stake; it is paged, not hidden.
   * Recording the execution (and compensating) belongs to the admin-cancel
   * sweep's `recordAnExecutionNobodyAskedFor`, outside this class.
   */
  private async alertExecutedWhileCancelWaited(
    proposal: SlashProposalEntity,
    where: 'part' | 'record',
  ): Promise<void> {
    this.logger.error(
      `slash proposal ${proposal.id} (${proposal.status}): its on-chain ${where} was EXECUTED while ` +
        `the cancel waited; the stake was taken. Not written as cancelled — needs recording and a human`,
    );
    try {
      await this.alerts?.emit({
        severity: AlertSeverity.CRITICAL,
        name: EXECUTED_WHILE_CANCEL_WAITED_ALERT,
        summary: 'A withdrawn slash judgement was executed on chain while its cancel waited',
        details: {
          proposalId: proposal.id,
          requestId: proposal.chainRequestId,
          caseStatus: proposal.status,
          penaltyMinor: proposal.penaltyAmount,
          where,
        },
        aggregation: AlertAggregation.ONCE_PER_INCIDENT,
        dedupeKey: proposal.id,
      });
    } catch (error) {
      this.logger.error(
        `slash proposal ${proposal.id}: the executed-while-cancel-waited alert failed`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /**
   * The parts of an already-executed case that are not settled on chain, and
   * what to do about each — revisited by the reconcile pass every tick.
   *
   * - A part still PENDING, or a REFUSED straggler whose in-flight
   *   transaction landed after it was given up on, is re-read (by the one
   *   match rule). A live, due record is EXECUTED — it is money the agent is
   *   owed, not a reservation to release. All of a case's due parts go in one
   *   batch, as one atomic group.
   * - A record that can never execute (its verifier may no longer sign, or the
   *   grace has run) is EXPIRED, which releases the provider's stake.
   * - Anything else — not yet due, not yet expirable — is left alone, with no
   *   transaction attempted and nothing written: it is simply early.
   *
   * Never throws for one part's sake.
   */
  /** The cases {@link sweepStrandedParts} should visit. */
  findCasesWithStrandedParts(limit: number) {
    return this.parts.findCasesWithStrandedParts(limit);
  }

  async sweepStrandedParts(
    cases: readonly PartitionedCase[],
    now: Date = new Date(),
  ): Promise<{ expired: number; executed: number; waiting: number; executedCases: string[] }> {
    let expired = 0;
    let executed = 0;
    let waiting = 0;
    const executedCases = new Set<string>();

    for (const { proposal, provider } of cases) {
      const chainId = chainIdOf(proposal.assetId as AssetId);
      const parts = await this.parts.findForEpoch(
        proposal.organizationId,
        proposal.id,
        proposal.chainEpoch,
      );
      if (!parts.some((part) => part.chainStatus === 'EXECUTED')) continue;

      const due: SlashProposalPartEntity[] = [];
      for (const part of parts.filter((row) =>
        ['PENDING', 'DISPUTED', 'REFUSED'].includes(row.chainStatus),
      )) {
        try {
          const record = await this.readMatching(part, proposal, provider, chainId);
          if (!record) continue; // never landed (a refusal that stands), or not ours
          if (record.status === 'DISPUTED') {
            // D-19: no execution until the arbiter rules; expirable once the
            // key is gone or `disputedAt + 30 d` has passed.
            await this.mirrorRecord(part, record);
            const timedOut =
              record.disputedAt !== null &&
              record.disputedAt !== undefined &&
              now.getTime() >= record.disputedAt.getTime() + DISPUTE_TIMEOUT_MS;
            if (record.verifierCanSign === false || timedOut) {
              const result = await this.executor.expire({
                chainId,
                requestId: part.chainRequestId,
                provider,
              });
              await this.parts.updatePart(part.organizationId, part.id, {
                chainStatus: 'CANCELLED',
                cancelledAt: result.cancelledAt,
                cancelReason: result.reason ?? null,
                chainLastError: null,
              });
              expired += 1;
            } else {
              waiting += 1;
            }
            continue;
          }
          if (record.status !== 'PENDING') {
            await this.mirrorRecord(part, record);
            continue;
          }
          if (part.chainStatus === 'REFUSED') {
            // A straggler's late transaction landed: it is a live judgement again.
            await this.mirrorRecord(part, record);
            this.logger.warn(
              `slash part ${part.chainRequestId} (case ${proposal.id}) was given up on but its ` +
                `record landed later; it is PENDING again`,
            );
          }
          const doorOpen = now.getTime() >= record.executableAt.getTime();
          const graceOver =
            now.getTime() >= record.executableAt.getTime() + SLASH_EXECUTION_GRACE_MS_FOR_PARTS;
          const keyGone = record.verifierCanSign === false;
          if (doorOpen && !graceOver && !keyGone) {
            due.push(part);
          } else if (keyGone || graceOver) {
            const result = await this.executor.expire({
              chainId,
              requestId: part.chainRequestId,
              provider,
            });
            await this.parts.updatePart(part.organizationId, part.id, {
              chainStatus: 'CANCELLED',
              cancelledAt: result.cancelledAt,
              cancelReason: result.reason ?? null,
              chainLastError: null,
            });
            expired += 1;
          } else {
            waiting += 1; // early: nothing to send, nothing to write
          }
        } catch (error) {
          waiting += 1;
          await this.parts
            .updatePart(part.organizationId, part.id, {
              chainLastError: chainErrorName(error) ?? 'transport',
            })
            .catch(() => undefined);
        }
      }

      if (due.length === 0) continue;
      const outcomes = await this.executor.executeBatch(
        due.map((part) => ({
          chainId,
          requestId: part.chainRequestId,
          provider,
          beneficiary: parseAccountId(part.beneficiaryAccount).address,
          atomicGroup: proposal.id,
        })),
      );
      for (const [index, outcome] of outcomes.entries()) {
        const part = due[index];
        if (outcome.ok && outcome.result) {
          await this.parts.updatePart(part.organizationId, part.id, {
            chainStatus: 'EXECUTED',
            appliedAmount: outcome.result.appliedMinor,
            agentAmount: outcome.result.agentAmountMinor,
            platformAmount: outcome.result.platformAmountMinor,
            executedAt: outcome.result.executedAt,
            executionSignature: outcome.result.signature,
            chainLastError: null,
          });
          executed += 1;
          executedCases.add(proposal.id);
        } else {
          waiting += 1;
          await this.parts
            .updatePart(part.organizationId, part.id, {
              chainLastError: chainErrorName(outcome.error) ?? 'transport',
            })
            .catch(() => undefined);
        }
      }
    }
    return { expired, executed, waiting, executedCases: [...executedCases] };
  }

  // ── shared ──────────────────────────────────────────────────────────────

  private async mirrorRecord(
    part: SlashProposalPartEntity,
    record: SlashRecordSnapshot,
  ): Promise<void> {
    const status: SlashPartChainStatus = STATUS_FOR_RECORD[record.status];
    await this.parts.updatePart(part.organizationId, part.id, {
      chainStatus: status,
      chainProposedAt: record.proposedAt,
      chainExecutableAt: record.executableAt,
      chainReserved: record.reservedMinor,
      // D-19: kept after an uphold, as the record of the dispute.
      ...(record.disputedAt ? { chainDisputedAt: record.disputedAt } : {}),
      ...(record.status === 'EXECUTED'
        ? {
            // Keep the receipt-derived amounts if the live path wrote them.
            appliedAmount: part.appliedAmount ?? record.appliedMinor,
            agentAmount: part.agentAmount ?? record.agentAmountMinor,
            platformAmount: part.platformAmount ?? record.platformAmountMinor,
            executedAt: part.executedAt ?? record.executedAt ?? new Date(),
          }
        : {}),
      ...(record.status === 'CANCELLED'
        ? {
            cancelledAt: part.cancelledAt ?? record.cancelledAt ?? new Date(),
            // Review R2-8: the reason the read observed, never a guess; a
            // known reason is not overwritten.
            ...(record.cancelReason && !part.cancelReason
              ? { cancelReason: record.cancelReason }
              : {}),
          }
        : {}),
    });
  }
}

const STATUS_FOR_RECORD: Readonly<Record<SlashRecordStatus, SlashPartChainStatus>> = {
  PENDING: 'PENDING',
  DISPUTED: 'DISPUTED',
  EXECUTED: 'EXECUTED',
  CANCELLED: 'CANCELLED',
};

function toView(part: SlashProposalPartEntity): SlashPartView {
  return {
    status: part.chainStatus as SlashPartChainStatus,
    penaltyMinor: part.penaltyAmount,
    reservedMinor: part.chainReserved,
    appliedMinor: part.appliedAmount,
    agentAmountMinor: part.agentAmount,
    platformAmountMinor: part.platformAmount,
    proposedAt: part.chainProposedAt,
    executableAt: part.chainExecutableAt,
    executedAt: part.executedAt,
    cancelledAt: part.cancelledAt,
    disputedAt: part.chainDisputedAt,
  };
}

/**
 * Unnamed on purpose: `customErrorCode: null` reads as "the program never
 * spoke", which leaves the case `EXECUTING` for the reconciler instead of
 * voiding it or returning it to the queue as if nothing had happened.
 */
function partialExecution(proposalId: string, executed: number, pending: number) {
  return ChainErrors.transactionFailed({
    instruction: 'executeSlash',
    reason:
      `case ${proposalId} is partly executed (${executed} part(s) executed, ${pending} still ` +
      'pending); left for the reconciler',
    customErrorCode: null,
  });
}
