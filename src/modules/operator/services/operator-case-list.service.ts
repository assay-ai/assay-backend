import { Inject, Injectable } from '@nestjs/common';

import { ProviderRepository } from '@database/postgres/repositories/provider.repository';
import {
  OperatorCaseKey,
  OperatorCaseListRow,
  SlashProposalRepository,
} from '@database/postgres/repositories/slash-proposal.repository';
import { AssetId, chainIdOf } from '@modules/chains/ports/caip.types';
import { TOOL_CATALOGUE, ToolCataloguePort } from '@modules/tool/ports/tool-catalogue.port';
import {
  ApiErrors,
  CursorPageDto,
  decodeCompositeCursor,
  encodeCompositeCursor,
} from '@shared/api';

import { ListOperatorCasesQueryDto, OperatorCaseListRowDto } from '../dto/operator-case-list.dto';

/** What the cursor is stamped with; a cursor from another list is refused. */
const CASE_LIST_SORT = 'nextDeadline:asc';

const NUMERIC = /^-?\d+(\.\d+)?$/;
/** `k1` as the repository writes it: UTC, microseconds, or `infinity` for no deadline. */
const INSTANT = /^(infinity|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Every penalty, for the console's Penalties list (`GET /operator/cases`).
 *
 * Every slash proposal by where it stands now, so Support and on-call can
 * browse rather than arrive with a link. Read-only, and each row is
 * built field by field into {@link OperatorCaseListRowDto} — the allowlist is
 * the point, see the DTO.
 */
@Injectable()
export class OperatorCaseListService {
  constructor(
    private readonly proposals: SlashProposalRepository,
    private readonly providers: ProviderRepository,
    @Inject(TOOL_CATALOGUE) private readonly catalogue: ToolCataloguePort,
  ) {}

  async list(query: ListOperatorCasesQueryDto): Promise<CursorPageDto<OperatorCaseListRowDto>> {
    const rows = await this.proposals.findOperatorCasePage({
      statuses: query.status,
      providerId: query.providerId,
      after: query.cursor ? decodeKey(query.cursor) : null,
      limit: query.limit + 1,
    });

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;

    const [providerNames, toolNames] = await Promise.all([
      this.providerNames(page.map((row) => row.providerId)),
      this.toolNames(page.map((row) => row.toolId)),
    ]);

    const items = page.map((row) => toDto(row, providerNames, toolNames));
    const last = page[page.length - 1];
    return new CursorPageDto(items, hasMore && last ? encodeKey(last) : null);
  }

  private async providerNames(ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    const map = new Map<string, string>();
    if (unique.length === 0) return map;
    // A case's `providerId` is the provider's ORGANIZATION id (see
    // `SlashProposalEntity.providerId`), not the `providers` row id, so the
    // name is looked up by tenant; each key still names its own tenant, so the
    // scoped repository's guard holds. Matching on `id` too found nothing and
    // the list showed the organization id as the name.
    const providers = await this.providers.find({
      where: unique.map((id) => ({ organizationId: id })),
      select: { organizationId: true, legalName: true },
    });
    for (const provider of providers) map.set(provider.organizationId, provider.legalName);
    return map;
  }

  private async toolNames(ids: (string | null)[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((id): id is string => id !== null))];
    const map = new Map<string, string>();
    await Promise.all(
      unique.map(async (id) => {
        const tool = await this.catalogue.findTool(id).catch(() => null);
        map.set(id, tool?.name ?? id);
      }),
    );
    return map;
  }
}

function toDto(
  row: OperatorCaseListRow,
  providerNames: Map<string, string>,
  toolNames: Map<string, string>,
): OperatorCaseListRowDto {
  return {
    proposalId: row.id,
    providerId: row.providerId,
    providerName: providerNames.get(row.providerId) ?? row.providerId,
    toolName: row.toolId ? (toolNames.get(row.toolId) ?? row.toolId) : null,
    amount: { amount: row.penaltyAmount, asset: row.assetId, decimals: row.decimals },
    chainId: chainOf(row.assetId),
    status: row.status,
    proposedAt: row.proposedAt,
    disputedAt: row.disputedAt,
    nextDeadline: row.nextDeadline,
    onChain: Boolean(row.onChain),
  };
}

function chainOf(assetId: string): string {
  try {
    return chainIdOf(assetId as AssetId);
  } catch {
    // An asset id that is not CAIP-19 still names its chain before the slash.
    return assetId.split('/')[0];
  }
}

export function encodeKey(key: OperatorCaseKey): string {
  return encodeCompositeCursor([key.k1, key.k2, key.k3], key.id, CASE_LIST_SORT);
}

/**
 * The cursor back into a keyset position, checked part by part: each part is
 * bound and cast by Postgres, so a hand-made value that does not cast must be a
 * 400 here and never a 500 there.
 */
export function decodeKey(cursor: string): OperatorCaseKey {
  const {
    parts: [k1, k2, k3],
    id,
  } = decodeCompositeCursor(cursor, CASE_LIST_SORT, 3);
  if (!INSTANT.test(k1) || !NUMERIC.test(k2) || !NUMERIC.test(k3) || !UUID.test(id)) {
    throw ApiErrors.invalidCursor({ detail: 'malformed position' });
  }
  return { k1, k2, k3, id };
}
