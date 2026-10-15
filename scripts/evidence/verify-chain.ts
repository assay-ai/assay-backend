/**
 * Walks one organization's evidence-pack chain and says where it breaks.
 *
 * ## Why a script exists when the read path already verifies
 *
 * `EvidencePackService` recomputes a pack's hash every time somebody reads it,
 * which catches a rewritten pack — but only the packs anybody reads. Two things
 * it cannot catch at all:
 *
 * - **A deleted pack.** The table refuses `DELETE`, but a restore from an older
 *   backup, or a superuser session, does not go through the table's opinion.
 *   A gap in `seq` is the only evidence left, and nothing reads `seq` ranges.
 * - **A quiet stretch.** Evidence is read when somebody disputes a charge. A
 *   chain could be broken for months and be discovered by the provider, in an
 *   argument, rather than by us.
 *
 * So this is the sweep a human runs — before an audit, after a restore, or on a
 * schedule if it ever earns one. It reports the FIRST break and exits non-zero,
 * because a chain that is broken at position 40 tells you nothing trustworthy
 * about position 41.
 *
 * Usage:
 *   yarn evidence:verify-chain --organization=<uuid>
 *   yarn evidence:verify-chain --all           (every organization, in turn)
 */
import { PostgresDataSource } from '../../src/database/postgres/postgres.data-source';
import type { EvidenceCore } from '../../src/modules/verification/domain/evidence/pack.types';

import { storedContentHash } from './lib/stored-core';

const BATCH = 1_000;

interface PackRow {
  readonly id: string;
  readonly verdict_id: string;
  readonly seq: string;
  readonly core: EvidenceCore;
  readonly content_hash: string;
  readonly prev_hash: string | null;
}

interface Break {
  readonly seq: number;
  readonly packId: string;
  readonly verdictId: string;
  readonly reason: string;
}

async function main(): Promise<void> {
  const organizationId = argument('organization');
  const all = process.argv.includes('--all');

  if (!organizationId && !all) {
    console.error('Usage: yarn evidence:verify-chain --organization=<uuid> | --all');
    process.exit(2);
  }

  await PostgresDataSource.initialize();

  try {
    const organizations = organizationId ? [organizationId] : await everyOrganization();
    let broken = 0;

    for (const organization of organizations) {
      const result = await verifyChain(organization);

      if (result.break) {
        broken += 1;
        console.error(
          `BROKEN  ${organization}  at seq ${result.break.seq} ` +
            `(pack ${result.break.packId}, verdict ${result.break.verdictId}): ${result.break.reason}`,
        );
      } else if (result.packs === 0) {
        console.log(`EMPTY   ${organization}  no packs`);
      } else {
        console.log(`OK      ${organization}  ${result.packs} packs, seq 1..${result.packs}`);
      }
    }

    process.exit(broken === 0 ? 0 : 1);
  } finally {
    await PostgresDataSource.destroy();
  }
}

/**
 * Reads the chain in `seq` order and checks three things per link: the hash
 * recomputes, the `prev_hash` matches the previous link, and `seq` did not skip.
 *
 * In batches, because a chain is one row per verdict and an organization that
 * has been running for a year has a lot of verdicts. Ordered by `seq` so the
 * batch boundary is a link like any other.
 */
async function verifyChain(
  organizationId: string,
): Promise<{ packs: number; break: Break | null }> {
  let after = 0;
  let packs = 0;
  let previousHash: string | null = null;

  for (;;) {
    const rows = (await PostgresDataSource.query(
      `SELECT "id", "verdict_id", "seq", "core", "content_hash", "prev_hash"
         FROM "evidence_packs"
        WHERE "organization_id" = $1 AND "seq" > $2
        ORDER BY "seq"
        LIMIT ${BATCH}`,
      [organizationId, after],
    )) as PackRow[];

    if (rows.length === 0) {
      return { packs, break: null };
    }

    for (const row of rows) {
      const seq = Number(row.seq);
      const contentHash = row.content_hash.trim();
      const prevHash = row.prev_hash === null ? null : row.prev_hash.trim();
      const failure = inspect(row, seq, contentHash, prevHash, packs + 1, previousHash);

      if (failure) {
        return {
          packs,
          break: { seq, packId: row.id, verdictId: row.verdict_id, reason: failure },
        };
      }

      packs += 1;
      previousHash = contentHash;
      after = seq;
    }
  }
}

function inspect(
  row: PackRow,
  seq: number,
  contentHash: string,
  prevHash: string | null,
  expectedSeq: number,
  previousHash: string | null,
): string | null {
  if (seq !== expectedSeq) {
    // A gap means a pack that existed is not here any more: the table refuses
    // DELETE, so this is a restore or a superuser, and it is the finding this
    // script exists for.
    return `expected seq ${expectedSeq}, found ${seq} — ${seq - expectedSeq} pack(s) missing`;
  }

  if (prevHash !== previousHash) {
    return previousHash === null
      ? `genesis must have no predecessor, found ${prevHash}`
      : `prev_hash ${prevHash ?? 'NULL'} does not match the previous pack's ${previousHash}`;
  }

  const recomputed = storedContentHash({ core: row.core, seq, prevHash });
  if (recomputed !== contentHash) {
    return `content hash ${contentHash} does not match the core (recomputed ${recomputed})`;
  }

  return null;
}

async function everyOrganization(): Promise<string[]> {
  const rows = (await PostgresDataSource.query(
    `SELECT DISTINCT "organization_id" FROM "evidence_packs" ORDER BY "organization_id"`,
  )) as Array<{ organization_id: string }>;
  return rows.map((row) => row.organization_id);
}

function argument(name: string): string | null {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
});
