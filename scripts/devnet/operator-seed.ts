/**
 * `yarn devnet:operator-seed` — provision the `operators` rows that the tokens
 * in `OPERATOR_CREDENTIALS_FILE` are supposed to authenticate as.
 *
 *     yarn devnet:operator-seed          # show what would be written
 *     yarn devnet:operator-seed --write  # write it
 *
 * ## Why a token alone is not enough
 *
 * `OPERATOR_CREDENTIALS_FILE` maps a bearer token to a **subject** and nothing
 * else. Every fact that decides what the subject may actually do — its roles
 * and its `authority_limit_minor` — lives in the `operators` table. On a fresh
 * database that table is empty, so a perfectly valid token authenticates as a
 * subject the deployment has never heard of and every operator route answers
 * `OPERATOR_CREDENTIAL_INVALID`.
 *
 * The suite's own error message spells out why that is indistinguishable from
 * a bad token, and deliberately so: "a token this deployment does not know and
 * a subject the table has never provisioned are deliberately indistinguishable
 * from here." Which is correct for an attacker and unhelpful for an operator,
 * hence this script.
 *
 * `devnet:acceptance` step 8a needs `ADJ` or `ADJL` with a limit at or above
 * the case's own value, so the limits below are generous rather than
 * realistic — this provisions a devnet database, not a production one.
 *
 * ## What it does not do
 *
 * It does not mint tokens and it never reads one: it takes the subjects out of
 * the credentials file and writes rows for them. Rotating a token changes
 * nothing here. Re-running is safe — a subject that already exists is left
 * exactly as it is, because raising a limit that an operator deliberately
 * lowered would be the wrong kind of idempotent.
 */
import { readFileSync } from 'node:fs';

import { OperatorRepository } from '@database/postgres/repositories/operator.repository';
import { OperatorRole } from '@modules/operator/domain/override-register';

import { bootIdentityContext } from './lib/acceptance-identity';

/** Role and ceiling implied by the subject's own name, which is how the file names them. */
const PROFILES: ReadonlyArray<{
  readonly match: RegExp;
  readonly roles: OperatorRole[];
  readonly authorityLimitMinor: string;
}> = [
  // Most specific first: `ops-adjl` also matches /adj/.
  { match: /adjl/i, roles: [OperatorRole.ADJL], authorityLimitMinor: '100000000000' },
  { match: /adj/i, roles: [OperatorRole.ADJ], authorityLimitMinor: '10000000000' },
  { match: /tre/i, roles: [OperatorRole.TRE], authorityLimitMinor: '100000000000' },
  { match: /sre/i, roles: [OperatorRole.SRE], authorityLimitMinor: '0' },
  { match: /pola/i, roles: [OperatorRole.POLA], authorityLimitMinor: '0' },
  { match: /pol/i, roles: [OperatorRole.POL], authorityLimitMinor: '0' },
];

function profileFor(subject: string): (typeof PROFILES)[number] | null {
  return PROFILES.find((p) => p.match.test(subject)) ?? null;
}

async function main(): Promise<void> {
  const write = process.argv.includes('--write');
  const path = process.env.OPERATOR_CREDENTIALS_FILE;
  if (!path) {
    console.error('OPERATOR_CREDENTIALS_FILE is not set');
    process.exit(1);
  }

  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const subjects = [
    ...new Set(
      Object.values(parsed as Record<string, { subject?: string }>)
        .map((v) => v?.subject)
        .filter((s): s is string => typeof s === 'string' && s.length > 0),
    ),
  ].sort();

  console.log(`${subjects.length} distinct subject(s) in ${path}\n`);

  const app = await bootIdentityContext();
  let failed = false;
  try {
    // `operators` belongs to no organization, so its repository extends
    // `AbstractRepository` and is resolved like any other provider.
    const operators = app.get(OperatorRepository);

    for (const subject of subjects) {
      const profile = profileFor(subject);
      if (!profile) {
        console.log(`  ${subject.padEnd(12)} SKIPPED — no role can be inferred from the name`);
        continue;
      }

      const existing = await operators.findOne({ where: { subject } });
      if (existing) {
        console.log(
          `  ${subject.padEnd(12)} exists — roles=${JSON.stringify(existing.roles)} ` +
            `limit=${existing.authorityLimitMinor} (left alone)`,
        );
        continue;
      }

      console.log(
        `  ${subject.padEnd(12)} ${write ? 'WRITING' : 'would write'} roles=${JSON.stringify(
          profile.roles,
        )} limit=${profile.authorityLimitMinor}`,
      );

      if (write) {
        await operators.save(
          operators.create({
            subject,
            displayName: `devnet ${subject}`,
            email: `${subject}@example.test`,
            roles: profile.roles,
            authorityLimitMinor: profile.authorityLimitMinor,
            status: 'ACTIVE',
          }),
        );
      }
    }

    console.log(
      write ? '\ndone.\n' : '\nnothing written — re-run with --write to apply the above.\n',
    );
  } catch (error) {
    failed = true;
    console.error('\noperator-seed failed:', error);
  } finally {
    await app.close().catch(() => undefined);
    // `RedisCacheModule` never closes its client; flush stdout before exiting
    // or a piped report is discarded with the work already done.
    await new Promise<void>((resolve) => process.stdout.write('', () => resolve()));
    process.exit(failed ? 1 : 0);
  }
}

void main().catch((error) => {
  console.error('operator-seed failed:', error);
  process.exit(1);
});
