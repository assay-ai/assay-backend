/**
 * In-memory evidence recorder + JSON report writer for the devnet acceptance
 * suite. No dependency on any other file under `scripts/devnet/` — this
 * module is pure bookkeeping: each step calls `record()` as it runs, the
 * suite prints a fixed header of known limitations up front via
 * `printHeader()`, and `writeToDisk()` dumps everything collected to a
 * timestamped JSON file at the end of the run for later inspection.
 */
import { writeFileSync } from 'node:fs';

/**
 * One step's evidence.
 *
 * Every optional field here must be one that `step()` — the only thing that
 * calls `record()` — can actually fill. It owns both records precisely so a
 * step cannot run unrecorded, which means a field it has no way to reach is a
 * channel that will stay empty forever while looking to a reader like evidence
 * that was simply not gathered this run. `balanceBefore`/`balanceAfter` were
 * exactly that and are gone: balances reach the report inside `detail`, the
 * string a step returns (see `runStep3`'s ledger-unchanged proof). If a later
 * step needs them structured, the answer is to reconsider `step()`'s shape
 * deliberately at that point — not to leave a hook here inviting a step to
 * record itself a second, inconsistent time.
 */
export interface StepEvidence {
  step: string;
  status: 'OK' | 'FAILED' | 'PAUSED';
  detail?: string;
  txSignature?: string;
  httpStatus?: number;
}

export class AcceptanceReport {
  private readonly steps: StepEvidence[] = [];
  private readonly runId = new Date().toISOString().replace(/[:.]/g, '-');

  record(evidence: StepEvidence): void {
    this.steps.push(evidence);
    const mark = evidence.status === 'OK' ? 'OK ' : evidence.status === 'PAUSED' ? 'PAUSE' : 'FAIL';
    console.log(`[${mark}] ${evidence.step}${evidence.detail ? ' — ' + evidence.detail : ''}`);
  }

  printHeader(): void {
    console.log('devnet acceptance suite — known limitations, read before trusting a green run:');
    // These lines are the report's mandatory disclosure — do not shorten, paraphrase, or
    // drop any of them.
    console.log(
      '  1. Steps 1/4/5 do NOT re-verify browser/Privy UX — that needs a manual browser run.',
    );
    console.log(
      '  2. Steps 8/9 use a seeded low price to stay under the $1.00 on-chain penalty ceiling —',
    );
    console.log('     the real-price ($0.25/call) mismatch is still UNRESOLVED (economic parameters).');
    // Item 3 covers BOTH halves of one limitation, deliberately as one line: a green
    // step 7 shows the buyer's side of a paid call and nothing about the provider's.
    // The two mechanisms differ — weighted-random routing over a shared catalogue tool
    // decides WHO serves, and a missing `provider_account` decides that NOBODY is paid —
    // but the disclosure is the same sentence, and a reader who takes "7 OK" as "the
    // payment path works end to end" is wrong for either reason. Step 7's own detail
    // string carries both mechanisms in full, with figures, on every run.
    console.log(
      '  3. Step 7 proves the buyer is DEBITED — not who was paid, and not that anyone was.',
    );
    console.log(
      '     Routing draws weighted-randomly over a shared catalogue tool, so the serving',
    );
    console.log(
      '     provider is usually NOT the one this run built; and no rail-A hold has ever been',
    );
    console.log(
      '     committed (provider_account is never set, so resolve() throws after the status',
    );
    console.log(
      "     moves) — the provider is never credited and the hold's 24h expiry refunds the",
    );
    console.log('     buyer. See step 7\'s detail line.');
    console.log('');
  }

  writeToDisk(): string {
    const path = `devnet-acceptance-${this.runId}.json`;
    writeFileSync(path, JSON.stringify({ runId: this.runId, steps: this.steps }, null, 2));
    return path;
  }

  hasFailure(): boolean {
    return this.steps.some((s) => s.status === 'FAILED');
  }
}
