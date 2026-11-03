import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';

import { DepositIntentEntity } from '@database/postgres/entities/deposit-intent.entity';
import { DepositIntentRepository } from '@database/postgres/repositories/deposit-intent.repository';
import { AccountId, AssetId, ChainId } from '@modules/chains/ports/caip.types';
import { DepositOwnerScope } from '@shared/auth/deposit-owner-scope';
import { MoneyUtil } from '@shared/utils/money.util';

import { depositIntentTtlMs } from '../constants/deposit-intent.constants';
import { requireDepositIntentTransition } from '../domain/deposit-intent-transitions';
import { PaymentErrors } from '../errors/payment.errors';
import {
  CreateDepositIntentInput,
  DepositIntent,
  DepositIntentStatus,
  DepositIntentTransitionContext,
} from '../ports/deposit.types';

/**
 * Persistence and the state machine for deposit intents.
 *
 * Deliberately parallel to `PaymentIntentService`, not a wrapper around it: a
 * deposit has no idempotency key, no voucher nonce and no hold to secure —
 * there is nothing to reserve against a balance that does not exist yet. What
 * carries over is the discipline: the status only ever changes through
 * `transition`, and `transition` only ever takes an edge
 * `DEPOSIT_INTENT_TRANSITIONS` lists.
 */
@Injectable()
export class DepositIntentService {
  constructor(private readonly deposits: DepositIntentRepository) {}

  async create(input: CreateDepositIntentInput): Promise<DepositIntent> {
    const row: Partial<DepositIntentEntity> = {
      id: randomUUID(),
      organizationId: input.organizationId,
      status: DepositIntentStatus.CREATED,
      statusReason: null,
      agentId: input.agentId,
      agentAccount: input.agentAccount,
      assetId: input.requestedAmount.asset,
      decimals: input.requestedAmount.decimals,
      requestedAmount: input.requestedAmount.amount,
      settledAmount: null,
      chainId: input.chainId,
      chainTxRef: null,
      expiresAt: input.expiresAt ?? new Date(Date.now() + depositIntentTtlMs(input.chainId)),
    };

    await this.deposits.insert(row);
    return this.findById(
      { organizationId: input.organizationId, agentId: input.agentId },
      row.id as string,
    );
  }

  /**
   * One intent, inside `scope`: another agent's intent (for an agent caller)
   * or another organization's is the same 404 as a missing one.
   */
  async findById(scope: DepositOwnerScope, intentId: string): Promise<DepositIntent> {
    const row = await this.deposits.findOneBy({
      organizationId: scope.organizationId,
      id: intentId,
      ...(scope.agentId === null ? {} : { agentId: scope.agentId }),
    });
    if (!row) {
      throw PaymentErrors.depositIntentNotFound({ id: intentId });
    }
    return toDepositIntent(row);
  }

  /**
   * Whether `account` was already credited from this transaction, anywhere on
   * the platform — see `DepositIntentRepository.findClaimOfTxRef`. The replay
   * guard for a buyer-broadcast deposit, where the hash arrives from the
   * client rather than from the facilitator.
   */
  findClaimOfTxRef(
    chainTxRef: string,
    account: string,
  ): Promise<{ readonly intentId: string | null } | null> {
    return this.deposits.findClaimOfTxRef(chainTxRef, account);
  }

  /** Open (`SETTLING`, or `CREATED` and unexpired) intents of one agent. */
  countOpenForAgent(organizationId: string, agentId: string): Promise<number> {
    return this.deposits.countOpenForAgent(organizationId, agentId, new Date());
  }

  /**
   * Takes one edge of the state machine, atomically. Same compare-and-swap
   * shape as `PaymentIntentService.transition` — see there for why the table
   * is consulted before Postgres is asked to do anything.
   */
  async transition(
    organizationId: string,
    intentId: string,
    from: DepositIntentStatus,
    to: DepositIntentStatus,
    context: DepositIntentTransitionContext = {},
  ): Promise<DepositIntent> {
    requireDepositIntentTransition(from, to, { intentId });

    const affected = await this.deposits.transitionIfInStatus(organizationId, intentId, from, to, {
      statusReason: context.reason ?? null,
      ...(context.settledAmount !== undefined
        ? { settledAmount: context.settledAmount.amount }
        : {}),
      ...(context.chainTxRef !== undefined ? { chainTxRef: context.chainTxRef } : {}),
    });

    if (affected !== 1) {
      const current = await this.deposits.findOneBy({ organizationId, id: intentId });
      if (!current) {
        throw PaymentErrors.depositIntentNotFound({ id: intentId });
      }
      throw PaymentErrors.depositInvalidStateTransition({
        intentId,
        from,
        to,
        actual: current.status,
      });
    }

    return this.findById({ organizationId, agentId: null }, intentId);
  }
}

export function toDepositIntent(row: DepositIntentEntity): DepositIntent {
  const asset = row.assetId as AssetId;
  const money = (amount: string) => MoneyUtil.of(amount, asset, row.decimals);

  return {
    id: row.id,
    organizationId: row.organizationId,
    status: row.status as DepositIntentStatus,
    statusReason: row.statusReason,
    agentId: row.agentId,
    agentAccount: row.agentAccount as AccountId,
    requestedAmount: money(row.requestedAmount),
    settledAmount: row.settledAmount === null ? null : money(row.settledAmount),
    chainId: row.chainId as ChainId,
    chainTxRef: row.chainTxRef,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
