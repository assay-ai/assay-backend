import {
  BindingEditorTestContext,
  createBindingEditorTestContext,
} from '../helpers/binding-editor-test-context';

/**
 * The six constraints on `provider_stake_grace`, exercised
 * against a real Postgres.
 *
 * Same argument as `provider-stake-authority-constraints`, one task earlier:
 * `yarn test` is jest-unit and never runs a migration, so a CHECK is invisible
 * to every suite under `test/unit`. **A constraint nothing has ever seen reject
 * anything is indistinguishable from a constraint that was written wrong.**
 * These six were verified by hand during implementation; that proof lived in a
 * review transcript rather than in CI, which is the same as not having it.
 *
 * What they are protecting is narrow and specific. A grace row is the reason a
 * provider below their stake floor keeps serving paid traffic for seven days
 * (the provider is told *"Your traffic is still flowing."*). A row that says
 * the wrong thing therefore either keeps
 * an under-collateralised binding routing past its deadline, or cuts one that
 * should still be flowing. Neither is visible from the outside until money has
 * already moved.
 *
 * Every write below is raw SQL rather than a repository call, deliberately. The
 * subject is the database's own refusal; going through TypeORM would let an
 * entity default or a column mapping quietly satisfy a constraint the schema
 * would have rejected, and the test would then be measuring the ORM.
 */
describe('provider stake-grace constraints', () => {
  let context: BindingEditorTestContext;
  let bindingId: string;

  beforeAll(async () => {
    // The invoker is never used — no service in this file makes a call. It is
    // required only because the context builds the mapping tester eagerly.
    context = await createBindingEditorTestContext({
      invoke: () => {
        throw new Error('no binding is invoked by a constraint test');
      },
    } as never);
  });

  afterAll(async () => {
    await context.close();
  });

  beforeEach(async () => {
    await context.reset();
    bindingId = await insertBinding();
  });

  const ASSET =
    'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

  /**
   * A `tool_bindings` row for the FK to point at.
   *
   * Raw SQL like everything else here: the binding is scaffolding, and routing
   * it through `BindingEditorService` would couple this file to that service's
   * validation rules for no gain.
   */
  async function insertBinding(): Promise<string> {
    const [row] = await context.dataSource.query(
      // `settlement_chains` is named explicitly: the column is
      // NOT NULL with no DEFAULT, so an INSERT that omits it is refused — and
      // the array literal is the chain `ASSET` names, written out rather than
      // derived so this scaffolding row says what it is.
      `INSERT INTO tool_bindings
         (organization_id, tool_id, endpoint, request_mapping, response_mapping,
          pricing_mode, price_amount, asset_id, settlement_chains,
          sla_failure_rate, timeout_ms)
       VALUES ($1, 'search_web', 'https://example.test/search', '{}'::jsonb, '{}'::jsonb,
          'PAID', '1000', $2, ARRAY['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'],
          0.01, 5000)
       RETURNING id`,
      [context.organizationId, ASSET],
    );
    return row.id as string;
  }

  /** One grace row, with every field overridable so a test can break exactly one. */
  function grace(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const started = new Date('2026-08-01T00:00:00.000Z');
    return {
      organization_id: context.organizationId,
      binding_id: bindingId,
      started_at: started,
      expires_at: new Date(started.getTime() + 7 * 24 * 60 * 60 * 1000),
      required_amount: '50000000',
      observed_amount: '10000000',
      resolved_at: null,
      resolution: null,
      asset_id: ASSET,
      ...overrides,
    };
  }

  async function insertGrace(overrides: Record<string, unknown> = {}): Promise<void> {
    const row = grace(overrides);
    const columns = Object.keys(row);
    const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
    await context.dataSource.query(
      `INSERT INTO provider_stake_grace (${columns.map((c) => `"${c}"`).join(', ')})
       VALUES (${placeholders})`,
      Object.values(row),
    );
  }

  // ── The amounts ──────────────────────────────────────────────────────────

  it('refuses a negative required amount', async () => {
    await expect(insertGrace({ required_amount: '-5' })).rejects.toThrow(
      /chk_provider_stake_grace_amounts_non_negative/,
    );
  });

  it('refuses a negative observed amount', async () => {
    await expect(insertGrace({ observed_amount: '-5' })).rejects.toThrow(
      /chk_provider_stake_grace_amounts_non_negative/,
    );
  });

  it('refuses a row where the provider is not actually short', async () => {
    await expect(insertGrace({ observed_amount: '60000000' })).rejects.toThrow(
      /chk_provider_stake_grace_is_a_shortfall/,
    );
  });

  it('refuses a row where observed EQUALS required', async () => {
    // The boundary that proves the CHECK is strict `<` rather than `<=`. The
    // gate passes on `stake >= minimum`, so a provider sitting exactly on their
    // floor is ABOVE it and has nothing to be given grace for. A `<=` here
    // would open a seven-day countdown against a provider who is compliant.
    await expect(insertGrace({ observed_amount: '50000000' })).rejects.toThrow(
      /chk_provider_stake_grace_is_a_shortfall/,
    );
  });

  // ── The clock ────────────────────────────────────────────────────────────

  it('refuses a period that expires before it starts', async () => {
    await expect(insertGrace({ expires_at: new Date('2026-07-01T00:00:00.000Z') })).rejects.toThrow(
      /chk_provider_stake_grace_expires_after_start/,
    );
  });

  it('refuses a period that expires exactly when it starts', async () => {
    await expect(insertGrace({ expires_at: new Date('2026-08-01T00:00:00.000Z') })).rejects.toThrow(
      /chk_provider_stake_grace_expires_after_start/,
    );
  });

  it('refuses a resolution timestamped before the period began', async () => {
    await expect(
      insertGrace({
        resolved_at: new Date('2026-05-01T00:00:00.000Z'),
        resolution: 'CURED',
      }),
    ).rejects.toThrow(/chk_provider_stake_grace_resolved_after_start/);
  });

  it('ACCEPTS a resolution timestamped exactly at the start', async () => {
    // Inclusive on purpose, and asserted so nobody "tightens" it later: a
    // provider who tops up in the same instant the monitor opened the row has
    // cured it, and refusing that row would leave the grace period open with
    // nothing able to close it.
    await expect(
      insertGrace({
        resolved_at: new Date('2026-08-01T00:00:00.000Z'),
        resolution: 'CURED',
      }),
    ).resolves.toBeUndefined();
  });

  // ── The outcome ──────────────────────────────────────────────────────────

  it('refuses an outcome outside the vocabulary', async () => {
    await expect(
      insertGrace({ resolved_at: new Date('2026-08-03T00:00:00.000Z'), resolution: 'TOPPED_UP' }),
    ).rejects.toThrow(/chk_provider_stake_grace_resolution/);
  });

  it('refuses the right word in the wrong case', async () => {
    await expect(
      insertGrace({ resolved_at: new Date('2026-08-03T00:00:00.000Z'), resolution: 'cured' }),
    ).rejects.toThrow(/chk_provider_stake_grace_resolution/);
  });

  it('refuses a closed period that does not say how it ended', async () => {
    // This half is why the column exists. The original entity claimed the outcome
    // could be inferred — resolved at or after `expires_at` ran out, before it
    // was cured — and that inference breaks at the boundary in both directions:
    // a five-minute-tick job resolving a top-up thirty seconds after expiry
    // records a CURE as an EXPIRY.
    await expect(
      insertGrace({ resolved_at: new Date('2026-08-03T00:00:00.000Z'), resolution: null }),
    ).rejects.toThrow(/chk_provider_stake_grace_resolution_attributed/);
  });

  it('refuses an open period that already claims an outcome', async () => {
    await expect(insertGrace({ resolved_at: null, resolution: 'EXPIRED' })).rejects.toThrow(
      /chk_provider_stake_grace_resolution_attributed/,
    );
  });

  // ── The denomination ─────────────────────────────────────────────────────

  it('refuses a row with no asset', async () => {
    // Two amounts with no denomination is what the table shipped with, and
    // `evaluateStakeGate` treats an amount without an asset as unsafe enough to
    // have two separate `STAKE_ASSET_MISMATCH` rejection paths. The grace notice also has
    // to render "the exact amount needed", which needs `asset` + `decimals`.
    await expect(insertGrace({ asset_id: null })).rejects.toThrow(/asset_id/);
  });

  // ── One open period per binding ──────────────────────────────────────────

  it('refuses a second open period for the same binding', async () => {
    // The clock must not restart. Without this, a provider oscillating around
    // their floor opens a fresh seven days on every dip, which is grace forever.
    await insertGrace();
    await expect(insertGrace()).rejects.toThrow(/uq_provider_stake_grace_open/);
  });

  it('allows a new period once the previous one is resolved', async () => {
    await insertGrace();
    await context.dataSource.query(
      `UPDATE provider_stake_grace
          SET resolved_at = $1, resolution = 'CURED'
        WHERE binding_id = $2 AND resolved_at IS NULL`,
      [new Date('2026-08-03T00:00:00.000Z'), bindingId],
    );

    await expect(insertGrace()).resolves.toBeUndefined();
  });

  it('allows many RESOLVED periods for one binding', async () => {
    // The index is partial. A binding that has been in and out of grace three
    // times keeps all three rows, which is what the grace history reads.
    for (let index = 0; index < 3; index += 1) {
      await insertGrace();
      await context.dataSource.query(
        `UPDATE provider_stake_grace
            SET resolved_at = $1, resolution = 'CURED'
          WHERE binding_id = $2 AND resolved_at IS NULL`,
        [new Date('2026-08-03T00:00:00.000Z'), bindingId],
      );
    }

    const [{ count }] = await context.dataSource.query(
      `SELECT count(*)::int AS count FROM provider_stake_grace WHERE binding_id = $1`,
      [bindingId],
    );
    expect(count).toBe(3);
  });

  it('takes its rows with the binding when the binding goes', async () => {
    await insertGrace();
    await context.dataSource.query(`DELETE FROM tool_bindings WHERE id = $1`, [bindingId]);

    const [{ count }] = await context.dataSource.query(
      `SELECT count(*)::int AS count FROM provider_stake_grace WHERE binding_id = $1`,
      [bindingId],
    );
    expect(count).toBe(0);
  });
});
