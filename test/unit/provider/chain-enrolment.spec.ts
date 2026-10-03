import { Logger } from '@nestjs/common';

import { CHAIN_IDS, ChainId } from '@modules/chains/ports/caip.types';
import { ChainEnrolmentStatus, enrolmentKey } from '@modules/provider/ports/chain-enrolment.port';
import {
  DbChainEnrolmentSource,
  UnreadableEnrolmentReason,
} from '@modules/provider/services/db-chain-enrolment.source';
import { Alert, AlertPort } from '@shared/alerting';

/**
 * Records what the source pages about. A silent drop is the failure this port
 * is most exposed to (a provider leaves the market and nothing says so), so the
 * alerts are asserted rather than swallowed.
 */
class RecordingAlertPort implements AlertPort {
  readonly emitted: Alert[] = [];

  async emit(alert: Alert): Promise<void> {
    this.emitted.push(alert);
  }
}

const DEVNET = CHAIN_IDS.SOLANA_DEVNET;
const MAINNET = CHAIN_IDS.SOLANA_MAINNET;
const PROVIDER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

const row = (organizationId: string, chainId: ChainId, over: Record<string, unknown> = {}) => ({
  organizationId,
  chainId,
  payoutAccountId: `${chainId}:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM`,
  stakeAuthorityAccountId: null,
  status: ChainEnrolmentStatus.ACTIVE,
  enrolledAt: new Date('2026-09-07T00:00:00Z'),
  ...over,
});

/**
 * `provider_chain_enrolments` — the per-chain money, off the identity.
 *
 * The `providers` row keeps what is a fact about BEHAVIOUR: tier, stats, SLA
 * windows, strikes, disputes, the verification profile. This table keeps what
 * is a fact about MONEY ON A CHAIN. The identity deliberately
 * does not fork even though the collateral does — a provider slashed on one
 * chain must not enrol on the other with a clean record.
 */
describe('DbChainEnrolmentSource', () => {
  // `alerts` is the second constructor argument — see the file's `AlertPort`
  // block below.
  const build = (rows: ReturnType<typeof row>[], alerts: AlertPort = new RecordingAlertPort()) =>
    new DbChainEnrolmentSource(
      {
        // The repository seam, narrowed to the one method the source calls.
        findByProviders: async (ids: readonly string[]) =>
          rows.filter((r) => ids.includes(r.organizationId)),
      } as never,
      alerts,
    );

  it('keys enrolments by (providerId, chainId)', async () => {
    const source = build([row(PROVIDER, DEVNET), row(PROVIDER, MAINNET)]);

    const found = await source.enrolmentsOf([PROVIDER]);

    expect([...found.keys()].sort()).toEqual(
      [enrolmentKey(PROVIDER, DEVNET), enrolmentKey(PROVIDER, MAINNET)].sort(),
    );
    expect(found.get(enrolmentKey(PROVIDER, DEVNET))?.chainId).toBe(DEVNET);
  });

  it('one provider, two chains — the two rows are independent', async () => {
    // The independence principle, at the row level: suspending one
    // enrolment says nothing about the other.
    const source = build([
      row(PROVIDER, DEVNET, { status: ChainEnrolmentStatus.SUSPENDED }),
      row(PROVIDER, MAINNET),
    ]);

    const found = await source.enrolmentsOf([PROVIDER]);

    expect(found.get(enrolmentKey(PROVIDER, DEVNET))?.status).toBe(ChainEnrolmentStatus.SUSPENDED);
    expect(found.get(enrolmentKey(PROVIDER, MAINNET))?.status).toBe(ChainEnrolmentStatus.ACTIVE);
  });

  it('returns an empty map when the repository answers with no rows — never a default row', async () => {
    // Fails CLOSED. A synthesised "ACTIVE on the deployment's chain" default
    // would make an unenrolled provider routable, which is the one thing this
    // table exists to prevent.
    //
    // Not named "for a provider with no enrolments": the fake's
    // own filter is what removes OTHER's row here, so what this exercises is
    // the source's behaviour when the repository comes back EMPTY. That the
    // repository itself returns only the providers asked for is a different
    // claim, proved against real SQL in
    // `test/integration/provider/provider-chain-enrolment.integration.spec.ts`
    // ("returns only the providers asked for, across organizations") and by
    // `chain-enrolment.repository.spec.ts` in this suite.
    const source = build([row(OTHER, DEVNET)]);

    await expect(source.enrolmentsOf([PROVIDER])).resolves.toEqual(new Map());
  });

  it('does not query at all for an empty provider list', async () => {
    let called = 0;
    const source = new DbChainEnrolmentSource(
      {
        findByProviders: async () => {
          called += 1;
          return [];
        },
      } as never,
      new RecordingAlertPort(),
    );

    await source.enrolmentsOf([]);

    expect(called).toBe(0);
  });

  it('carries a null stake authority through rather than dropping the row', async () => {
    // Decision (a): the enrolment exists BEFORE stake. A source that filtered
    // out rows with no stake authority would make "enrolled but not yet funded"
    // unrepresentable, and the payout address would have nowhere to live.
    const source = build([row(PROVIDER, DEVNET, { stakeAuthorityAccountId: null })]);

    const enrolment = (await source.enrolmentsOf([PROVIDER])).get(enrolmentKey(PROVIDER, DEVNET));

    expect(enrolment).toBeDefined();
    expect(enrolment?.stakeAuthorityAccountId).toBeNull();
    expect(enrolment?.payoutAccountId).toContain(DEVNET);
  });
});

/**
 * The holes the five tests above leave open, closed here.
 *
 * Each `it` below was written by first constructing the degenerate
 * implementation that passes the block above and then pinning the thing it got
 * wrong. Two of them mattered: an `enrolmentKey` that returns the chain id
 * alone passes all five of those tests, because every one of them puts
 * `enrolmentKey` on both sides of its own assertion and none of them has two
 * providers in it; and a mapping that never copies `providerId` or
 * `enrolledAt` passes all five, because no assertion reads either field.
 */
describe('DbChainEnrolmentSource — what the five tests above do not pin', () => {
  const build = (
    rows: ReturnType<typeof row>[],
    seen?: string[][],
    alerts: AlertPort = new RecordingAlertPort(),
  ) =>
    new DbChainEnrolmentSource(
      {
        findByProviders: async (ids: readonly string[]) => {
          seen?.push([...ids]);
          return rows.filter((r) => ids.includes(r.organizationId));
        },
      } as never,
      alerts,
    );

  it('names BOTH halves in the key — the chain alone is not a key', () => {
    // Pinned as a literal, not as `enrolmentKey(...)` compared with itself.
    expect(enrolmentKey(PROVIDER, DEVNET)).toBe(`${PROVIDER}|${DEVNET}`);
    expect(enrolmentKey(PROVIDER, DEVNET)).not.toBe(String(DEVNET));
    expect(enrolmentKey(PROVIDER, DEVNET)).not.toBe(PROVIDER);
  });

  it('two providers on ONE chain do not collide — the likelier collision of the two', async () => {
    // The router asks about many providers at once and usually about a single
    // chain, so keying on the chain would drop every candidate but the last.
    const source = build([row(PROVIDER, DEVNET), row(OTHER, DEVNET)]);

    const found = await source.enrolmentsOf([PROVIDER, OTHER]);

    expect(found.size).toBe(2);
    expect(found.get(enrolmentKey(PROVIDER, DEVNET))?.providerId).toBe(PROVIDER);
    expect(found.get(enrolmentKey(OTHER, DEVNET))?.providerId).toBe(OTHER);
  });

  it('carries every field of the row, not just the ones the map is keyed on', async () => {
    const stake = `${DEVNET}:D9D6eF7LdSTf5PjDFpc2L6mUk1yVBoHFxk1xgbFAb1Bt`;
    const source = build([
      row(PROVIDER, DEVNET, {
        payoutAccountId: `${DEVNET}:85nsFusdnvbdcCyYsVLRa6v8iFMWG9oreN9htgHyuLuT`,
        stakeAuthorityAccountId: stake,
        status: ChainEnrolmentStatus.UNBONDING,
        enrolledAt: new Date('2026-01-02T03:04:05Z'),
      }),
    ]);

    const found = await source.enrolmentsOf([PROVIDER]);

    expect(found.get(enrolmentKey(PROVIDER, DEVNET))).toEqual({
      providerId: PROVIDER,
      chainId: DEVNET,
      payoutAccountId: `${DEVNET}:85nsFusdnvbdcCyYsVLRa6v8iFMWG9oreN9htgHyuLuT`,
      stakeAuthorityAccountId: stake,
      status: ChainEnrolmentStatus.UNBONDING,
      enrolledAt: new Date('2026-01-02T03:04:05Z'),
    });
  });

  it('asks the repository for each provider once, however often the caller names them', async () => {
    const seen: string[][] = [];
    const source = build([row(PROVIDER, DEVNET)], seen);

    await source.enrolmentsOf([PROVIDER, PROVIDER, OTHER, PROVIDER]);

    expect(seen).toEqual([[PROVIDER, OTHER]]);
  });

  describe('a row the schema should never have produced', () => {
    // Three CHECK constraints make each of these unreachable through the
    // migration's own schema. They are pinned anyway because the alternative in
    // the source was a cast, and a cast is a claim about the schema rather than
    // a fact about the value — see `toEnrolment`. Each drop is FAIL-CLOSED:
    // an absent enrolment stops traffic, a defaulted `ACTIVE` would start it.
    beforeEach(() => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it.each([
      ['an unknown status', { status: 'APPROVED' }],
      ['a chain id that is not CAIP-2', { chainId: 'solana' }],
      ['a payout address that is not CAIP-10', { payoutAccountId: '85nsFusdnvbdcCyYsVL' }],
      ['a stake authority that is not CAIP-10', { stakeAuthorityAccountId: 'not-an-account' }],
    ])('drops a row with %s rather than defaulting it', async (_label, over) => {
      const source = build([row(PROVIDER, DEVNET, over)]);

      await expect(source.enrolmentsOf([PROVIDER])).resolves.toEqual(new Map());
    });

    it('drops only the bad row, and keeps the provider’s other chain', async () => {
      const source = build([row(PROVIDER, DEVNET, { status: 'APPROVED' }), row(PROVIDER, MAINNET)]);

      const found = await source.enrolmentsOf([PROVIDER]);

      expect([...found.keys()]).toEqual([enrolmentKey(PROVIDER, MAINNET)]);
    });
  });
});

/**
 * The CAIP **grammar**, as distinct from counting colons.
 *
 * `toEnrolment`'s docstring argues that a bare `as AccountId` cast would make
 * the branded types "a claim about the schema rather than a fact about the
 * value". Until this block, nothing backed that: a reviewer's degenerate source
 * that replaced every `isChainId`/`isAccountId` call with `split(':').length`
 * and produced every branded type by a cast passed **14/14 unit + 26/26
 * integration + 3572/3572 full suite**. Every string below has exactly the
 * right number of colons and is not a legal CAIP identifier, so a colon count
 * brands it and the grammar refuses it.
 */
describe('DbChainEnrolmentSource — the grammar, not the colon count', () => {
  const build = (rows: ReturnType<typeof row>[], alerts: AlertPort = new RecordingAlertPort()) =>
    new DbChainEnrolmentSource({ findByProviders: async () => rows } as never, alerts);

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** Two colon-separated parts, none of them a CAIP-2 chain id. */
  const BAD_CHAIN_IDS: readonly [string, string][] = [
    ['namespace too short', 'sl:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'],
    ['namespace upper-case', 'SOLANA:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'],
    ['empty reference', 'solana:'],
    ['reference past 32 chars', `solana:${'a'.repeat(33)}`],
    ['reference has a disallowed character', 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xq!'],
    ['leading space', ' solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'],
  ];

  /** Three colon-separated parts, none of them a CAIP-10 account id. */
  const BAD_ACCOUNT_IDS: readonly [string, string][] = [
    ['namespace too short', 's:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:9WzDXwBbmkg8ZTbNMqUxvQRAyrZ'],
    ['namespace upper-case', 'SOLANA:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:9WzDXwBbmkg8ZTbNMqUxvQRAyrZ'],
    ['empty address', 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:'],
    ['address past 128 chars', `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:${'a'.repeat(129)}`],
    ['reference past 32 chars', `solana:${'a'.repeat(33)}:9WzDXwBbmkg8ZTbNMqUxvQRAyrZ`],
    ['address has a disallowed character', 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:9WzD/XwBb'],
  ];

  it.each(BAD_CHAIN_IDS)(
    'drops a row whose chain_id has two parts and is not CAIP-2: %s',
    async (_label, chainId) => {
      expect(chainId.split(':')).toHaveLength(2); // the degenerate's whole test
      const source = build([
        row(PROVIDER, chainId as ChainId, { payoutAccountId: `${chainId}:9WzDXwBbmkg8ZTbN` }),
      ]);

      await expect(source.enrolmentsOf([PROVIDER])).resolves.toEqual(new Map());
    },
  );

  it.each(BAD_ACCOUNT_IDS)(
    'drops a row whose payout_account_id has three parts and is not CAIP-10: %s',
    async (_label, payoutAccountId) => {
      expect(payoutAccountId.split(':')).toHaveLength(3);
      const source = build([row(PROVIDER, DEVNET, { payoutAccountId })]);

      await expect(source.enrolmentsOf([PROVIDER])).resolves.toEqual(new Map());
    },
  );

  it.each(BAD_ACCOUNT_IDS)(
    'drops a row whose stake_authority_account_id has three parts and is not CAIP-10: %s',
    async (_label, stakeAuthorityAccountId) => {
      expect(stakeAuthorityAccountId.split(':')).toHaveLength(3);
      const source = build([row(PROVIDER, DEVNET, { stakeAuthorityAccountId })]);

      await expect(source.enrolmentsOf([PROVIDER])).resolves.toEqual(new Map());
    },
  );

  it('still accepts the legal forms these are perturbations of', async () => {
    // A refusal test that refuses everything proves nothing. `eip155:8453` is
    // here because the grammar is not Solana-specific and must not become so.
    const source = build([
      row(PROVIDER, DEVNET),
      row(OTHER, CHAIN_IDS.BASE_MAINNET, {
        payoutAccountId: `${CHAIN_IDS.BASE_MAINNET}:0x1234567890abcdef1234567890abcdef12345678`,
        stakeAuthorityAccountId: `${CHAIN_IDS.BASE_MAINNET}:0xabcdefabcdefabcdefabcdefabcdefabcdefabcd`,
      }),
    ]);

    const found = await source.enrolmentsOf([PROVIDER, OTHER]);

    expect(found.size).toBe(2);
  });
});

/**
 * The drop is fail-closed, and it must not be silent.
 *
 * A widened status vocabulary removes every provider carrying the new word from
 * the market: to the router an absent enrolment is "not enrolled on this
 * chain", so they stop being routed and stop earning. `logger.error` is the
 * wrong channel for that — it is one line per row on the hot path, emitted
 * exactly when a deployment is mid-drift and nobody is reading logs.
 */
describe('DbChainEnrolmentSource — the drop pages, it does not only log', () => {
  const build = (rows: ReturnType<typeof row>[], alerts: AlertPort) =>
    new DbChainEnrolmentSource({ findByProviders: async () => rows } as never, alerts);

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('raises a CRITICAL alert naming the reason, the providers and the chains', async () => {
    const alerts = new RecordingAlertPort();
    const source = build([row(PROVIDER, DEVNET, { status: 'APPROVED' })], alerts);

    await source.enrolmentsOf([PROVIDER]);

    expect(alerts.emitted).toHaveLength(1);
    const [alert] = alerts.emitted;
    expect(alert.severity).toBe('CRITICAL');
    expect(alert.name).toBe('chain_enrolment_unreadable');
    expect(alert.details.reason).toBe(UnreadableEnrolmentReason.UNKNOWN_STATUS);
    expect(alert.details.rows).toBe(1);
    expect(alert.details.providers).toBe(PROVIDER);
    expect(alert.details.chains).toBe(DEVNET);
    // ONCE_PER_INCIDENT, keyed on the reason: the condition is a schema state
    // that stays true on every routing decision until somebody deploys.
    expect(alert.aggregation).toBe('ONCE_PER_INCIDENT');
    expect(alert.dedupeKey).toBe(UnreadableEnrolmentReason.UNKNOWN_STATUS);
  });

  it('raises ONE alert per reason, not one per row', async () => {
    const alerts = new RecordingAlertPort();
    const source = build(
      [
        row(PROVIDER, DEVNET, { status: 'APPROVED' }),
        row(OTHER, DEVNET, { status: 'PENDING' }),
        row(OTHER, MAINNET, { stakeAuthorityAccountId: 'not-an-account' }),
      ],
      alerts,
    );

    await source.enrolmentsOf([PROVIDER, OTHER]);

    expect(alerts.emitted.map((a) => a.details.reason).sort()).toEqual([
      UnreadableEnrolmentReason.MALFORMED_STAKE_AUTHORITY,
      UnreadableEnrolmentReason.UNKNOWN_STATUS,
    ]);
    const unknownStatus = alerts.emitted.find(
      (a) => a.details.reason === UnreadableEnrolmentReason.UNKNOWN_STATUS,
    );
    expect(unknownStatus?.details.rows).toBe(2);
    expect(String(unknownStatus?.details.providers).split(',').sort()).toEqual(
      [PROVIDER, OTHER].sort(),
    );
  });

  it('stays silent when every row reads cleanly — an alert nobody can ignore has to be rare', async () => {
    const alerts = new RecordingAlertPort();
    const source = build([row(PROVIDER, DEVNET), row(OTHER, MAINNET)], alerts);

    await source.enrolmentsOf([PROVIDER, OTHER]);

    expect(alerts.emitted).toEqual([]);
  });

  it('does not swallow the readable rows around a dropped one', async () => {
    const alerts = new RecordingAlertPort();
    const source = build(
      [row(PROVIDER, DEVNET, { status: 'APPROVED' }), row(PROVIDER, MAINNET)],
      alerts,
    );

    const found = await source.enrolmentsOf([PROVIDER]);

    expect([...found.keys()]).toEqual([enrolmentKey(PROVIDER, MAINNET)]);
    expect(alerts.emitted).toHaveLength(1);
  });
});
