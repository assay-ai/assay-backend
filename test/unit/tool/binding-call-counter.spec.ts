import type { Redis } from 'ioredis';

import { PaymentIntentRepository } from '@database/postgres/repositories/payment-intent.repository';
import {
  BINDING_CALL_COUNT_KEY_PREFIX,
  BindingCallCounterService,
} from '@modules/tool/services/binding-call-counter.service';

/**
 * The per-binding call count, off Redis and off `payment_intents`.
 *
 * The exploration floor is *"the first 1,000 calls of a binding"*, so the whole
 * feature rests on a number that has to survive a Redis flush, a deploy and a
 * cache eviction — none of which are rare, and all of which would otherwise
 * silently rewrite a provider's standing.
 *
 * Two properties are proved here and nowhere else:
 *
 * - **The table is the source of truth.** Redis is a counter in front of a
 *   `COUNT(*)`, not a ledger of its own, so a lost key is repaired from the
 *   rows that recorded the calls rather than restarted from zero.
 * - **Every way of being wrong runs in one direction.** An undercount makes a
 *   binding look *newer* than it is, which spends a little more of a hard-
 *   capped 20% exploration budget. An overcount makes it look *older*, which
 *   takes exploration traffic away from a binding that has not had its chance
 *   yet — a thing no later call can give back.
 *
 * A real Redis is not needed for either: both are statements about which
 * command runs against which key, which is exactly what a fake records.
 * `kill-switch.spec.ts` makes the same split for the same reason.
 */

/** A string store with the handful of commands the counter actually uses. */
class FakeRedis {
  readonly values = new Map<string, string>();
  /** Set to make every command reject, standing in for an unreachable Redis. */
  down = false;

  get(key: string): Promise<string | null> {
    if (this.down) return Promise.reject(new Error('redis is unreachable'));
    return Promise.resolve(this.values.get(key) ?? null);
  }

  exists(key: string): Promise<number> {
    if (this.down) return Promise.reject(new Error('redis is unreachable'));
    return Promise.resolve(this.values.has(key) ? 1 : 0);
  }

  incr(key: string): Promise<number> {
    if (this.down) return Promise.reject(new Error('redis is unreachable'));
    const next = Number(this.values.get(key) ?? '0') + 1;
    this.values.set(key, String(next));
    return Promise.resolve(next);
  }

  set(key: string, value: string, _ex: 'EX', _ttl: number, _nx: 'NX'): Promise<'OK' | null> {
    if (this.down) return Promise.reject(new Error('redis is unreachable'));
    // `NX`: the first writer wins and every later one is refused.
    if (this.values.has(key)) return Promise.resolve(null);
    this.values.set(key, value);
    return Promise.resolve('OK');
  }

  /** Everything Redis forgets on a flush, an eviction or a failover. */
  flush(): void {
    this.values.clear();
  }

  get keys(): string[] {
    return [...this.values.keys()];
  }
}

/** One `payment_intents` row, reduced to the two columns this count reads. */
interface IntentRow {
  readonly bindingId: string | null;
  readonly organizationId: string;
}

/**
 * `PaymentIntentRepository.countCallsByBinding` over an array.
 *
 * It counts by binding and **ignores `organizationId` entirely**, which is the
 * production query's defining property rather than a convenience here: the
 * buying organizations are the tenants on those rows, and a binding's calls
 * come from all of them.
 */
class FakeIntentRows {
  /** One entry per call, so a test can assert the table was consulted once. */
  readonly queries: string[] = [];
  /** Set to make the count reject, standing in for an unreachable Postgres. */
  down = false;

  constructor(private readonly rows: IntentRow[] = []) {}

  countCallsByBinding(bindingId: string): Promise<number> {
    this.queries.push(bindingId);
    if (this.down) return Promise.reject(new Error('postgres is unreachable'));
    return Promise.resolve(this.rows.filter((row) => row.bindingId === bindingId).length);
  }

  /** What the MCP loop's transition would have written, in the same order. */
  append(bindingId: string, organizationId: string): void {
    this.rows.push({ bindingId, organizationId });
  }
}

const BINDING = 'binding-provider-a';
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '33333333-3333-4333-8333-333333333333';

function build(rows: IntentRow[] = []) {
  const redis = new FakeRedis();
  const intents = new FakeIntentRows(rows);
  const counter = new BindingCallCounterService(
    redis as unknown as Redis,
    intents as unknown as PaymentIntentRepository,
  );

  return { redis, intents, counter };
}

describe('BindingCallCounterService', () => {
  it('hydrates from payment_intents on a cache miss', async () => {
    const { redis, intents, counter } = build([
      { bindingId: BINDING, organizationId: ORG_A },
      { bindingId: BINDING, organizationId: ORG_A },
      { bindingId: BINDING, organizationId: ORG_A },
      { bindingId: 'binding-provider-b', organizationId: ORG_A },
      { bindingId: null, organizationId: ORG_A },
    ]);

    expect(await counter.observedCalls(BINDING)).toBe(3);
    expect(intents.queries).toEqual([BINDING]);

    // And the hydrated value stays in Redis, so the count is a `COUNT(*)` once
    // rather than on every routing decision.
    expect(redis.values.get(`${BINDING_CALL_COUNT_KEY_PREFIX}${BINDING}`)).toBe('3');
    expect(await counter.observedCalls(BINDING)).toBe(3);
    expect(intents.queries).toEqual([BINDING]);
  });

  it('treats a lost Redis counter as newer-than-it-is, not older', async () => {
    // This binding has served seven calls in its life. Three of them predate
    // `binding_id` and sit in the table as `NULL` — deliberately never
    // backfilled — so nothing on the platform can attribute them to it.
    const TRUE_LIFETIME_CALLS = 7;
    const { redis, intents, counter } = build([
      { bindingId: null, organizationId: ORG_A },
      { bindingId: null, organizationId: ORG_A },
      { bindingId: null, organizationId: ORG_A },
      { bindingId: BINDING, organizationId: ORG_A },
      { bindingId: BINDING, organizationId: ORG_A },
    ]);

    // Two more calls. Each writes its row and *then* tells the counter, which
    // is the order the MCP loop does it in — and the reason hydration must not
    // also increment: the row it is counting is already in the table.
    intents.append(BINDING, ORG_B);
    await counter.record(BINDING);
    intents.append(BINDING, ORG_B);
    await counter.record(BINDING);

    const beforeTheFlush = await counter.observedCalls(BINDING);
    expect(beforeTheFlush).toBe(4);

    redis.flush();
    const recovered = await counter.observedCalls(BINDING);

    // Rebuilt from the rows rather than restarted from zero...
    expect(recovered).toBe(beforeTheFlush);
    // ...and still below the calls this binding really served, never above.
    // That is the direction the whole design is arranged around: an
    // undercount spends a little more of a capped exploration budget, an
    // overcount takes away a chance to earn one.
    expect(recovered as number).toBeLessThan(TRUE_LIFETIME_CALLS);
  });

  it("counts across calling organizations, not just the provider's own", async () => {
    const { redis, counter } = build([
      { bindingId: BINDING, organizationId: ORG_A },
      { bindingId: BINDING, organizationId: ORG_B },
      { bindingId: BINDING, organizationId: ORG_B },
    ]);

    expect(await counter.observedCalls(BINDING)).toBe(3);

    // One counter per binding — not one per (binding, tenant). A key carrying
    // an organization id would count each buyer's traffic separately and give
    // a popular binding an exploration allowance forever.
    expect(redis.keys).toEqual([`${BINDING_CALL_COUNT_KEY_PREFIX}${BINDING}`]);
  });

  it('falls back to the table when Redis cannot be read', async () => {
    const { redis, counter } = build([
      { bindingId: BINDING, organizationId: ORG_A },
      { bindingId: BINDING, organizationId: ORG_B },
    ]);

    redis.down = true;

    expect(await counter.observedCalls(BINDING)).toBe(2);
  });

  /**
   * `null`, not `0`. `RoutingCandidate.observedCalls` excludes `null` from the
   * exploration set, so an unreadable count withdraws the binding's floor
   * rather than handing it one — `0` is the *permissive* value here and would
   * make every binding on the platform look brand new the moment the count
   * stopped answering.
   */
  it('reports nothing rather than zero when neither store can answer', async () => {
    const { redis, intents, counter } = build();
    redis.down = true;
    intents.down = true;

    expect(await counter.observedCalls(BINDING)).toBeNull();
  });

  /**
   * The increment sits on the paid call path, immediately after a financial
   * transition has already committed. A counter that threw there would turn a
   * successful, already-recorded call into an error the agent sees.
   */
  it('never throws from record(), whatever the stores do', async () => {
    const { redis, intents, counter } = build();
    redis.down = true;
    intents.down = true;

    await expect(counter.record(BINDING)).resolves.toBeUndefined();
  });
});
