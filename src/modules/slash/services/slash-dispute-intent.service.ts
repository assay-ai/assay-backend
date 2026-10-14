import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Optional } from '@nestjs/common';

import { ProviderChainEnrolmentRepository } from '@database/postgres/repositories/provider-chain-enrolment.repository';
import { SlashProposalPartRepository } from '@database/postgres/repositories/slash-proposal-part.repository';
import { ChainErrors } from '@modules/chains/errors/chains.errors';
import {
  ChainId,
  ChainNamespace,
  isChainId,
  namespaceOf,
  parseAccountId,
} from '@modules/chains/ports/caip.types';
import { OperatorSession } from '@modules/operator/ports/operator-session.port';
import { OverrideLogService } from '@modules/operator/services/override-log.service';
import { ProviderErrors } from '@modules/provider/errors/provider.errors';

import { SlashProposalRepository } from '@database/postgres/repositories/slash-proposal.repository';

import { DISPUTE_TIMEOUT_MS } from '../constants/slash.constants';
import { BeneficiaryEvidence } from '../domain/slash-beneficiary-evidence';
import { SlashErrors } from '../errors/slash.errors';
import {
  SLASH_DISPUTE_INTENTS,
  SlashBatchBuild,
  SlashChainTerms,
  SlashContractCall,
  SlashDisputeIntentPort,
  SlashRuling,
} from '../ports/slash-dispute-intent.port';
import { SlashPartsService } from './slash-parts.service';

/** Who asked, and why, for the override register entry an arbiter intent writes. */
export interface ArbiterIntentContext {
  readonly operator: OperatorSession;
  readonly reasonCode: string;
  readonly note: string;
  readonly ticketRef?: string | null;
  readonly requestId: string | null;
}

/**
 * The dispute upgrade's unsigned transactions (assay-evm D-19), for the two
 * people who sign them: the provider (`disputeSlashBatch`) and the arbiter
 * (`upholdSlashBatch`, `cancelSlashBatch`, `setBlocked`).
 *
 * Builds only. Nothing about a case changes here; the chain watcher mirrors
 * the person's transaction when it lands. The arbiter intents are written to
 * the override register (`S-13`, `A-11`) because an operator chose to prepare
 * a ruling or a block — the register is the record of who and why, even
 * though the arbiter's own signature is the act.
 */
@Injectable()
export class SlashDisputeIntentService {
  constructor(
    private readonly enrolments: ProviderChainEnrolmentRepository,
    private readonly overrides: OverrideLogService,
    private readonly parts: SlashProposalPartRepository,
    @Optional()
    @Inject(SLASH_DISPUTE_INTENTS)
    private readonly intents: SlashDisputeIntentPort | null = null,
    @Optional() private readonly proposals: SlashProposalRepository | null = null,
    @Optional() private readonly partsService: SlashPartsService | null = null,
  ) {}

  /**
   * The arbiter's queue: every record disputed on chain, with its case and the
   * moment `expireSlash` can end it (`disputedAt + 30 d`).
   */
  async disputedOnChain(limit = 200, now: Date = new Date()) {
    const rows = await this.parts.findChainDisputed(limit);
    // C4: how often each provider was found at fault lately, so an operator
    // knows when to ban it with the blocklist.
    const violations =
      (await this.proposals
        ?.countUpheldViolationsByProvider(
          rows.map((row) => row.providerId),
          new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
        )
        .catch(() => null)) ?? new Map<string, number>();
    // C5: the beneficiary evidence, with the chain's live agent share.
    const agentBps = new Map<string, number | null>();
    for (const chainId of new Set(rows.map((row) => chainOfAsset(row.assetId)))) {
      agentBps.set(
        chainId,
        await this.chainTerms(chainId)
          .then((terms) => terms.slashAgentBps)
          .catch(() => null),
      );
    }
    const evidence = new Map<string, BeneficiaryEvidence>();
    for (const row of rows) {
      const bps = agentBps.get(chainOfAsset(row.assetId));
      if (!this.partsService || bps === null || bps === undefined || !row.windowId) continue;
      const [found] = await this.partsService
        .beneficiaryEvidenceOf(
          {
            windowId: row.windowId,
            assetId: row.assetId,
            providerId: row.providerId,
            penaltyAmount: String(row.casePenaltyAmount),
          },
          [
            {
              chainRequestId: row.requestId,
              agentAccount: row.agentAccount,
              beneficiaryAccount: row.beneficiaryAccount,
              penaltyAmount: String(row.penaltyAmount),
            } as never,
          ],
          bps,
        )
        .catch(() => []);
      if (found) evidence.set(row.requestId, found);
    }
    return rows.map((row) => {
      const disputedAt = row.chainDisputedAt ? new Date(row.chainDisputedAt) : null;
      const found = evidence.get(row.requestId);
      return {
        upheldViolations30d: violations.get(row.providerId) ?? 0,
        beneficiary: row.beneficiaryAccount,
        beneficiaryEvidence: found
          ? {
              payer: found.payer,
              failedCalls: found.failedCalls,
              paidAmount: found.paidMinor,
              formulaShareAmount: found.formulaShareMinor,
              redeemedAmount: found.redeemedMinor,
              shareAmount: found.shareMinor,
              ok: found.ok,
              reason: found.reason,
            }
          : null,
        requestId: `0x${row.requestId}`,
        proposalId: row.proposalId,
        providerId: row.providerId,
        chainId: chainOfAsset(row.assetId),
        caseStatus: row.caseStatus,
        caseChainStatus: row.caseChainStatus,
        penaltyAmount: String(row.penaltyAmount),
        reservedAmount: row.chainReserved === null ? null : String(row.chainReserved),
        disputedAt: disputedAt?.toISOString() ?? null,
        executableAt: row.chainExecutableAt ? new Date(row.chainExecutableAt).toISOString() : null,
        expiresAt: disputedAt
          ? new Date(disputedAt.getTime() + DISPUTE_TIMEOUT_MS).toISOString()
          : null,
      };
    });
  }

  async chainTerms(chainId: string): Promise<SlashChainTerms> {
    return this.port().chainTerms(this.evmChain(chainId));
  }

  /**
   * `disputeSlashBatch` for the provider's own stake wallet on `chainId`. A
   * refused id refuses the request (422, one entry per id), because the chain
   * would revert the whole batch on it.
   */
  async providerDispute(
    organizationId: string,
    chainId: string,
    requestIds: readonly string[],
  ): Promise<SlashContractCall> {
    const chain = this.evmChain(chainId);
    const enrolment = await this.enrolments.findOneBy({ organizationId, chainId: chain });
    if (!enrolment?.stakeAuthorityAccountId) {
      throw ProviderErrors.stakeAuthorityUnprovenFor({
        providerId: organizationId,
        chainId: chain,
      });
    }
    const built = await this.port().buildDisputeBatch({
      chainId: chain,
      provider: parseAccountId(enrolment.stakeAuthorityAccountId as never).address,
      requestIds,
    });
    return this.accepted(built, 'disputeSlashBatch');
  }

  /** `S-13`: the arbiter's `upholdSlashBatch` or `cancelSlashBatch`, logged. */
  async arbiterRuling(
    context: ArbiterIntentContext,
    chainId: string,
    ruling: SlashRuling,
    requestIds: readonly string[],
  ): Promise<SlashContractCall> {
    const chain = this.evmChain(chainId);
    const built = await this.port().buildRulingBatch({ chainId: chain, ruling, requestIds });
    const call = this.accepted(
      built,
      ruling === 'UPHOLD' ? 'upholdSlashBatch' : 'cancelSlashBatch',
    );
    return this.logged(context, 'S-13', 'slash_record_batch', call, { ruling });
  }

  /** `A-11`: the arbiter's `setBlocked(account, true)`, logged. Block only. */
  async arbiterBlock(
    context: ArbiterIntentContext,
    chainId: string,
    account: string,
  ): Promise<SlashContractCall> {
    const chain = this.evmChain(chainId);
    const call = await this.port().buildBlock({ chainId: chain, account });
    return this.logged(context, 'A-11', 'chain_blocklist', call, {
      account: account.toLowerCase(),
    });
  }

  private accepted(built: SlashBatchBuild, functionName: string): SlashContractCall {
    if (built.call) {
      return { ...built.call, requestIds: built.call.requestIds.map((id) => `0x${id}`) };
    }
    throw SlashErrors.chainBatchRefused({ functionName, refusals: built.refusals });
  }

  private async logged(
    context: ArbiterIntentContext,
    code: string,
    targetType: string,
    call: SlashContractCall,
    detail: Record<string, unknown>,
  ): Promise<SlashContractCall> {
    return this.overrides.perform<SlashContractCall>(
      {
        code,
        actor: context.operator,
        // An intent is not a tenant's record; the batch can span providers.
        targetType,
        targetId: randomUUID(),
        organizationId: null,
        reasonCode: context.reasonCode,
        reason: context.note,
        ticketRef: context.ticketRef ?? null,
        requestId: context.requestId,
      },
      async () => ({
        value: call,
        before: {},
        after: {
          ...detail,
          chainId: call.chainId,
          to: call.to,
          functionName: call.functionName,
          signer: call.signer,
          signerRole: call.signerRole,
          requestIds: call.requestIds,
          signed: false,
        },
      }),
    );
  }

  private evmChain(chainId: string): ChainId {
    if (!isChainId(chainId) || namespaceOf(chainId as ChainId) !== ChainNamespace.EIP155) {
      throw ChainErrors.unsupportedChain({ chainId });
    }
    return chainId as ChainId;
  }

  private port(): SlashDisputeIntentPort {
    if (!this.intents) {
      throw SlashErrors.chainUnavailable({ reason: 'no EVM settlement contracts are configured' });
    }
    return this.intents;
  }
}

/** `eip155:46630/erc20:0x…` → `eip155:46630`. */
function chainOfAsset(assetId: string): string {
  return assetId.split('/')[0];
}
