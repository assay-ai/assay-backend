import { readFileSync } from 'node:fs';

import {
  K3Outcome,
  K3Result,
  K3_CRITERIA,
  assertWellFormed,
  isGreen,
} from '../../../scripts/testnet/lib/k3-criteria';
import { specPath } from '../../../scripts/testnet/lib/repo-paths';
import { STEPS } from '../../../scripts/testnet/acceptance-suite';

/**
 * **This test reads the acceptance criteria.** That is the structural fix for an acceptance suite
 * that once went green while missing steps, and it is worth the file-path awkwardness.
 *
 * `yarn devnet:acceptance` is fully green while three of its nine required bullets have **no step
 * at all**. Nothing caught that, because nothing compared the suite against the document the
 * suite is accountable to. This does exactly that comparison, in the unit suite, where it is red
 * on the commit that breaks it rather than at 3am.
 *
 * `specPath()` throws rather than skipping when it cannot find the document — a coverage gate that
 * quietly passes when its input is missing is the one shape this file must never have.
 */
const SPEC = readFileSync(specPath(), 'utf8');

/** The acceptance criteria's bullets, extracted from the section itself. */
function k3Bullets(): string[] {
  const start = SPEC.indexOf('## Criteria');
  const end = SPEC.indexOf('## End of criteria', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return SPEC.slice(start, end)
    .split('\n')
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2));
}

function passed(id: string): K3Result {
  return { id, outcome: K3Outcome.PASSED, evidence: 'measured', unproven: null };
}

function withOutcome(id: string, outcome: K3Outcome): K3Result[] {
  return K3_CRITERIA.map((c) =>
    c.id === id
      ? { id: c.id, outcome, evidence: 'measured', unproven: 'the half that did not run' }
      : passed(c.id),
  );
}

describe('the acceptance harness covers the acceptance criteria', () => {
  it('has exactly one criterion per bullet, and the bullet text VERBATIM', () => {
    const bullets = k3Bullets();
    expect(K3_CRITERIA).toHaveLength(bullets.length);
    expect(K3_CRITERIA.map((c) => c.text)).toEqual(bullets);
  });

  it('has a step registered for every criterion', () => {
    // The half that failed on the devnet suite: three of nine bullets had NO step at all, and
    // the run was green. A criterion in the list with nothing wired to it fails HERE, in the
    // unit suite, rather than being invisible at 3am.
    // Collected rather than asserted one at a time: jest's `expect` takes no message argument,
    // and the SENTENCE is the point — "no step registered for E4: A full two-phase slash: …"
    // tells the reader which acceptance question stopped being asked.
    const missing = K3_CRITERIA.filter((c) => !STEPS[c.id]).map(
      (c) => `no step registered for ${c.id}: ${c.text}`,
    );
    expect(missing).toEqual([]);
  });

  it('registers no step for a criterion that does not exist', () => {
    // The other direction. A step keyed on a criterion the document no longer has is a function
    // nobody runs and a reader would count as coverage.
    const ids = new Set(K3_CRITERIA.map((c) => c.id));
    const orphaned = Object.keys(STEPS)
      .filter((id) => !ids.has(id))
      .map((id) => `${id} has a step but is not an acceptance criterion`);
    expect(orphaned).toEqual([]);
  });

  it('treats PARTIAL and NOT_RUN as NOT GREEN', () => {
    expect(isGreen(K3_CRITERIA.map((c) => passed(c.id)))).toBe(true);
    expect(isGreen(withOutcome('E6', K3Outcome.NOT_RUN))).toBe(false);
    expect(isGreen(withOutcome('E2', K3Outcome.PARTIAL))).toBe(false);
    expect(isGreen(withOutcome('E1', K3Outcome.FAILED))).toBe(false);
  });

  it('is not green when a criterion is simply absent from the results', () => {
    expect(isGreen(K3_CRITERIA.slice(1).map((c) => passed(c.id)))).toBe(false);
  });

  it('refuses a PARTIAL or NOT_RUN result that does not say what is unproven', () => {
    expect(() =>
      assertWellFormed({ id: 'E6', outcome: K3Outcome.NOT_RUN, evidence: 'x', unproven: null }),
    ).toThrow(/E6.*unproven/);
    expect(() =>
      assertWellFormed({ id: 'E2', outcome: K3Outcome.PARTIAL, evidence: 'x', unproven: '  ' }),
    ).toThrow(/E2.*unproven/);
  });

  it('refuses a PASSED result with no evidence', () => {
    expect(() =>
      assertWellFormed({ id: 'E3', outcome: K3Outcome.PASSED, evidence: '', unproven: null }),
    ).toThrow(/E3.*evidence/);
  });

  it('refuses a result for an id the acceptance criteria do not name', () => {
    expect(() =>
      assertWellFormed({ id: 'E9', outcome: K3Outcome.PASSED, evidence: 'x', unproven: null }),
    ).toThrow(/E9.*not an acceptance criterion/);
  });

  it('names, for every criterion that needs a deployment, what it needs', () => {
    // `needs` is what a NOT_RUN prints. An empty `needs` on a criterion that cannot run is a
    // line that says "not run" and gives the reader nothing to act on.
    for (const id of ['E2', 'E5', 'E6']) {
      const c = K3_CRITERIA.find((x) => x.id === id);
      expect(c?.needs).toContain('a 46630 deployment');
    }
  });
});
