import { Column, Entity, Index } from 'typeorm';

import { OrganizationScopedEntityWithoutSoftDelete } from './organization-scoped.entity';

/**
 * One probe of a provider's declared endpoint, kept.
 *
 * ## Why it is a table and not a return value
 *
 * The check's immediate job is to put a result on the screen, which needs no
 * storage at all. What needs storage is the argument afterwards. A provider
 * whose traffic later fails will say the endpoint was reachable; a row saying
 * *when* we dialled it, *what* answered, and — critically — **which egress
 * addresses we published at the time** turns that into a fact. `egress_ips` is
 * denormalised onto every row for exactly that reason: the allowlist they were
 * told to add is the one that was current when they were told, and a later
 * change to the platform's addresses must not rewrite history.
 *
 * ## Blocked is a distinct outcome, not a failure
 *
 * `outcome = 'BLOCKED'` means the egress guard refused to dial: a private or
 * loopback address, a link-local or cloud-metadata target, or a scheme we do
 * not speak. Folding it into `UNREACHABLE` would tell a provider who typed
 * `http://localhost:3000` that we could not reach them, which is true and
 * useless. It is also the signal worth counting — a run of `BLOCKED` rows
 * pointing at `169.254.169.254` is somebody fishing for our IAM credentials,
 * not somebody mistyping.
 */
@Entity('provider_connectivity_checks')
@Index('idx_provider_connectivity_checks_org_created', ['organizationId', 'createdAt'])
export class ProviderConnectivityCheckEntity extends OrganizationScopedEntityWithoutSoftDelete {
  @Column({ name: 'endpoint', type: 'varchar', length: 2048 })
  endpoint: string;

  /** `REACHABLE` | `UNREACHABLE` | `BLOCKED` — `ConnectivityOutcome`. */
  @Column({ name: 'outcome', type: 'varchar', length: 16 })
  outcome: string;

  /**
   * Whatever answered, including `4xx` and `5xx`.
   *
   * A `401` is a pass: it proves DNS, TLS and a listening process, which is all
   * this check claims. Grading a provider's auth here would fail every
   * correctly-secured endpoint on the platform.
   */
  @Column({ name: 'status_code', type: 'int', nullable: true })
  statusCode: number | null;

  @Column({ name: 'latency_ms', type: 'int', nullable: true })
  latencyMs: number | null;

  /** `EgressFailureKind`, when the probe failed. */
  @Column({ name: 'failure_kind', type: 'varchar', length: 48, nullable: true })
  failureKind: string | null;

  /** The `EGRESS_*` code, when the probe failed. */
  @Column({ name: 'failure_code', type: 'varchar', length: 64, nullable: true })
  failureCode: string | null;

  @Column({ name: 'detail', type: 'varchar', length: 512, nullable: true })
  detail: string | null;

  /** The allowlist we published at the time of this check. See the class comment. */
  @Column({ name: 'egress_ips', type: 'jsonb', default: () => `'[]'::jsonb` })
  egressIps: string[];
}
