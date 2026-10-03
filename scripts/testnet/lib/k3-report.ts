import {
  K3Criterion,
  K3Outcome,
  K3Result,
  K3_CRITERIA,
  assertWellFormed,
  criterion,
  isGreen,
} from './k3-criteria';

/**
 * ## A criterion with no result is a FAILURE OF THE RUN, not an omission from the report
 *
 * Every criterion starts at `NOT_RUN`. A step that throws before recording leaves it `NOT_RUN`,
 * and a step that was never written leaves it `NOT_RUN`. **There is no path by which a criterion
 * is simply absent from the output** — which is exactly the path `yarn devnet:acceptance` has for
 * three of its nine bullets today.
 *
 * ## PARTIAL exists because "we ran something like it" is the failure mode
 *
 * E2 says "the PLATFORM redeems it and the provider's balance increases in ONE transaction". A
 * fork test proving the contract's half of that is real evidence and is **not** that criterion. It
 * reports `PARTIAL` with `unproven` naming the half that did not run. **PARTIAL is not green.**
 *
 * ## `unproven` is REQUIRED on PARTIAL and NOT_RUN, and the report refuses to print without it
 *
 * Enforced by `assertWellFormed`, on the way in, so a malformed result cannot reach the footer.
 *
 * ## The exit code
 *
 * `0` only when every criterion is `PASSED`. Anything else exits `1`, and the last line names the
 * count by outcome. A partially-runnable chain integration exits 1 and **that is correct**: the
 * criteria are the acceptance bar, not a progress meter.
 */
export class K3Report {
  private readonly results = new Map<string, K3Result>();

  constructor() {
    for (const c of K3_CRITERIA) {
      this.results.set(c.id, {
        id: c.id,
        outcome: K3Outcome.NOT_RUN,
        evidence: '',
        unproven: 'no step ran for this criterion in this invocation',
      });
    }
  }

  record(result: K3Result): void {
    const checked = assertWellFormed(result);
    this.results.set(checked.id, checked);
    const c = criterion(checked.id);
    console.log(`[${checked.outcome.padEnd(7)}] ${checked.id}  ${c.text}`);
    if (checked.evidence) console.log(`            evidence: ${checked.evidence}`);
    if (checked.unproven) console.log(`            unproven: ${checked.unproven}`);
  }

  /**
   * A step that threw is a FAILED criterion carrying the throw, never a missing line.
   *
   * The alternative — letting the exception escape — stops the run at the first problem and
   * leaves every later criterion unattempted while the report says `NOT_RUN`, which is true but
   * for the wrong reason.
   */
  async run(id: string, step: (c: K3Criterion) => Promise<K3Result>): Promise<void> {
    try {
      this.record(await step(criterion(id)));
    } catch (error) {
      this.record({
        id,
        outcome: K3Outcome.FAILED,
        evidence: `the step threw: ${error instanceof Error ? error.message : String(error)}`,
        unproven: null,
      });
    }
  }

  all(): readonly K3Result[] {
    return K3_CRITERIA.map((c) => this.results.get(c.id) as K3Result);
  }

  green(): boolean {
    return isGreen(this.all());
  }

  printFooter(): void {
    const all = this.all();
    const count = (o: K3Outcome) => all.filter((r) => r.outcome === o).length;

    console.log('');
    console.log(`  Per-chain acceptance — ${all.length} criteria`);
    console.log(
      `  PASSED ${count(K3Outcome.PASSED)} · PARTIAL ${count(K3Outcome.PARTIAL)}` +
        ` · FAILED ${count(K3Outcome.FAILED)} · NOT_RUN ${count(K3Outcome.NOT_RUN)}`,
    );
    console.log(
      this.green()
        ? '  GREEN. All 12 PASSED.'
        : `  NOT GREEN. The criteria are met when all ${all.length} are PASSED.`,
    );

    for (const outcome of [K3Outcome.FAILED, K3Outcome.PARTIAL, K3Outcome.NOT_RUN]) {
      const rows = all.filter((r) => r.outcome === outcome);
      if (rows.length === 0) continue;
      console.log('');
      console.log(`  ${outcome}, and what each needs:`);
      for (const r of rows) {
        const c = criterion(r.id);
        console.log(
          `    ${r.id}  needs: ${c.needs.length ? c.needs.join(', ') : '(nothing — it is runnable today)'}`,
        );
        if (r.evidence) console.log(`        evidence: ${r.evidence}`);
        if (r.unproven) console.log(`        unproven: ${r.unproven}`);
      }
    }
  }
}
