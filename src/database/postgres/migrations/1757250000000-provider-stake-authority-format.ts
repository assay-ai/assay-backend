import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The format constraint that makes `uq_providers_stake_authority`
 * mean what its own migration says it means.
 *
 * ## What the unique index did and did not guarantee
 *
 * `1757000000000-provider-stake-authority` created a partial unique index over
 * `stake_authority` and described it as the thing that stops two providers
 * sharing one stake account. That description was one constraint short. A
 * unique index over a free-form `varchar` blocks **byte-identical** duplicates
 * and nothing else, and there was no format CHECK on the column, so two
 * spellings of one account both inserted cleanly and never collided:
 *
 * | Row A | Row B | Collide? |
 * |---|---|---|
 * | `solana:5eykt…:7xKXtg…` | `7xKXtg…` (bare base58, no CAIP prefix) | no |
 * | `solana:5eykt…:7xKXtg…` | `solana:5eykt…:7xKXtg… ` (trailing space) | no |
 *
 * Both rows then clear the router's stake gate on one pool of capital, which
 * is the precise outcome the index was added to deny.
 *
 * ## The two halves of the fix
 *
 * **Canonicalisation** happens in code, at the single point where a
 * caller-supplied address enters: `ProviderStakeAuthorityService.issueChallenge`
 * puts every address through `ChainAdapter.toAccountId`, which validates it on
 * the named chain and returns the canonical CAIP-10 form, and `prove` writes
 * that stored value rather than anything from the request. That is what makes
 * the column canonical today.
 *
 * **This CHECK** is what stops it depending on that. "We only ever write
 * through one service" is a property of the code as it stands, not of the
 * table; a backfill script, a support fix or a second write path added in two
 * years is not bound by it. The grammar below is, and it rules out the row
 * that actually breaks the index — a bare pubkey with no chain on it.
 *
 * ## The grammar
 *
 * CAIP-10, exactly: `namespace:reference:account_address`, with the
 * specification's own character classes and widths. Deliberately not a
 * Solana-shaped check (base58, 32–44 characters): this column holds whatever
 * chain a provider stakes on, and a constraint that has to be relaxed the day
 * a second adapter ships is a constraint that gets dropped rather than
 * widened. It is also why this is a grammar check and not a canonicality
 * check: SQL can see that `solana:5eykt…:7xKXtg…` is well-formed, but it
 * cannot know that some other spelling of the same chain reference names the
 * same chain. That residual gap is closed by `toAccountId` and only by it —
 * which is now a documented division of labour rather than an unnoticed one.
 *
 * ## Why `payout_account_id` does not get the same CHECK here
 *
 * It has the same gap, and it is the payout-proof column with live rows behind
 * it. Adding a CHECK to a populated column is a data question — what happens to
 * a row that fails — and answering it belongs in a change that is about
 * payouts, not in a stake-authority change. Recorded rather than silently
 * skipped; the difference in blast radius is real, though: a mis-spelt payout
 * address loses that provider's own money, while a mis-spelt stake authority
 * names a stranger's collateral as the thing to slash.
 */
export class ProviderStakeAuthorityFormat1757250000000 implements MigrationInterface {
  name = 'ProviderStakeAuthorityFormat1757250000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // No `IS NULL OR …` guard: a CHECK whose expression evaluates to NULL
    // passes, and `NULL ~ '…'` is NULL, so the unproved majority is already
    // exempt. Spelling the guard anyway would suggest the three-valued logic
    // was in doubt.
    await queryRunner.query(`
      ALTER TABLE "providers" ADD CONSTRAINT "chk_providers_stake_authority_caip10" CHECK (
        "stake_authority" ~ '^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}:[-.%a-zA-Z0-9]{1,128}$'
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "providers" DROP CONSTRAINT IF EXISTS "chk_providers_stake_authority_caip10"`,
    );
  }
}
