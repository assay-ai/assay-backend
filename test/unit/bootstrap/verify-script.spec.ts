import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * `yarn verify` is the only command that runs the integration suite.
 *
 * ## Why this file exists
 *
 * `yarn test` is jest-**unit** and nothing else. A reviewer's degenerate
 * `ProviderChainEnrolmentRepository` — a `findByProviders` that returned `[]`
 * and read nothing — passed `yarn lint`, `yarn build` and all 3572 unit tests,
 * and was caught only by `test/integration/`. That suite is where nine CHECK
 * constraints, both unique indexes, the entity's column names and the whole
 * `provider_chain_enrolments` backfill are proved; there is no other proof of
 * any of them, because a migration never runs in the unit suite.
 *
 * Until this repository has CI, that suite runs **when a human remembers**, and
 * this test cannot change that. What it can stop is the script quietly losing
 * the half that matters — a `verify` that ran only the unit config would look
 * like coverage and be none, which is exactly the failure this file is a
 * response to.
 *
 * Prerequisite for `yarn verify`: Postgres from `backend/docker-compose.yml`
 * must be up (`DATABASE_PORT` out of `backend/.env`).
 * The integration suite creates and migrates its own databases —
 * `app_provider_payout_test` and its siblings — and never touches `app`.
 */
describe('the verify script reaches the integration suite', () => {
  const scripts = (
    JSON.parse(readFileSync(join(__dirname, '../../../package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    }
  ).scripts;

  it('exists, so there is a single documented pre-merge command', () => {
    expect(scripts.verify).toBeTruthy();
  });

  it('runs the integration config, which no other script a developer types does', () => {
    // Chained through `test:integration` rather than spelled out, so the config
    // path lives in exactly one place.
    expect(scripts.verify).toContain('test:integration');
    expect(scripts['test:integration']).toContain('jest-integration.json');
  });

  it('also runs lint, build and the unit suite — verify is the whole gate, not a second one', () => {
    for (const part of ['lint', 'build', 'test']) {
      expect(scripts.verify).toContain(part);
    }
  });

  /**
   * The contexts create-if-absent and migrate-what-is-
   * pending; they never drop and never revert. That was harmless while every
   * migration was additive, and stopped being harmless at
   * `1759300000002-drop-provider-payout-columns`, the branch's first
   * `DROP COLUMN`: once a run has taken `app_binding_test` to that migration,
   * **every earlier commit is unrunnable on that machine** —
   * `column ProviderEntity.payout_account_id does not exist`, which names a
   * column and not a leftover database.
   *
   * So a reset has to exist, and it has to be findable by name rather than by
   * reading eleven context files for their database names. This pins that it
   * does; it cannot make anyone run it.
   */
  it('ships a reset for the shared integration databases, which are one-way after a DROP COLUMN', () => {
    expect(scripts['test:integration:reset']).toBeTruthy();
    expect(scripts['test:integration:reset']).toContain('reset-integration-databases');
  });
});
