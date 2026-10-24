/// <reference types="node" />
// ^ REQUIRED, and it is not decoration. `tsconfig.json` sets `"types": []`, so ts-node loads no
// ambient @types at all; every other script under `scripts/` gets node's globals by accident,
// through a `/// <reference types="node" />` inside some .d.ts of Nest or TypeORM that it
// happens to import. This file imports nothing but its own siblings, so it gets none — and
// `yarn testnet:acceptance` dies at compile time with eleven "Cannot find name 'process'".
/**
 * `yarn testnet:acceptance` — one step per bullet of `docs/acceptance-criteria.md`, and NOT_RUN
 * is not green.
 *
 * **Expect `EXIT=1` until a 46630 deployment exists, and expect a NOT_RUN block.** Deploying is a
 * human action behind the preconditions in the EVM repository's deploy runbook,
 * and a green run here would mean something is wrong — either a step is asserting less than its
 * criterion, or a precondition check is passing over an absent deployment.
 *
 * Read `scripts/testnet/lib/k3-criteria.ts` first: it explains why the criterion list is data
 * extracted from the criteria document rather than a list of functions someone remembered to
 * write.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { K3Criterion, K3Outcome, K3Result } from './lib/k3-criteria';
import { K3Report } from './lib/k3-report';
import { BACKEND_DIR, evmDir } from './lib/repo-paths';

// ── Recorded floors ─────────────────────────────────────────────────────────
//
// The COUNT is the point. A green run with fewer suites is exactly how a deleted test hides, and
// "every existing test green" is a claim about a population, not about a pass rate. Raise these
// when the suite genuinely grows; never lower them to accommodate a deletion.
const UNIT_SUITE_FLOOR = 291;
const UNIT_TEST_FLOOR = 4555;
const INTEGRATION_SUITE_FLOOR = 44;
/** `solana-adapter.contract.spec.ts`'s measured conformance count, 2026-09-10. */
const SOLANA_CONTRACT_TEST_FLOOR = 117;

/**
 * `forge`, which is not on `PATH` in every shell this runs from.
 *
 * Resolved rather than assumed, and if it cannot be found the E1/E3/E4 steps report FAILED with
 * the paths tried — never PASSED, and never quietly skipped.
 */
function forgeBin(): string {
  const candidates = [
    process.env.FORGE_BIN,
    ...(process.env.PATH ?? '').split(':').map((d) => (d ? resolve(d, 'forge') : '')),
    resolve(process.env.HOME ?? '', '.foundry/bin/forge'),
  ].filter((p): p is string => Boolean(p));
  const found = candidates.find((p) => existsSync(p));
  if (!found)
    throw new Error(
      `forge not found. Tried ${candidates.length} paths including ~/.foundry/bin/forge`,
    );
  return found;
}

interface Shell {
  readonly code: number;
  readonly out: string;
}

/**
 * Run a command and return **stdout AND stderr together**, plus the exit code.
 *
 * The concatenation is load-bearing and was a measured defect in this file's first run: **jest
 * writes its `Test Suites:` / `Tests:` summary to STDERR**, and `execFileSync` returns stdout
 * alone on success. So every jest-backed criterion parsed `-1` counts out of an empty string and
 * reported FAILED — a red line, for the right reason (a count below its floor) but with a wrong
 * diagnosis ("the unit suite shrank"). Exactly the shape this harness exists to refuse, arriving
 * inside the harness itself.
 */
function sh(command: string, args: readonly string[], cwd: string): Shell {
  const run = spawnSync(command, [...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, FOUNDRY_DISABLE_NIGHTLY_WARNING: '1', CI: '1' },
  });
  if (run.error) return { code: 1, out: run.error.message };
  return { code: run.status ?? 1, out: `${run.stdout ?? ''}\n${run.stderr ?? ''}` };
}

/** Jest prints these two lines on every run, pass or fail. */
function jestCounts(out: string): {
  suites: number;
  suitesFailed: number;
  tests: number;
  testsFailed: number;
} {
  const suiteLine = /Test Suites:.*?(\d+) total/.exec(out);
  const testLine = /Tests:.*?(\d+) total/.exec(out);
  const suitesFailed = /Test Suites:.*?(\d+) failed/.exec(out);
  const testsFailed = /Tests:.*?(\d+) failed/.exec(out);
  return {
    suites: suiteLine ? Number(suiteLine[1]) : -1,
    suitesFailed: suitesFailed ? Number(suitesFailed[1]) : 0,
    tests: testLine ? Number(testLine[1]) : -1,
    testsFailed: testsFailed ? Number(testsFailed[1]) : 0,
  };
}

/**
 * `[PASS] <name>` in a forge run, by NAME.
 *
 * A suite's exit code says "nothing failed", which is also what an empty selection says. Naming
 * the tests is what makes `--match-test` typos and renamed tests loud instead of green.
 */
function forgePassed(out: string, name: string): boolean {
  return out.includes(`[PASS] ${name}(`);
}

/**
 * The 46630 deployment record.
 *
 * **The precondition check reads the RECORD, not a flag.** A boolean somebody sets is a boolean
 * somebody sets wrongly; `deployments/46630.json`'s `status` is written by the operator as part of
 * the deploy and checked by `verify-deployment.sh`.
 */
function deploymentStatus(chainId: number): string {
  const path = resolve(evmDir(), `deployments/${chainId}.json`);
  if (!existsSync(path)) return 'no record file';
  try {
    return String(JSON.parse(readFileSync(path, 'utf8')).status ?? 'no status field');
  } catch (error) {
    return `unreadable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function notRunWithoutDeployment(id: string, unproven: string): K3Result {
  const status = deploymentStatus(46630);
  return {
    id,
    outcome: K3Outcome.NOT_RUN,
    evidence: `deployments/46630.json (EVM repository) status is "${status}"`,
    unproven,
  };
}

// ── The steps ───────────────────────────────────────────────────────────────

export type K3Step = (criterion: K3Criterion) => Promise<K3Result>;

/**
 * `devnet:acceptance` passes unchanged.
 *
 * If the prerequisites are absent — a devnet-connected API, a running scheduler — this records
 * NOT_RUN with those in `needs`. **Never PASSED, and never skipped silently.**
 */
const runS1: K3Step = async (c) => {
  const base = process.env.ACCEPTANCE_API_BASE_URL ?? 'http://127.0.0.1:3000';
  const reachable = await fetch(`${base}/api/v1/health`, { method: 'GET' })
    .then((r) => r.ok)
    .catch(() => false);
  if (!reachable) {
    return {
      id: c.id,
      outcome: K3Outcome.NOT_RUN,
      evidence: `no API answered GET ${base}/api/v1/health`,
      unproven:
        'the Solana devnet suite was not re-run in this invocation, so nothing here says the ' +
        'union left it unchanged. It needs a devnet-connected API AND a running scheduler — ' +
        'its step 5 waits for DEPOSIT_CONFIRM, which only the scheduler writes.',
    };
  }
  const run = sh('yarn', ['devnet:acceptance'], BACKEND_DIR);
  return run.code === 0
    ? {
        id: c.id,
        outcome: K3Outcome.PASSED,
        evidence: `yarn devnet:acceptance exited 0 against ${base}`,
        unproven: null,
      }
    : {
        id: c.id,
        outcome: K3Outcome.FAILED,
        evidence: `yarn devnet:acceptance exited ${run.code}; tail: ${run.out.slice(-600)}`,
        unproven: null,
      };
};

/** Every existing test green; no test deleted. **The COUNT is half the claim.** */
const runS2: K3Step = async (c) => {
  const unit = sh('yarn', ['test'], BACKEND_DIR);
  const u = jestCounts(unit.out);
  // A summary that could not be READ is not a summary that says zero. Reporting "the suite
  // shrank" for an unparseable run sends the reader to look for a deleted test that does not
  // exist — the same class of wrong-incident defect the float monitor's UNREADABLE level refuses.
  if (u.suites < 0 || u.tests < 0) {
    return {
      id: c.id,
      outcome: K3Outcome.FAILED,
      evidence: `could not read jest's summary from the unit run (exit ${unit.code}); tail: ${unit.out.slice(-400)}`,
      unproven: null,
    };
  }
  if (u.suites < UNIT_SUITE_FLOOR || u.tests < UNIT_TEST_FLOOR) {
    return {
      id: c.id,
      outcome: K3Outcome.FAILED,
      evidence:
        `the unit suite shrank: ${u.suites} suites / ${u.tests} tests, ` +
        `floor is ${UNIT_SUITE_FLOOR} / ${UNIT_TEST_FLOOR}. A test was deleted or stopped being ` +
        'collected — a pass rate cannot see this.',
      unproven: null,
    };
  }
  if (unit.code !== 0 || u.suitesFailed > 0) {
    return {
      id: c.id,
      outcome: K3Outcome.FAILED,
      evidence: `the unit suite is red: ${u.suitesFailed} suites / ${u.testsFailed} tests failed`,
      unproven: null,
    };
  }

  const integration = sh('yarn', ['test:integration', '--forceExit'], BACKEND_DIR);
  const i = jestCounts(integration.out);
  if (i.suites < INTEGRATION_SUITE_FLOOR) {
    return {
      id: c.id,
      outcome: K3Outcome.FAILED,
      evidence: `the integration suite shrank: ${i.suites} suites, floor is ${INTEGRATION_SUITE_FLOOR}`,
      unproven: null,
    };
  }
  if (i.suitesFailed > 0) {
    return {
      id: c.id,
      outcome: K3Outcome.PARTIAL,
      evidence:
        `unit ${u.suites} suites / ${u.tests} tests all green; ` +
        `integration ${i.suites} suites with ${i.suitesFailed} failed and ${i.testsFailed} tests failed`,
      unproven:
        'the integration half is not green. The failures pre-date the multichain work and are ' +
        'compile blockers in shared helpers (voucher-test-context arity, ESCROW_SEQ_ALERTS / ' +
        'VOUCHER_MAX_IN_FLIGHT, PAYMENT_TOO_MANY_IN_FLIGHT, EscrowSeqService.realignTo) — but ' +
        '"every existing test green" is a claim about all of them, and it is not true today.',
    };
  }
  return {
    id: c.id,
    outcome: K3Outcome.PASSED,
    evidence: `unit ${u.suites}/${u.tests} green, integration ${i.suites} suites green`,
    unproven: null,
  };
};

/** The contract suite, with the Solana adapter. */
const runS3: K3Step = async (c) => {
  const run = sh(
    'npx',
    [
      'jest',
      '--config',
      './test/jest-unit.json',
      'test/unit/chains/solana-adapter.contract.spec.ts',
    ],
    BACKEND_DIR,
  );
  const counts = jestCounts(run.out);
  if (run.code !== 0 || counts.testsFailed > 0) {
    return {
      id: c.id,
      outcome: K3Outcome.FAILED,
      evidence: `solana-adapter.contract.spec.ts exited ${run.code}; ${counts.testsFailed} failed`,
      unproven: null,
    };
  }
  if (counts.tests < SOLANA_CONTRACT_TEST_FLOOR) {
    return {
      id: c.id,
      outcome: K3Outcome.FAILED,
      evidence: `the conformance suite ran ${counts.tests} tests, below the floor of ${SOLANA_CONTRACT_TEST_FLOOR}`,
      unproven: null,
    };
  }
  return {
    id: c.id,
    outcome: K3Outcome.PASSED,
    evidence: `solana-adapter.contract.spec.ts: ${counts.tests} conformance cases, all green`,
    unproven: null,
  };
};

/** `ENABLED_CHAINS` listing only mainnet. Same shape as E7 and the same honest gap. */
const runS4: K3Step = async (c) =>
  process.env.ISOLATION_TARGETS_FILE
    ? runLiveScript(c, 'testnet:isolation', [c.id], 'ISOLATION_RESULT')
    : enabledChainsCriterion(c, 'solana');

/** The Foundry suite plus the three accounting invariants. */
const runE1: K3Step = async (c) => {
  const evm = evmDir();
  const suite = sh(forgeBin(), ['test'], evm);
  const counts = /(\d+) tests passed, (\d+) failed/.exec(suite.out);
  if (suite.code !== 0) {
    return {
      id: c.id,
      outcome: K3Outcome.FAILED,
      evidence: `forge test exited ${suite.code}; tail: ${suite.out.slice(-600)}`,
      unproven: null,
    };
  }

  const invariants = sh(forgeBin(), ['test', '--match-contract', 'Invariants', '-vv'], evm);
  // BY NAME, not by exit code. `--match-contract` matching nothing also exits 0.
  const named = [
    'invariant_escrowBalancesSumToTotalEscrowed', // escrow.balance conservation
    'invariant_stakeAccountingIdentity', // total_staked == deposited − withdrawn − slashed
    'invariant_theStakeVaultHoldsAtLeastWhatItOwes', // vault >= total_staked
  ];
  const missing = named.filter((n) => !forgePassed(invariants.out, n));
  if (invariants.code !== 0 || missing.length > 0) {
    return {
      id: c.id,
      outcome: K3Outcome.FAILED,
      evidence: `invariants exited ${invariants.code}; not [PASS] by name: ${missing.join(', ') || '(none)'}`,
      unproven: null,
    };
  }
  // The floor, and it is not optional. `fail_on_revert = false` means an all-reverts campaign
  // reports every identity green over an untouched state — measured in assay-evm's test/MUTATION-LOG.md as
  // SEVEN green invariants over 16,384 calls that all did nothing.
  if (!forgePassed(invariants.out, 'test_theHandlerCanReachEveryAction')) {
    return {
      id: c.id,
      outcome: K3Outcome.FAILED,
      evidence:
        'the three identities are green but test_theHandlerCanReachEveryAction is not [PASS]. ' +
        'Under fail_on_revert = false that combination is exactly what a campaign that did ' +
        'nothing reports.',
      unproven: null,
    };
  }

  return {
    id: c.id,
    outcome: K3Outcome.PARTIAL,
    evidence:
      `forge test: ${counts ? `${counts[1]} passed, ${counts[2]} failed` : 'exit 0'}; ` +
      'the three identities [PASS] by name and the reachability floor holds',
    unproven:
      'the ~240-test parity mapping does not exist. Nobody has counted the Anchor tests with a ' +
      "behavioural analogue and named the Solidity test for each, and the suite's own count is " +
      'not evidence of parity.',
  };
};

/**
 * E2 on the live deployment: `yarn testnet:e2` (see that script for who plays which part).
 *
 * NOT_RUN without a deployment record or without a scripted buyer key — never PASSED on either.
 * The child prints one `E2_RESULT {json}` line; anything else is FAILED with its tail, because an
 * unreadable run is not a run that said nothing.
 */
const runE2: K3Step = async (c) => {
  if (deploymentStatus(46630) === 'no record file') {
    return notRunWithoutDeployment(
      c.id,
      "the platform's half has never run against a deployed AssayEscrow.",
    );
  }
  if (!process.env.TESTNET_E2_BUYER_KEY) {
    return {
      id: c.id,
      outcome: K3Outcome.NOT_RUN,
      evidence: 'TESTNET_E2_BUYER_KEY is not set',
      unproven:
        'no voucher was signed or redeemed in this invocation. Source the scripted buyer key ' +
        '(kept outside the repo) and re-run; the buyer needs a little ETH for its own gas.',
    };
  }
  const run = sh('yarn', ['-s', 'testnet:e2'], BACKEND_DIR);
  const line = run.out.split('\n').find((l) => l.startsWith('E2_RESULT '));
  if (!line) {
    return {
      id: c.id,
      outcome: K3Outcome.FAILED,
      evidence: `yarn testnet:e2 exited ${run.code} with no E2_RESULT line; tail: ${run.out.slice(-600)}`,
      unproven: null,
    };
  }
  const result = JSON.parse(line.slice('E2_RESULT '.length)) as {
    outcome: 'PASSED' | 'FAILED';
    evidence: string;
    unproven: string | null;
  };
  return {
    id: c.id,
    outcome: result.outcome === 'PASSED' && run.code === 0 ? K3Outcome.PASSED : K3Outcome.FAILED,
    evidence: result.evidence,
    unproven: result.unproven,
  };
};

/** Three voucher refusals, all contract-level, all runnable with no deployment. */
const runE3: K3Step = async (c) => {
  const evm = evmDir();
  const cases: readonly [string, string][] = [
    ['test_boundary_eachSeqIsRedeemedExactlyOnce', 'a used seq reverts VoucherSeqUsed (D-23)'],
    ['test_wrongSigner_aMalleatedSignatureIsRefused', 'a high-s malleation reverts'],
    [
      'test_aVoucherSignedForOneChainDoesNotVerifyOnAnother',
      "another chain's id in the domain does not verify",
    ],
    // THE POSITIVE CONTROL, and it is required: without it a recovery that always failed would
    // satisfy all three refusals above.
    ['test_happyPath_recoversThePayer', 'positive control — a correct voucher DOES recover'],
  ];
  const run = sh(forgeBin(), ['test', '--match-test', cases.map(([n]) => n).join('|'), '-vv'], evm);
  const missing = cases.filter(([n]) => !forgePassed(run.out, n));
  if (run.code !== 0 || missing.length > 0) {
    return {
      id: c.id,
      outcome: K3Outcome.FAILED,
      evidence: `exited ${run.code}; not [PASS] by name: ${missing.map(([n]) => n).join(', ') || '(none)'}`,
      unproven: null,
    };
  }
  return {
    id: c.id,
    outcome: K3Outcome.PASSED,
    evidence: `all four [PASS] by name: ${cases.map(([, w]) => w).join('; ')}`,
    unproven: null,
  };
};

/** The two-phase slash, both runs. */
const runE4: K3Step = async (c) => {
  const cases: readonly [string, string][] = [
    ['test_happyPath_aJudgementPaysAfterSeventyTwoHours', 'propose → warp 72 h → execute pays'],
    [
      'test_revokingTheKeyInTheWindowVoidsTheJudgementAndReleasesTheCollateral',
      'revokeVerifier inside the window makes executeSlash revert and expireSlash release',
    ],
    // The negative control for "revocation is re-checked at execution": a judgement that pays
    // when the key is still good is what makes the second case meaningful.
    [
      'test_boundary_theVerifierExpiryInstantBelongsToExecute',
      'negative control — the expiry instant itself still belongs to execute',
    ],
  ];
  const run = sh(
    'forge',
    ['test', '--match-test', cases.map(([n]) => n).join('|'), '-vv'],
    evmDir(),
  );
  const missing = cases.filter(([n]) => !forgePassed(run.out, n));
  if (run.code !== 0 || missing.length > 0) {
    return {
      id: c.id,
      outcome: K3Outcome.FAILED,
      evidence: `exited ${run.code}; not [PASS] by name: ${missing.map(([n]) => n).join(', ') || '(none)'}`,
      unproven: null,
    };
  }
  return {
    id: c.id,
    outcome: K3Outcome.PASSED,
    evidence: `all three [PASS] by name: ${cases.map(([, w]) => w).join('; ')}`,
    unproven: null,
  };
};

/**
 * Runs one of the live-deployment scripts and maps its single `<PREFIX>_RESULT {json}` line onto
 * a criterion result. Anything else is FAILED with its tail, as for E2.
 */
function runLiveScript(
  c: K3Criterion,
  script: string,
  args: readonly string[],
  prefix: string,
): K3Result {
  const run = sh('yarn', ['-s', script, ...args], BACKEND_DIR);
  const line = run.out.split('\n').find((l) => l.startsWith(`${prefix} `));
  if (!line) {
    return {
      id: c.id,
      outcome: K3Outcome.FAILED,
      evidence: `yarn ${script} exited ${run.code} with no ${prefix} line; tail: ${run.out.slice(-600)}`,
      unproven: null,
    };
  }
  const result = JSON.parse(line.slice(prefix.length + 1)) as {
    outcome: 'PASSED' | 'FAILED' | 'NOT_RUN';
    evidence: string;
    unproven: string | null;
  };
  const outcome =
    result.outcome === 'PASSED' && run.code === 0
      ? K3Outcome.PASSED
      : result.outcome === 'NOT_RUN'
        ? K3Outcome.NOT_RUN
        : K3Outcome.FAILED;
  return { id: c.id, outcome, evidence: result.evidence, unproven: result.unproven };
}

/**
 * E5 on the live deployment: `yarn testnet:e5 auto`. The exit is held for an hour on chain, so
 * one invocation either opens the request (NOT_RUN, with when it matures) or completes the
 * zero-ETH withdraw through the platform's gas grant (PASSED or FAILED).
 */
const runE5: K3Step = async (c) => {
  if (deploymentStatus(46630) !== 'deployed') {
    return notRunWithoutDeployment(
      c.id,
      'no zero-ETH buyer has withdrawn on a deployed AssayEscrow through the gas grant.',
    );
  }
  if (!process.env.TESTNET_E5_BUYER_KEY || !process.env.TESTNET_E5_FUNDER_KEY) {
    return {
      id: c.id,
      outcome: K3Outcome.NOT_RUN,
      evidence: 'TESTNET_E5_BUYER_KEY / TESTNET_E5_FUNDER_KEY are not set',
      unproven:
        'no zero-ETH exit ran in this invocation. Source a buyer key that has never held ETH and ' +
        'a funder key that can credit its escrow (both kept outside the repo), then re-run.',
    };
  }
  return runLiveScript(c, 'testnet:e5', ['auto'], 'E5_RESULT');
};

/**
 * E6 on the live deployment: `yarn testnet:e6 reconcile` — finality, then one reconciler pass
 * against the live escrow, which must come back OK with no findings. The deposit that gives the
 * ledger something to agree with is `yarn testnet:e6 deposit`, run beforehand.
 */
const runE6: K3Step = async (c) => {
  if (deploymentStatus(46630) !== 'deployed') {
    return notRunWithoutDeployment(c.id, 'the reconciler has never read a live 46630 escrow.');
  }
  if (!process.env.TESTNET_E6_BUYER_KEY || !process.env.TESTNET_E6_ORGANIZATION_ID) {
    return {
      id: c.id,
      outcome: K3Outcome.NOT_RUN,
      evidence: 'TESTNET_E6_BUYER_KEY / TESTNET_E6_ORGANIZATION_ID are not set',
      unproven: 'the reconciler did not run against the live escrow in this invocation.',
    };
  }
  return runLiveScript(c, 'testnet:e6', ['reconcile'], 'E6_RESULT');
};

/** `ENABLED_CHAINS` without `eip155:46630`. */
const runE7: K3Step = async (c) =>
  process.env.ISOLATION_TARGETS_FILE
    ? runLiveScript(c, 'testnet:isolation', [c.id], 'ISOLATION_RESULT')
    : enabledChainsCriterion(c, 'eip155');

/**
 * Both `S4` and `E7` are the same question asked of the two namespaces, and both get the same
 * honest answer today.
 *
 * What runs: `two-chains.integration.spec.ts`, which boots the DI graph BOTH ways and proves that
 * turning either namespace off leaves the other byte-identically unaffected and demands none of
 * its configuration.
 *
 * What does NOT run: the four assertions the criterion actually names, each of which is a live
 * HTTP read against a booted API — no 402 advertises the chain, its providers are excluded from
 * routing, a deposit naming it is refused `CHAIN_UNSUPPORTED`, and `GET /chains` does not list it.
 * Reporting PASSED off the DI proof would be asserting less than the criterion says while
 * recording that the criterion held.
 */
async function enabledChainsCriterion(c: K3Criterion, namespace: string): Promise<K3Result> {
  const run = sh(
    'npx',
    [
      'jest',
      '--config',
      './test/jest-integration.json',
      'test/integration/chains/two-chains.integration.spec.ts',
      '--forceExit',
    ],
    BACKEND_DIR,
  );
  const counts = jestCounts(run.out);
  if (run.code !== 0 || counts.testsFailed > 0) {
    return {
      id: c.id,
      outcome: K3Outcome.FAILED,
      evidence: `two-chains.integration.spec.ts exited ${run.code}, ${counts.testsFailed} failed`,
      unproven: null,
    };
  }
  return {
    id: c.id,
    outcome: K3Outcome.PARTIAL,
    evidence:
      `two-chains.integration.spec.ts: ${counts.tests} tests green, including ` +
      `"turning ${namespace === 'solana' ? 'Solana' : 'eip155'} off leaves the other entirely unaffected"`,
    unproven:
      'the four assertions this criterion names have not run: they are live HTTP reads against a ' +
      'booted API (no 402 advertises the chain, its providers are excluded from routing, a ' +
      'deposit naming it is refused CHAIN_UNSUPPORTED, GET /chains does not list it), in BOTH ' +
      'directions in one run. What ran is a DI-graph proof, which is narrower.',
  };
}

/** The negative test for chain isolation. */
const runE8: K3Step = async (c) => {
  if (process.env.ISOLATION_TARGETS_FILE) {
    return runLiveScript(c, 'testnet:isolation', [c.id], 'ISOLATION_RESULT');
  }
  const run = sh(
    'npx',
    ['jest', '--config', './test/jest-unit.json', 'test/unit/tool/routing-chains.spec.ts'],
    BACKEND_DIR,
  );
  const counts = jestCounts(run.out);
  if (run.code !== 0 || counts.testsFailed > 0) {
    return {
      id: c.id,
      outcome: K3Outcome.FAILED,
      evidence: `routing-chains.spec.ts exited ${run.code}, ${counts.testsFailed} failed`,
      unproven: null,
    };
  }
  return {
    id: c.id,
    outcome: K3Outcome.PARTIAL,
    evidence:
      `routing-chains.spec.ts: ${counts.tests} tests green, including PAYMENT_NO_SETTLEABLE_CHAIN ` +
      'thrown when every candidate was chain-rejected, the positive control that it does NOT ' +
      'fire when candidates were rejected for other reasons, and "never dials a provider it ' +
      'chain-rejected"',
    unproven:
      'the claim "no transaction, of any kind, is submitted to EITHER chain" is not asserted. ' +
      'Nothing counts sends on both rails in one run and requires zero on each; the router ' +
      'refusing before it dials is a narrower fact than the two send ports being untouched.',
  };
};

export const STEPS: Readonly<Record<string, K3Step>> = {
  S1: runS1,
  S2: runS2,
  S3: runS3,
  S4: runS4,
  E1: runE1,
  E2: runE2,
  E3: runE3,
  E4: runE4,
  E5: runE5,
  E6: runE6,
  E7: runE7,
  E8: runE8,
};

// ── Informational: the Solana devnet suite's own coverage ───────────────────

/**
 * Report-only, and deliberately so.
 *
 * Criterion S1 requires `devnet:acceptance` to pass **unchanged**, so making it red here would
 * fail the criterion this pass exists to inform. The gap is real; closing it is Solana acceptance
 * work, separate from this harness.
 */
function printDevnetSuiteCoverage(): void {
  console.log('');
  console.log(
    "  Informational — the SOLANA devnet suite's own coverage (not one of the 12 criteria):",
  );
  console.log(
    '    3 of its 9 required bullets have no step. Deliberately report-only: S1 requires',
  );
  console.log(
    '    `devnet:acceptance` to pass UNCHANGED, so this does not fail the run. The gap is',
  );
  console.log("    real. The three with no step are the devnet suite's bullets 3, 8 and 9 — and");
  console.log('    9 ("upstream down, stake untouched") is one of the two most important.');
}

async function main(): Promise<void> {
  const report = new K3Report();
  console.log('Per-chain acceptance — every criterion is a run, not an opinion.');
  console.log(
    'Only PASSED is green. PARTIAL and NOT_RUN are not, and both must say what is unproven.',
  );
  console.log('');

  /*
    `K3_ONLY=E2` (comma-separated) runs a subset — for re-proving one step without running S1,
    which drives `devnet:acceptance` against whatever API answers on :3000. A subset is NOT an
    acceptance verdict, and says so above the footer.
  */
  const only = (process.env.K3_ONLY ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const unknown = only.filter((id) => !(id in STEPS));
  if (unknown.length > 0) {
    throw new Error(`K3_ONLY names no such step: ${unknown.join(', ')}`);
  }
  for (const id of only.length > 0 ? only : Object.keys(STEPS)) {
    await report.run(id, STEPS[id]);
  }

  if (only.length > 0) {
    console.log('');
    console.log(`  SUBSET RUN (K3_ONLY=${only.join(',')}) — not an acceptance verdict.`);
  }
  report.printFooter();
  printDevnetSuiteCoverage();
  process.exitCode = report.green() ? 0 : 1;
}

if (require.main === module) {
  void main();
}
