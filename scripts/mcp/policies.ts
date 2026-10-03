/**
 * Seed the demo verification and decision policies.
 *
 * ```bash
 * yarn mcp:policies          # register → shadow → promote, then print the table
 * yarn mcp:policies show     # print what is stored, change nothing
 * ```
 *
 * ## Read this before believing the output
 *
 * The verification aggregator puts the promote gate in a CHECK constraint so that
 * no service, script or psql session could route around it — but the gate is
 * procedural rather than mechanical: **`evaluatePromotion`
 * does honest arithmetic over `shadowCalls`, `labelledSamples` and
 * `falsePositives`, and nothing in the system computes any of the three.** An
 * operator clears the gate by submitting numbers.
 *
 * This script submits numbers. It is that bypass, performed deliberately, in one
 * file, by a human typing a command — because without an `ACTIVE` policy every
 * receipt the platform renders would say *"no
 * verification policy is configured for this tool"*, and a demonstration of the
 * receipt would be a demonstration of the absence of one.
 *
 * Two things keep it honest rather than merely convenient:
 *
 * - the approver is the literal string {@link SEED_APPROVER}, so every row this
 *   creates is greppable in `promotion_evidence` and cannot be mistaken for a
 *   real review;
 * - the note records that the counts are fabricated and names what replaces
 *   them.
 *
 * Receipts and the receipt summary are what turn the gate's inputs from claims
 * into measurements:
 * `verification_records` is now a table, so shadow calls become countable and a
 * labelling tool has somewhere to write. Until a real gate exists, do not point
 * at a promoted policy as evidence that promotion is guarded — point at this
 * file.
 *
 * It is not registered in any module and no service calls it. One other script
 * imports it — `scripts/demo/seed-provider-console.ts` calls
 * {@link seedDecisionPolicy} so the demo's verdicts are judged by these
 * policies rather than by a second copy of them.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { NestFactory } from '@nestjs/core';

import {
  DecisionPolicy,
  PolicyLifecycle,
} from '@modules/verification/domain/aggregation/decision-policy.types';
import { VerificationPolicy } from '@modules/verification/domain/policy.types';
import { DecisionPolicyService } from '@modules/verification/services/decision-policy.service';

import { AppMcpModule } from '../../src/bootstrap/mcp/app.module';

/**
 * The approver recorded on every row this script promotes.
 *
 * A string, not a person. `PROMOTION_GATE` requires an approver who is not the
 * requester — the four-eyes rule that is currently the only thing standing
 * between a self-submitted number and production — and a seed cannot satisfy
 * that rule, only satisfy its shape. Naming the shape is the point: a query for
 * this value returns exactly the set of policies nobody reviewed.
 */
const SEED_APPROVER = 'seed-script (NOT A REVIEW — see scripts/mcp/policies.ts)';
const SEED_REQUESTER = 'seed-script';

const SEED_FILE = resolve(__dirname, 'seed/policies.json');

export interface SeedEntry {
  readonly toolId: string;
  readonly toolName: string;
  readonly verificationPolicy: Omit<VerificationPolicy, 'toolId'>;
  readonly decisionPolicy: Omit<DecisionPolicy, 'version' | 'toolId'>;
}

/**
 * The seed entries, read from `seed/policies.json`.
 *
 * Exported so another script can register the same policies against its own
 * application context instead of restating them — `scripts/demo/
 * seed-provider-console.ts` needs an `ACTIVE` policy before it judges a single
 * call, and a second copy of these rules would be a second answer to "what is
 * this tool judged by".
 */
export function readPolicySeed(): readonly SeedEntry[] {
  return (JSON.parse(readFileSync(SEED_FILE, 'utf8')) as { policies: SeedEntry[] }).policies;
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'seed';
  const app = await NestFactory.createApplicationContext(AppMcpModule, { logger: false });
  const policies = app.get(DecisionPolicyService);

  for (const entry of readPolicySeed()) {
    if (command === 'seed') {
      await seedDecisionPolicy(policies, entry);
    }

    const resolved = await policies.resolveForTraffic(entry.toolId);
    console.log(
      [
        entry.toolName.padEnd(20),
        resolved
          ? `${resolved.decisionPolicy.id} v${resolved.decisionPolicy.version}`.padEnd(34)
          : 'NO POLICY'.padEnd(34),
        resolved ? resolved.lifecycle : '—',
      ].join('  '),
    );
  }

  // See the note in `ledger.ts`: closing a context that registered the named
  // `'postgres'` connection throws on shutdown, pre-existing and unrelated.
  await app.close().catch(() => undefined);
  process.exit(0);
}

/**
 * `register → beginShadow → promote`, and idempotent by omission.
 *
 * A tool that already has a serving policy is left alone rather than given a
 * second version. Re-running the seed after a call has been judged would
 * otherwise leave receipts naming a version that no longer serves, which is a
 * confusing thing to hand somebody who is trying to understand the receipt.
 */
export async function seedDecisionPolicy(
  policies: DecisionPolicyService,
  entry: SeedEntry,
): Promise<void> {
  const existing = await policies.resolveForTraffic(entry.toolId);
  if (existing && existing.lifecycle === PolicyLifecycle.ACTIVE) {
    return;
  }

  const registered = await policies.register({
    draft: { ...entry.decisionPolicy, toolId: entry.toolId },
    verificationPolicy: { ...entry.verificationPolicy, toolId: entry.toolId },
    createdBy: SEED_REQUESTER,
  });

  await policies.beginShadow(registered.id, registered.version);

  // The numbers below are fabricated and the note says so in the row itself.
  // `PROMOTION_GATE` asks for 500 shadow calls, 100 labelled samples and a
  // false-positive rate strictly under 2%; nothing counts any of them yet.
  await policies.promote(registered.id, registered.version, {
    shadowCalls: 500,
    labelledSamples: 100,
    falsePositives: 0,
    requestedBy: SEED_REQUESTER,
    approvedBy: SEED_APPROVER,
    note:
      'Seeded by scripts/mcp/policies.ts for the demo. The evidence counts are ' +
      'FABRICATED — no shadow traffic was judged and no sample was labelled. ' +
      'Receipts give the gate real inputs by making verification_records countable.',
  });
}

// Guarded so that importing this module for {@link seedDecisionPolicy} does not
// boot a second application context and exit the importing process.
if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
