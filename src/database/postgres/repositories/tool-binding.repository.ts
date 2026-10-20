import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { ToolBindingEntity } from '../entities/tool-binding.entity';
import { OrganizationScopedRepository } from './organization-scoped.repository';

/**
 * `tool_bindings`.
 *
 * Everything a provider does to their own bindings goes through the inherited,
 * organization-scoped methods. The one method below is deliberately *not*
 * scoped, and it is the router's.
 */
@Injectable()
export class ToolBindingRepository extends OrganizationScopedRepository<ToolBindingEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(ToolBindingEntity, dataSource);
  }

  /**
   * Every binding for one tool, from every provider, in every state.
   *
   * Cross-organization on purpose, and the only such read here. Routing is the
   * one operation in the system that is *about* comparing tenants: an agent
   * asks for `search_web` and the router weighs every provider who implements
   * it. Scoping this to the caller's organization would mean an agent could
   * only ever be routed to itself.
   *
   * Unfiltered by status for the reason `ToolCataloguePort.findBindings` gives:
   * `filterEligible` rejects `DRAFT`/`PAUSED`/`SUSPENDED` *with a reason*, and
   * a query that returned only the active ones would make "no provider
   * available" and "every provider is paused" indistinguishable on the receipt.
   *
   * Same `organizationId IS NOT NULL` idiom as the five other cross-tenant
   * reads on the allowlist in `test/unit/shared/api/surface-consistency.spec.ts`.
   */
  async findByTool(toolId: string): Promise<ToolBindingEntity[]> {
    return this.createQueryBuilder('binding')
      .where('binding.organizationId IS NOT NULL')
      .andWhere('binding.toolId = :toolId', { toolId })
      .orderBy('binding.id', 'ASC')
      .getMany();
  }

  /**
   * Every ACTIVE binding, from every provider, in every pricing mode.
   *
   * The input of both the catalogue and the stake monitor, and deliberately a
   * different question from {@link findByTool}:
   *
   * - **`ACTIVE` only.** A catalogue row is an invitation to call: listing a
   *   `DRAFT` or `PAUSED` binding advertises a provider the router would
   *   reject, which is a promise the platform cannot keep. A grace period
   *   protects traffic that is already flowing, so a countdown against a
   *   binding taking no traffic would be a promise about nothing. The
   *   distinction `findByTool` preserves — "no provider" versus "every
   *   provider is paused" — matters on a receipt explaining a refusal, and
   *   does not matter to either caller.
   * - **No pricing filter.** `pricing_mode` on the row may be an unpublished
   *   draft, so whether a binding is free is only knowable after the row is
   *   mapped to its published revision (`toServedToolBindings`). The stake
   *   monitor drops `FREE` after that mapping; a buyer browsing wants the free
   *   ones most of all.
   *
   * Cross-organization for the same reason as {@link findByTool}: the caller is
   * a buyer asking what the platform can serve, and scoping that to their own
   * organization would answer "whatever you already sell to yourself".
   */
  async findActiveBindings(): Promise<ToolBindingEntity[]> {
    return this.createQueryBuilder('binding')
      .where('binding.organizationId IS NOT NULL')
      .andWhere('binding.status = :status', { status: 'ACTIVE' })
      .orderBy('binding.organizationId', 'ASC')
      .addOrderBy('binding.id', 'ASC')
      .getMany();
  }
}
