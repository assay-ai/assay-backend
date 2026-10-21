import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, IsNull } from 'typeorm';

import {
  CursorPageDto,
  ListQueryDto,
  ListSpec,
  applyTimeWindow,
  asInstant,
  paginate,
} from '@shared/api';

import { AgentEntity } from '../entities/agent.entity';
import { OrganizationEntity } from '../entities/organization.entity';
import { AbstractRepository } from './abstract.repository';

/**
 * `GET /api/v1/agents`. Sorted (and windowed) on `created_at` — the only
 * timestamp on this table that is never null, per `ListSpec.sortable`'s own
 * rule.
 */
const AGENTS_LIST: ListSpec = {
  alias: 'agent',
  defaultSort: 'createdAt',
  sortable: {
    createdAt: {
      column: 'agent.created_at',
      type: 'timestamptz',
      valueOf: asInstant((row: AgentEntity) => row.createdAt),
    },
  },
};

/** What a first login knows about the identity it is provisioning. */
export interface ProvisionAgentInput {
  /** The Privy DID — the `sub` claim of a verified access token. */
  readonly privyUserId: string;
  readonly email: string | null;
  /** Label for the new tenant. Derived from the email or the DID; never typed by the caller. */
  readonly organizationName: string;
  readonly createdVia: string;
  readonly label: string | null;
}

/** An agent together with the status of the tenant it belongs to. */
export interface AgentWithOrganization {
  readonly agent: AgentEntity;
  readonly organizationStatus: string;
}

/**
 * Privy identities and the tenant each belongs to.
 *
 * `AbstractRepository`, not `OrganizationScopedRepository`, for the reason in
 * `AgentEntity`'s docstring: the whole purpose of `findByPrivyUserId` is to
 * discover an organization id, and a scoped repository requires one to ask.
 * Every other read here names the organization explicitly.
 */
@Injectable()
export class AgentRepository extends AbstractRepository<AgentEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(AgentEntity, dataSource);
  }

  /**
   * The agent behind a Privy DID, whatever its `status`.
   *
   * Unfiltered on purpose — same reasoning as
   * `OperatorRepository.findActiveBySubject`: the caller reads `status` itself
   * so it can refuse a suspended agent with a different code than an unknown
   * one, and a filtered finder would erase that distinction before the caller
   * ever saw it.
   */
  findByPrivyUserId(privyUserId: string): Promise<AgentEntity | null> {
    return this.findOne({ where: { privyUserId } });
  }

  findById(id: string): Promise<AgentEntity | null> {
    return this.findOne({ where: { id } });
  }

  /**
   * This organization's agents, paginated (`GET /api/v1/agents`).
   *
   * `AgentRepository` extends `AbstractRepository`, not
   * `OrganizationScopedRepository` — see the class docstring for why. That
   * means nothing between this query and Postgres enforces the tenant
   * boundary automatically: the `.where` below **is** the scoping, written by
   * hand, and every other read on this table that answers "one organization's
   * agents" must do the same.
   */
  async list(
    organizationId: string,
    query: ListQueryDto,
    onlyAgentId?: string,
  ): Promise<CursorPageDto<AgentEntity>> {
    const qb = this.createQueryBuilder('agent').where('agent.organizationId = :organizationId', {
      organizationId,
    });
    // Narrowed in SQL, so the page, its cursor and `hasMore` describe the
    // narrowed list and nothing of the organization's other agents.
    if (onlyAgentId !== undefined) {
      // An empty id narrows to nothing rather than falling back to the whole list.
      qb.andWhere(onlyAgentId ? 'agent.id = :onlyAgentId' : '1 = 0', { onlyAgentId });
    }

    applyTimeWindow(qb, query, AGENTS_LIST);
    return paginate(qb, query, AGENTS_LIST);
  }

  /**
   * The agent behind a DID **and** its tenant's status, in one round trip.
   *
   * Two facts are needed on every authenticated request and both must be read
   * fresh: suspending an agent, or suspending a whole organization, has to
   * take effect on the next call rather than whenever a credential happens to
   * expire. Reading them with two queries would double the database work on
   * the auth hot path to answer one question, so this joins.
   */
  findWithOrganization(privyUserId: string): Promise<AgentWithOrganization | null> {
    return this.findOneWithOrganization('agent.privyUserId = :privyUserId', { privyUserId });
  }

  /**
   * {@link findWithOrganization} by agent id: the join
   * `DbCredentialMcpSessionSource` needs, so a suspended organization stops its
   * machine credentials as well as its people.
   */
  findByIdWithOrganization(id: string): Promise<AgentWithOrganization | null> {
    return this.findOneWithOrganization('agent.id = :id', { id });
  }

  private async findOneWithOrganization(
    where: string,
    parameters: Record<string, string>,
  ): Promise<AgentWithOrganization | null> {
    const result = await this.createQueryBuilder('agent')
      .innerJoin(OrganizationEntity, 'org', 'org.id = agent.organizationId')
      .addSelect('org.status', 'org_status')
      .where(where, parameters)
      .limit(1)
      .getRawAndEntities();

    const agent = result.entities[0];
    if (!agent) return null;

    return {
      agent,
      organizationStatus: String(
        (result.raw[0] as { org_status?: unknown })?.org_status ?? 'ACTIVE',
      ),
    };
  }

  /**
   * First login: the organization and its first agent, in one transaction.
   *
   * They are created together because neither is meaningful alone — an
   * organization with no members is a tenant nobody can reach, and an agent
   * with a dangling `organization_id` is the exact condition this table was
   * added to end. A crash between two separate inserts would leave one of
   * those two states behind permanently, so there is one statement pair and
   * one commit.
   *
   * Raises the unique violation on `privy_user_id` rather than swallowing it:
   * two concurrent first logins for the same DID is a real race, and the
   * caller's re-read is what resolves it. Swallowing it here would hide the
   * second organization that was rolled back.
   */
  async createWithOrganization(input: ProvisionAgentInput): Promise<AgentEntity> {
    return this.dataSource.transaction(async (manager) => {
      const organization = await manager.save(
        manager.create(OrganizationEntity, {
          name: input.organizationName,
          status: 'ACTIVE',
          createdVia: input.createdVia,
        }),
      );

      return manager.save(
        manager.create(AgentEntity, {
          organizationId: organization.id,
          privyUserId: input.privyUserId,
          email: input.email,
          label: input.label,
          status: 'ACTIVE',
          primaryAccountId: null,
          chainId: null,
          lastLoginAt: new Date(),
        }),
      );
    });
  }

  /** Best-effort login stamp. See `AgentEntity.lastLoginAt`. */
  async stampLogin(id: string, at: Date): Promise<void> {
    await this.update({ id }, { lastLoginAt: at });
  }

  /**
   * Records the wallet a Privy identity actually controls.
   *
   * Written once, when the account is first discovered, and never overwritten
   * with a different address by this path: `agent_account` is what a
   * withdrawal authorises against, so silently repointing it at another
   * address is the shape of an account-takeover, not a refresh. Changing it is
   * a deliberate, audited action that does not exist yet.
   */
  async linkPrimaryAccount(id: string, accountId: string, chainId: string): Promise<void> {
    await this.update({ id, primaryAccountId: IsNull() }, { primaryAccountId: accountId, chainId });
  }
}
