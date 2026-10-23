/**
 * The per-chain acceptance criteria (`docs/acceptance-criteria.md`), **as data**.
 *
 * ## Why this file exists at all
 *
 * `yarn devnet:acceptance` is fully green while **three of its nine required bullets have no step
 * at all** — including *"upstream down, stake untouched"*, one of the two most important
 * criteria. A suite that is green because it never exercised a criterion is worse than no suite:
 * it converts an unanswered question into a recorded answer.
 *
 * So this harness is built the other way round. The criterion list comes **first**, extracted from
 * `docs/acceptance-criteria.md` itself; `test/unit/acceptance/k3-coverage.spec.ts` reads that
 * document and fails if this array and its bullets disagree in count, in order or in text; and a
 * criterion with no step registered against it fails **there**, in the unit suite, rather than
 * being invisible at 3am.
 *
 * ## The `text` field is the bullet's FIRST LINE, VERBATIM
 *
 * Backticks, bold markers, the odd trailing comma where the bullet wraps — all of it. Several of
 * these read as half-sentences and that is correct: the coverage gate compares strings, and a
 * "tidier" copy is a gate that passes over a criterion nobody re-read.
 */

export enum K3Outcome {
  /** The criterion, whole, was exercised and held. **The only green outcome.** */
  PASSED = 'PASSED',
  /** Something NARROWER than the criterion ran. NOT green. */
  PARTIAL = 'PARTIAL',
  FAILED = 'FAILED',
  /** No step executed. NOT green, and never silent. */
  NOT_RUN = 'NOT_RUN',
}

export interface K3Criterion {
  /** `S1`…`S4`, `E1`…`E8`. */
  readonly id: string;
  readonly chain: 'solana' | 'eip155:46630';
  /** The criterion's own words, verbatim. The coverage gate compares against the document. */
  readonly text: string;
  /** What would have to be true for this to run at all. Printed on NOT_RUN. */
  readonly needs: readonly string[];
}

export interface K3Result {
  readonly id: string;
  readonly outcome: K3Outcome;
  /** What was actually observed. Required on PASSED, PARTIAL and FAILED. */
  readonly evidence: string;
  /** Required on PARTIAL and NOT_RUN. The half that is still unproven, in one sentence. */
  readonly unproven: string | null;
}

export const K3_CRITERIA: readonly K3Criterion[] = [
  {
    id: 'S1',
    chain: 'solana',
    text: '`devnet:acceptance` passes unchanged.',
    needs: [
      'a devnet-connected API server',
      'a running SCHEDULER — step 5 waits for DEPOSIT_CONFIRM',
    ],
  },
  {
    id: 'S2',
    chain: 'solana',
    text: 'Every existing test green; no test deleted to accommodate the union.',
    needs: [],
  },
  {
    id: 'S3',
    chain: 'solana',
    text: 'The contract suite passes with the Solana adapter.',
    needs: [],
  },
  {
    id: 'S4',
    chain: 'solana',
    text: '`ENABLED_CHAINS` listing only mainnet: a devnet deposit is refused with `CHAIN_UNSUPPORTED`,',
    needs: [],
  },
  {
    id: 'E1',
    chain: 'eip155:46630',
    text: 'Foundry suite: parity with the ~240 Anchor tests that have a behavioural analogue, plus',
    needs: [],
  },
  {
    id: 'E2',
    chain: 'eip155:46630',
    text: 'A buyer funds USDG, sets limits, signs an EIP-712 voucher, the platform redeems it, and the',
    needs: [
      'a 46630 deployment',
      'a registered EVM verifier key',
      // Was `EVM_VOUCHER_REDEMPTION_ENABLED=true` — a variable nothing in the codebase reads,
      // so it could be set or unset without changing anything. These are what E2 consumes.
      'TESTNET_E2_BUYER_KEY — a scripted buyer holding its own key and some ETH for gas',
      'a provider bonded at minimumStake (TESTNET_E2_PROVIDER)',
      "EVM_REDEEMER_KEYS holding the deployment's redeemer (a different key from EVM_RELAYER_KEYS)",
    ],
  },
  {
    id: 'E3',
    chain: 'eip155:46630',
    text: 'A voucher whose `(payer, seq)` was already redeemed reverts, in any order (D-23). A voucher malleated to high-s reverts. A voucher with',
    needs: [],
  },
  {
    id: 'E4',
    chain: 'eip155:46630',
    text: 'A full two-phase slash: propose → 72 h (warped) → execute, and a second run where',
    needs: [],
  },
  {
    id: 'E5',
    chain: 'eip155:46630',
    text: "A buyer withdraws with **zero** ETH after the relayer's bounded gas top-up.",
    needs: ['a 46630 deployment', 'a funded relayer EOA', 'EVM_RELAYER_ENABLED=true'],
  },
  {
    id: 'E6',
    chain: 'eip155:46630',
    text: 'The reconciler reports a clean run against a live 46630 deployment.',
    needs: ['a 46630 deployment'],
  },
  {
    id: 'E7',
    chain: 'eip155:46630',
    text: '`ENABLED_CHAINS` without `eip155:46630`: no 402 advertises it, its providers are excluded, a',
    needs: [],
  },
  {
    id: 'E8',
    chain: 'eip155:46630',
    text: '**The negative test for chain isolation**: a buyer funded only on Solana calling a tool whose only',
    needs: [],
  },
];

/** Every criterion PASSED. Nothing else is green — see {@link K3Outcome}. */
export function isGreen(results: readonly K3Result[]): boolean {
  if (results.length !== K3_CRITERIA.length) return false;
  return results.every((r) => r.outcome === K3Outcome.PASSED);
}

/**
 * A result the report is allowed to print.
 *
 * Both rules exist because their absence has already cost this project a green run over an
 * untested path. A `NOT_RUN` with no sentence saying what is unknown is a line a reader skims;
 * one that says *"the platform has never redeemed a voucher on 46630 because nothing is
 * deployed"* is not. And a `PASSED` with no evidence is an assertion, not a measurement.
 */
export function assertWellFormed(result: K3Result): K3Result {
  const needsUnproven =
    result.outcome === K3Outcome.PARTIAL || result.outcome === K3Outcome.NOT_RUN;
  if (needsUnproven && !result.unproven?.trim()) {
    throw new Error(
      `${result.id}: a ${result.outcome} result must say what is unproven, in one sentence. ` +
        'A line with no such sentence is a line a reader skims.',
    );
  }
  if (result.outcome !== K3Outcome.NOT_RUN && !result.evidence.trim()) {
    throw new Error(
      `${result.id}: a ${result.outcome} result must carry the evidence it was read from. ` +
        'Without it the outcome is an assertion rather than a measurement.',
    );
  }
  if (!K3_CRITERIA.some((c) => c.id === result.id)) {
    throw new Error(`${result.id}: not an acceptance criterion id`);
  }
  return result;
}

export function criterion(id: string): K3Criterion {
  const found = K3_CRITERIA.find((c) => c.id === id);
  if (!found) throw new Error(`${id}: not an acceptance criterion id`);
  return found;
}
