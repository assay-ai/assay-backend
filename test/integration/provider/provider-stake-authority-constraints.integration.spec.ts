import { randomUUID } from 'node:crypto';

import {
  ProviderLedgerTestContext,
  createProviderLedgerTestContext,
} from '../helpers/provider-ledger-test-context';

/**
 * The three constraints that carry the stake-authority link, now on the
 * per-chain enrolment, exercised against a real Postgres.
 *
 * They used to live on `providers` (`uq_providers_stake_authority`,
 * `chk_providers_stake_authority_caip10`,
 * `chk_providers_stake_proved_together`). `1759300000003` dropped all three
 * with the columns, because a slash is executed by the settlement contract of
 * one chain and "whose collateral backs this provider" therefore has one answer
 * per chain. Their equivalents are on `provider_chain_enrolments`, and this file
 * follows them there.
 *
 * These exist because `yarn test` is jest-unit and never runs a migration: a
 * CHECK and a partial unique index are invisible to every suite in `test/unit`,
 * so without this file they would be asserted only by the comments that created
 * them. A constraint nothing has ever seen reject anything is indistinguishable
 * from a constraint that was written wrong — and these are the ones standing
 * between a provider and a stranger's collateral, so "probably fine" is not the
 * standard.
 *
 * Every write below is raw SQL rather than a repository call, deliberately. The
 * subject is the database's own refusal; going through TypeORM would let an
 * entity default or a mapping quietly satisfy a constraint the schema would
 * have rejected, and the test would then be measuring the ORM.
 */
describe('provider stake-authority constraints', () => {
  let context: ProviderLedgerTestContext;

  beforeAll(async () => {
    context = await createProviderLedgerTestContext();
  });

  afterAll(async () => {
    await context.close();
  });

  beforeEach(async () => {
    await context.reset();
  });

  const CHAIN = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
  const ACCOUNT = `${CHAIN}:7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU`;
  const PAYOUT = `${CHAIN}:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM`;

  /** A stored proof envelope — `PayoutProof`'s four fields, as `stake_proof` holds them. */
  function proof(): string {
    return JSON.stringify({
      challengeId: randomUUID(),
      signature: 'test-signature',
      messageVersion: 'x402-stake-authority/v1',
      provedAt: new Date().toISOString(),
    });
  }

  /**
   * Registers a provider and gives it an enrolment on {@link CHAIN}.
   *
   * The enrolment is created here rather than by the backfill because these
   * providers are written *after* the migrations ran. It carries the payout
   * trio and a null stake trio, which is the ordinary state: the row exists
   * before the stake, and staking fills in three columns on a row that already
   * existed.
   */
  async function provider(chainId = CHAIN): Promise<string> {
    const organizationId = randomUUID();
    await context.registerProvider({ organizationId });
    await context.dataSource.query(
      `INSERT INTO provider_chain_enrolments
         (organization_id, chain_id, payout_account_id, payout_proof, payout_proved_at,
          status, enrolled_at)
       VALUES ($1, $2, $3, $4, now(), 'ACTIVE', now())`,
      [organizationId, chainId, `${chainId}:${randomUUID().replace(/-/g, '')}`, proof()],
    );
    return organizationId;
  }

  /** Raw UPDATE of the stake trio. Any subset, so a partial write is expressible. */
  async function setStake(
    organizationId: string,
    values: { authority?: string | null; proof?: string | null; provedAt?: Date | null },
    chainId = CHAIN,
  ): Promise<void> {
    await context.dataSource.query(
      `UPDATE provider_chain_enrolments
          SET stake_authority_account_id = $3, stake_proof = $4, stake_proved_at = $5
        WHERE organization_id = $1 AND chain_id = $2`,
      [
        organizationId,
        chainId,
        values.authority ?? null,
        values.proof ?? null,
        values.provedAt ?? null,
      ],
    );
  }

  describe('chk_provider_chain_enrolments_stake_proved_together', () => {
    /**
     * The point: there is no column that can hold a stake authority which has
     * not been proved. Each of these six partial writes is a row that would
     * claim a key with no signature behind it, or a signature with no key
     * attached.
     */
    it.each([
      ['authority alone', { authority: ACCOUNT }],
      ['proof alone', { proof: proof() }],
      ['provedAt alone', { provedAt: new Date() }],
      ['authority + proof, no timestamp', { authority: ACCOUNT, proof: proof() }],
      ['authority + timestamp, no proof', { authority: ACCOUNT, provedAt: new Date() }],
      ['proof + timestamp, no authority', { proof: proof(), provedAt: new Date() }],
    ])('refuses a partial write: %s', async (_label, values) => {
      const organizationId = await provider();

      await expect(setStake(organizationId, values)).rejects.toThrow(
        /chk_provider_chain_enrolments_stake_proved_together/,
      );
    });

    it('accepts all three together, and accepts all three null (the unfunded majority)', async () => {
      const organizationId = await provider();

      await expect(
        setStake(organizationId, { authority: ACCOUNT, proof: proof(), provedAt: new Date() }),
      ).resolves.toBeUndefined();

      await expect(setStake(organizationId, {})).resolves.toBeUndefined();
    });
  });

  describe('uq_provider_chain_enrolments_stake_authority', () => {
    it('refuses a second provider claiming an already-claimed authority', async () => {
      const first = await provider();
      const second = await provider();

      await setStake(first, { authority: ACCOUNT, proof: proof(), provedAt: new Date() });

      await expect(
        setStake(second, { authority: ACCOUNT, proof: proof(), provedAt: new Date() }),
      ).rejects.toThrow(/uq_provider_chain_enrolments_stake_authority/);
    });

    /**
     * The index is partial for exactly this reason: an enrolment exists before
     * the stake does — declaring a chain and funding it are two acts with two
     * signatures — so a null here is the ordinary state and a plain unique
     * index would let only one such enrolment exist on the whole platform.
     */
    it('lets any number of enrolments hold no stake authority at all', async () => {
      const first = await provider();
      const second = await provider();
      const third = await provider();

      await expect(setStake(first, {})).resolves.toBeUndefined();
      await expect(setStake(second, {})).resolves.toBeUndefined();
      await expect(setStake(third, {})).resolves.toBeUndefined();
    });

    it('does not stop a provider re-proving the authority it already holds', async () => {
      const organizationId = await provider();

      await setStake(organizationId, { authority: ACCOUNT, proof: proof(), provedAt: new Date() });
      await expect(
        setStake(organizationId, { authority: ACCOUNT, proof: proof(), provedAt: new Date() }),
      ).resolves.toBeUndefined();
    });
  });

  describe('chk_provider_chain_enrolments_stake_caip10', () => {
    /**
     * The debt the unique index alone left open. A bare pubkey and its CAIP-10
     * form name one account, and a unique index over a string does not know
     * that — so without this CHECK both rows insert, both clear the router's
     * stake gate, and one pool of capital backs two providers.
     */
    it('refuses a bare base58 pubkey — the spelling that would have slipped past the unique index', async () => {
      const first = await provider();
      const second = await provider();

      await setStake(first, { authority: ACCOUNT, proof: proof(), provedAt: new Date() });

      await expect(
        setStake(second, {
          authority: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
          proof: proof(),
          provedAt: new Date(),
        }),
      ).rejects.toThrow(/chk_provider_chain_enrolments_stake_caip10/);
    });

    it.each([
      ['no chain reference', 'solana:7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'],
      ['trailing whitespace', `${ACCOUNT} `],
      ['leading whitespace', ` ${ACCOUNT}`],
      ['empty string', ''],
      ['upper-case namespace', `SOLANA:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:7xKXtg2CW87d97TXJSDpb`],
    ])('refuses a malformed account id: %s', async (_label, authority) => {
      const organizationId = await provider();

      await expect(
        setStake(organizationId, { authority, proof: proof(), provedAt: new Date() }),
      ).rejects.toThrow(/chk_provider_chain_enrolments_stake_caip10/);
    });
  });

  /**
   * The constraint the single column could not express at all.
   *
   * A well-formed CAIP-10 account on the WRONG chain was previously invisible:
   * `chk_providers_stake_authority_caip10` only ever asked whether the string
   * was account-shaped, and one column had no chain of its own to compare it
   * against. Here the row names its chain, so a mainnet account filed under a
   * devnet enrolment is refused by the database — the first symptom of which
   * would otherwise be a slash attestation aimed at an account the settling
   * chain cannot see.
   */
  describe('chk_provider_chain_enrolments_stake_on_chain', () => {
    it('refuses a well-formed account that is on a different chain from the row', async () => {
      const organizationId = await provider();

      await expect(
        setStake(organizationId, {
          authority: 'eip155:1:0x1234567890abcdef1234567890abcdef12345678',
          proof: proof(),
          provedAt: new Date(),
        }),
      ).rejects.toThrow(/chk_provider_chain_enrolments_stake_on_chain/);
    });

    it('accepts a non-Solana account on a non-Solana enrolment — the grammar is not chain-specific', async () => {
      const organizationId = await provider('eip155:1');

      await expect(
        setStake(
          organizationId,
          {
            authority: 'eip155:1:0x1234567890abcdef1234567890abcdef12345678',
            proof: proof(),
            provedAt: new Date(),
          },
          'eip155:1',
        ),
      ).resolves.toBeUndefined();
    });
  });

  /**
   * The cutover gate, re-aimed at the enrolment.
   *
   * `PROVIDER_STAKE_SOURCE_MODE` may go from `chain_with_config_fallback` to
   * `chain` only once this report is empty. Every row it returns is a provider
   * the chain cannot be asked about **on any chain** — no stake authority
   * anywhere, so no PDA — who would therefore drop to `STAKE_UNKNOWN` and out
   * of paid routing the moment the config fallback is removed. A promotion
   * criterion nobody can evaluate is not a criterion, and this is the query
   * that evaluates it.
   *
   * It is tested here rather than in `test/unit` for the same reason the
   * constraints above are: the subject is SQL against a real schema. A stubbed
   * query builder would assert that the method calls `andWhere`, which is a
   * restatement of the implementation and would not have caught the one bug
   * that matters — a predicate on the wrong column, or a `NOT EXISTS` whose
   * correlation is missing.
   */
  describe('findProvidersWithoutStakeAuthority', () => {
    it('returns exactly the providers with no proved stake authority, oldest first', async () => {
      const unproved = await provider();
      const proved = await provider();
      const alsoUnproved = await provider();

      await setStake(proved, { authority: ACCOUNT, proof: proof(), provedAt: new Date() });

      const gap = await context.providers.findProvidersWithoutStakeAuthority();

      // Cross-organization by design — the caller is an operator deciding one
      // thing about the whole deployment, not a tenant asking about itself.
      expect(gap.map((row) => row.organizationId)).toEqual([unproved, alsoUnproved]);
    });

    it('excludes a provider proved on ONE chain of two — they are answerable somewhere', async () => {
      // The list is about a provider the chain source cannot answer for at
      // all. Per-chain readiness is a different question, and reporting a
      // half-enrolled provider here would make the promotion criterion
      // unreachable the moment a second chain is offered.
      const organizationId = await provider();
      await context.dataSource.query(
        `INSERT INTO provider_chain_enrolments
           (organization_id, chain_id, payout_account_id, payout_proof, payout_proved_at,
            status, enrolled_at)
         VALUES ($1, 'eip155:1', 'eip155:1:0xabcdefabcdefabcdefabcdefabcdefabcdefabcd', $2,
                 now(), 'ACTIVE', now())`,
        [organizationId, proof()],
      );

      await setStake(organizationId, { authority: ACCOUNT, proof: proof(), provedAt: new Date() });

      await expect(context.providers.findProvidersWithoutStakeAuthority()).resolves.toEqual([]);
    });

    it('is empty once every provider has proved one — which is what unblocks mode=chain', async () => {
      const first = await provider();
      const second = await provider();

      await setStake(first, { authority: ACCOUNT, proof: proof(), provedAt: new Date() });
      await setStake(second, {
        // A different authority: `uq_provider_chain_enrolments_stake_authority`
        // refuses two providers on one stake account, and an empty report built
        // by violating that constraint would be a lie.
        authority: PAYOUT,
        proof: proof(),
        provedAt: new Date(),
      });

      await expect(context.providers.findProvidersWithoutStakeAuthority()).resolves.toEqual([]);
    });
  });
});
