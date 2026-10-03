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
   * Every ACTIVE binding that requires stake, from every provider.
   *
   * The stake monitor's input. Deliberately narrower than {@link findByTool} in
   * both directions, and both narrowings are decisions rather than
   * optimisations:
   *
   * - **`ACTIVE` only.** A grace period protects traffic that is already
   *   flowing; it does not open the door. A `DRAFT`, `PAUSED` or `SUSPENDED`
   *   binding takes no paid traffic, so a countdown against it would be a
   *   promise about nothing — and it would consume the one open row per binding
   *   that the real thing needs when the binding goes live.
   * - **`FREE` excluded.** Nothing settles on a free call, so no defection
   *   profits and no stake is required. `evaluateStakeGate` exempts it, and a
   *   monitor that did not would open grace rows against a floor of zero.
   *   `FREEMIUM` is *included*, exactly as the gate includes it: the same
   *   binding serves both free and paid calls.
   *
   * Cross-organization for the same reason as {@link findByTool} — the caller
   * is a scheduler sweeping the whole deployment once, not a tenant asking
   * about itself.
   */
  async findActivePaidBindings(): Promise<ToolBindingEntity[]> {
    return this.createQueryBuilder('binding')
      .where('binding.organizationId IS NOT NULL')
      .andWhere('binding.status = :status', { status: 'ACTIVE' })
      .andWhere('binding.pricingMode != :free', { free: 'FREE' })
      .orderBy('binding.organizationId', 'ASC')
      .addOrderBy('binding.id', 'ASC')
      .getMany();
  }

  /**
   * Every ACTIVE binding, from every provider, in every pricing mode.
   *
   * The catalogue's input, and deliberately a different question from both
   * neighbours above:
   *
   * - **`ACTIVE` only**, unlike {@link findByTool}. A catalogue row is an
   *   invitation to call: listing a `DRAFT` or `PAUSED` binding advertises a
   *   provider the router would reject, which is a promise the platform cannot
   *   keep. The distinction `findByTool` preserves — "no provider" versus
   *   "every provider is paused" — matters on a receipt explaining a refusal,
   *   and does not matter in a shop window.
   * - **`FREE` included**, unlike {@link findActivePaidBindings}. That method
   *   excludes it because nothing settles on a free call so no stake is
   *   required; a buyer browsing wants the free ones most of all.
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

  /**
   * Every tool id that has at least one binding, from every provider.
   *
   * Cross-organization for the same reason as {@link findByTool}: it answers
   * "which tools can be served at all", which is a question about the whole
   * catalogue and not about one tenant.
   */
  async findServedToolIds(): Promise<string[]> {
    const rows = await this.createQueryBuilder('binding')
      .select('DISTINCT binding.tool_id', 'toolId')
      .where('binding.organizationId IS NOT NULL')
      .getRawMany<{ toolId: string }>();

    return rows.map((row) => row.toolId);
  }
}
