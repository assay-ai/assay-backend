import {
  SlashBatchOutcome,
  SlashCancelIntent,
  SlashCancelRequest,
  SlashCancelResult,
  SlashExecutionRequest,
  SlashExecutionResult,
  SlashExecutorPort,
  SlashProposalRequest,
  SlashProposalResult,
  SlashRecordSnapshot,
} from '@modules/slash/ports/slash-executor.port';
import { SlashCaps, SlashCapsReaderPort } from '@modules/slash/ports/slash-caps-reader.port';

import { AccountId, AssetId, ChainId, namespaceOf } from '../ports/caip.types';
import { implementationFor } from './namespace-dispatch';

/**
 * `SlashExecutorPort` over more than one namespace.
 *
 * `SLASH_EXECUTOR` was `useExisting: SolanaSlashExecutor` for every chain, so
 * an `eip155` case reached Solana address parsing and failed as `'transport'`
 * on every sweep, for ever. Every door now dispatches on its own request's
 * `chainId` — never on a configured default — and a batch is split by
 * namespace, answered per namespace, and reassembled in request order.
 */
export class NamespaceSlashExecutor implements SlashExecutorPort {
  constructor(private readonly byNamespace: ReadonlyMap<string, SlashExecutorPort>) {}

  propose(request: SlashProposalRequest): Promise<SlashProposalResult> {
    return implementationFor(this.byNamespace, request.chainId).propose(request);
  }

  executeProposal(request: SlashExecutionRequest): Promise<SlashExecutionResult> {
    return implementationFor(this.byNamespace, request.chainId).executeProposal(request);
  }

  proposeBatch(
    requests: readonly SlashProposalRequest[],
  ): Promise<readonly SlashBatchOutcome<SlashProposalResult>[]> {
    return this.split(requests, (impl, group) => impl.proposeBatch(group));
  }

  executeBatch(
    requests: readonly SlashExecutionRequest[],
  ): Promise<readonly SlashBatchOutcome<SlashExecutionResult>[]> {
    return this.split(requests, (impl, group) => impl.executeBatch(group));
  }

  buildCancel(request: SlashCancelRequest): Promise<SlashCancelIntent> {
    return implementationFor(this.byNamespace, request.chainId).buildCancel(request);
  }

  expire(request: SlashCancelRequest): Promise<SlashCancelResult> {
    return implementationFor(this.byNamespace, request.chainId).expire(request);
  }

  readRecord(
    requestId: string,
    provider: string,
    chainId: ChainId,
  ): Promise<SlashRecordSnapshot | null> {
    return implementationFor(this.byNamespace, chainId).readRecord(requestId, provider, chainId);
  }

  settlementTreasury(asset: AssetId): Promise<AccountId> {
    return implementationFor(this.byNamespace, asset).settlementTreasury(asset);
  }

  /**
   * Refuses an unserved namespace before any group is sent — the same rule as
   * `groupByNamespace`: a mixed batch with one unserved chain spends nothing.
   */
  private async split<Request extends { chainId: ChainId }, Result>(
    requests: readonly Request[],
    send: (
      impl: SlashExecutorPort,
      group: readonly Request[],
    ) => Promise<readonly SlashBatchOutcome<Result>[]>,
  ): Promise<SlashBatchOutcome<Result>[]> {
    const groups = new Map<string, number[]>();
    requests.forEach((request, index) => {
      implementationFor(this.byNamespace, request.chainId);
      const key = namespaceOf(request.chainId);
      groups.set(key, [...(groups.get(key) ?? []), index]);
    });

    const outcomes: SlashBatchOutcome<Result>[] = new Array(requests.length);
    for (const [, indexes] of groups) {
      const group = indexes.map((index) => requests[index]);
      const answered = await send(implementationFor(this.byNamespace, group[0].chainId), group);
      indexes.forEach((index, position) => {
        outcomes[index] = answered[position];
      });
    }
    return outcomes;
  }
}

/** `SlashCapsReaderPort` by namespace. Only `eip155` has one: pro-rata is an EVM path. */
export class NamespaceSlashCapsReader implements SlashCapsReaderPort {
  constructor(private readonly byNamespace: ReadonlyMap<string, SlashCapsReaderPort>) {}

  readCaps(request: { chainId: ChainId; provider: string }): Promise<SlashCaps> {
    return implementationFor(this.byNamespace, request.chainId).readCaps(request);
  }
}
