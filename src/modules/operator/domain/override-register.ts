/**
 * The operator override register, as a typed table.
 *
 * Pure. Every operator action that changes anything cites a code from here, and
 * the code decides three things the caller does not get to choose: which roles
 * may perform it, whether a second identity is required, and whether it is
 * reversible. Putting those on the action itself would mean an endpoint could
 * quietly downgrade its own approval requirement.
 *
 * ## Not every row is implemented, and the table says which
 *
 * The register enumerates 40-odd overrides across the whole platform; the
 * arbitration flow builds the slashing family and the handful of others it touches.
 * `implemented: false` rows are here anyway, on purpose — the console renders
 * the register as the list of things an operator *may* do, and a row that
 * is enumerated but exists nowhere in the code is exactly the gap this file is
 * meant to make visible. `assertImplemented` refuses to log against one.
 *
 * ## The row that is deliberately absent
 *
 * *"Deliberately, there is no row that allows a negative balance."* There is no
 * code for allowing one, and there must never be one. This precedent is the
 * whole reason this file exists: FTX's `allow_negative` was a single boolean
 * added to the balance check at one person's verbal instruction. The defence is
 * not that we would refuse to add it; it is that adding it would mean adding a
 * row here, to a file whose diff is read.
 */

/** Operator roles. Not ordered — a lead is not "an adjudicator plus one". */
export enum OperatorRole {
  /** On-call / SRE. */
  SRE = 'SRE',
  /** Adjudicator (trust & safety). */
  ADJ = 'ADJ',
  /** Adjudication lead. */
  ADJL = 'ADJL',
  /** Verification policy author. */
  POL = 'POL',
  /** Verification policy approver. */
  POLA = 'POLA',
  /** Treasury / finance ops. */
  TRE = 'TRE',
  /** Treasury approver. */
  TREA = 'TREA',
  /** Provider success / BD. */
  BD = 'BD',
  /** Support. */
  SUP = 'SUP',
  /** Compliance / legal. */
  CMP = 'CMP',
  /** Security / key custodian. */
  SEC = 'SEC',
  /**
   * Operator administrator: adds, changes and removes operators (`A-12`,
   * `A-13`, `A-14`). Added because no other role owns the directory itself —
   * `SEC` holds keys, not people — and an action that grants authority must
   * belong to a role nobody holds by accident.
   */
  OPS_ADMIN = 'OPS_ADMIN',
}

export enum OverrideFamily {
  VERIFICATION = 'V',
  POLICY = 'P',
  SLASHING = 'S',
  MONEY = 'M',
  ACCESS = 'A',
  KEYS = 'K',
}

export enum ApprovalMode {
  SINGLE = 'SINGLE',
  TWO_PERSON = 'TWO_PERSON',
  /**
   * Single-actor emergency execution. An incident cannot wait for an
   * approver at 03:00, so break-glass is permitted for a defined subset and
   * every use opens a review item. It moves the audit from before the fact to
   * after it; it does not remove it.
   */
  BREAK_GLASS = 'BREAK_GLASS',
}

export interface OverrideDefinition {
  readonly code: string;
  readonly family: OverrideFamily;
  /** The dotted past-tense action written onto the log row. */
  readonly action: string;
  readonly label: string;
  readonly roles: readonly OperatorRole[];
  readonly approval: ApprovalMode;
  /**
   * The roles the **second** identity must hold on a two-person occurrence —
   * at least one of them. Absent means the row names none, and any other
   * active operator may approve; every implemented row that is two-person, or
   * can be raised to it, names them.
   */
  readonly approverRoles?: readonly OperatorRole[];
  readonly reversible: boolean;
  /** Whether a path that can cite this code has actually been built. */
  readonly implemented: boolean;
}

const define = (d: OverrideDefinition): OverrideDefinition => Object.freeze(d);

export const OVERRIDE_REGISTER: Readonly<Record<string, OverrideDefinition>> = Object.freeze({
  // ── S · Slashing and disputes ────────────────────────────────────────────
  'S-1': define({
    code: 'S-1',
    family: OverrideFamily.SLASHING,
    action: 'slash_proposal.suspended',
    label: 'Suspend a pending slash proposal (pre-attestation)',
    roles: [OperatorRole.ADJ, OperatorRole.ADJL, OperatorRole.SRE],
    // The floor. `ArbitrationService.suspend` raises an occurrence to
    // TWO_PERSON when the case is `AWAITING_SECOND` or `UPHELD`: cancelling a
    // penalty a second person has confirmed, or is confirming, is not one
    // person's act. `approverRoles` applies to those occurrences — the checker
    // must be able to read a case, which `SRE` cannot.
    approval: ApprovalMode.SINGLE,
    approverRoles: [OperatorRole.ADJ, OperatorRole.ADJL],
    reversible: true,
    implemented: true,
  }),
  'S-2': define({
    code: 'S-2',
    family: OverrideFamily.SLASHING,
    action: 'slash_proposal.attestation_cancelled',
    label: 'Cancel an attestation inside the timelock',
    roles: [OperatorRole.ADJL],
    approval: ApprovalMode.TWO_PERSON,
    approverRoles: [OperatorRole.ADJL],
    reversible: true,
    implemented: true,
  }),
  'S-3': define({
    code: 'S-3',
    family: OverrideFamily.SLASHING,
    action: 'dispute.decided',
    label: 'Decide a dispute',
    roles: [OperatorRole.ADJ, OperatorRole.ADJL],
    // The mode on the *row* is the floor. `requiresSecondSignature` raises an
    // individual case to TWO_PERSON on blast radius or materiality; below the
    // threshold it is single review with a sampled audit, because a blanket
    // two-person rule cannot be staffed.
    approval: ApprovalMode.SINGLE,
    reversible: true,
    implemented: true,
  }),
  'S-5': define({
    code: 'S-5',
    family: OverrideFamily.SLASHING,
    action: 'slash.reversed',
    label: 'Reverse an executed slash',
    roles: [OperatorRole.ADJL, OperatorRole.TRE],
    approval: ApprovalMode.TWO_PERSON,
    // The action's own roles: whoever checks a treasury payment being
    // recorded must be somebody who could have recorded it.
    approverRoles: [OperatorRole.ADJL, OperatorRole.TRE],
    // "No — on-chain" in the register. The reversal itself is a new
    // transaction, and there is no un-reversal: the program refuses a second
    // one with `SlashAlreadyReversed`.
    reversible: false,
    implemented: true,
  }),
  'S-12': define({
    code: 'S-12',
    family: OverrideFamily.SLASHING,
    action: 'dispute.countersigned',
    label: 'Countersign or object to another adjudicator’s decision',
    roles: [OperatorRole.ADJ, OperatorRole.ADJL],
    approval: ApprovalMode.SINGLE,
    reversible: false,
    // Not in the original register, and added rather than folded into `S-3`.
    // The second signature is a distinct act by a distinct person, and
    // filing it under `S-3` would make the log read as though one case had been
    // decided twice. It also carries a different evidentiary burden: `S-3`
    // requires 120 characters because it is the decision, and a countersignature
    // that agreed with a decision already argued at length does not.
    implemented: true,
  }),
  'S-8': define({
    code: 'S-8',
    family: OverrideFamily.SLASHING,
    action: 'dispute.deadline_extended',
    label: 'Extend a dispute deadline',
    roles: [OperatorRole.ADJL],
    approval: ApprovalMode.SINGLE,
    reversible: false,
    implemented: true,
  }),
  'S-11': define({
    code: 'S-11',
    family: OverrideFamily.SLASHING,
    action: 'fleet_sweep.opened',
    label: 'Open a fleet sweep from a decided case',
    roles: [OperatorRole.ADJL],
    approval: ApprovalMode.TWO_PERSON,
    // A sweep carries one conclusion to providers who never complained, so the
    // checker has to be somebody who can read a case — not any operator who
    // can authenticate.
    approverRoles: [OperatorRole.ADJ, OperatorRole.ADJL],
    reversible: false,
    implemented: true,
  }),
  /**
   * Prepare the ARBITER's on-chain ruling (assay-evm D-19): an unsigned
   * `upholdSlashBatch` (against the provider) or `cancelSlashBatch` (for them)
   * over up to 64 records. The arbiter's wallet signs; the backend holds no
   * arbiter key. `ADJL`/`TRE`, the pair that already builds the on-chain cancel
   * and compensation intents. Logged although nothing is signed here, because
   * an operator chose which records to put before the arbiter and why.
   */
  'S-13': define({
    code: 'S-13',
    family: OverrideFamily.SLASHING,
    action: 'slash.arbiter_ruling_prepared',
    label: 'Prepare the arbiter’s on-chain uphold or cancel of disputed slash records',
    roles: [OperatorRole.ADJL, OperatorRole.TRE],
    approval: ApprovalMode.SINGLE,
    reversible: false,
    implemented: true,
  }),
  // Enumerated, not built. Each needs a resource the arbitration flow does not create.
  'S-4': define({
    code: 'S-4',
    family: OverrideFamily.SLASHING,
    action: 'penalty.waived_de_minimis',
    label: 'Waive a penalty under de-minimis',
    roles: [],
    approval: ApprovalMode.SINGLE,
    reversible: false,
    // "Automatic — rule, not a person" in the register. It is implemented, and
    // it never writes an override row precisely because no human did it; the
    // case timeline records it as a system event instead.
    implemented: false,
  }),
  'S-6': define({
    code: 'S-6',
    family: OverrideFamily.SLASHING,
    action: 'sla_window.agent_calls_excluded',
    label: "Exclude an agent's calls from an SLA window",
    roles: [OperatorRole.ADJ],
    approval: ApprovalMode.SINGLE,
    reversible: true,
    implemented: false,
  }),
  'S-7': define({
    code: 'S-7',
    family: OverrideFamily.SLASHING,
    action: 'slash.agent_excluded_from_distribution',
    label: 'Exclude an agent from slash distribution',
    roles: [OperatorRole.ADJ],
    approval: ApprovalMode.SINGLE,
    reversible: true,
    implemented: false,
  }),
  'S-9': define({
    code: 'S-9',
    family: OverrideFamily.SLASHING,
    action: 'provider.tier_adjusted',
    label: "Adjust a provider's tier manually",
    roles: [OperatorRole.ADJL, OperatorRole.BD],
    approval: ApprovalMode.TWO_PERSON,
    reversible: true,
    implemented: false,
  }),
  'S-10': define({
    code: 'S-10',
    family: OverrideFamily.SLASHING,
    action: 'agent.griefing_score_set',
    label: "Set or reset an agent's griefing score",
    roles: [OperatorRole.ADJ],
    approval: ApprovalMode.SINGLE,
    reversible: true,
    implemented: false,
  }),

  // ── V · Verification and quality ─────────────────────────────────────────
  'V-3': define({
    code: 'V-3',
    family: OverrideFamily.VERIFICATION,
    action: 'sla_window.strikes_removed',
    label: 'Remove strikes from a window',
    roles: [OperatorRole.ADJ, OperatorRole.ADJL],
    approval: ApprovalMode.SINGLE,
    reversible: true,
    implemented: true,
  }),
  'V-5': define({
    code: 'V-5',
    family: OverrideFamily.VERIFICATION,
    action: 'binding.sampling_forced_full',
    label: 'Force sampling to 100% for a binding',
    roles: [OperatorRole.ADJ, OperatorRole.POL, OperatorRole.SRE],
    approval: ApprovalMode.SINGLE,
    reversible: true,
    implemented: true,
  }),
  'V-1': define({
    code: 'V-1',
    family: OverrideFamily.VERIFICATION,
    action: 'call.reclassified',
    label: 'Reclassify one call',
    roles: [OperatorRole.SRE, OperatorRole.ADJ],
    approval: ApprovalMode.SINGLE,
    reversible: true,
    implemented: false,
  }),
  'V-2': define({
    code: 'V-2',
    family: OverrideFamily.VERIFICATION,
    action: 'calls.bulk_reclassified',
    label: 'Bulk reclassify a time range, binding or tool',
    roles: [OperatorRole.SRE],
    approval: ApprovalMode.TWO_PERSON,
    reversible: true,
    implemented: false,
  }),
  'V-4': define({
    code: 'V-4',
    family: OverrideFamily.VERIFICATION,
    action: 'call.retro_verified',
    label: 'Force retro-verification of an unsampled call',
    roles: [OperatorRole.SUP, OperatorRole.ADJ, OperatorRole.POL],
    approval: ApprovalMode.SINGLE,
    reversible: false,
    implemented: false,
  }),
  'V-6': define({
    code: 'V-6',
    family: OverrideFamily.VERIFICATION,
    action: 'verdict.overridden',
    label: 'Override a verdict for one call',
    roles: [OperatorRole.ADJL],
    approval: ApprovalMode.TWO_PERSON,
    reversible: true,
    // One of the two most dangerous rows in the register: it is the ability to
    // change quality history retroactively, and quality history is the input
    // to slashing. Not built here — arbitration decides cases, it does not
    // re-score calls.
    implemented: false,
  }),
  /**
   * Provider registration shipped `providers.verified`, its attributor and its check list, and
   * nothing has ever written any of them — registration writes `false` and no
   * other code path touches the columns. This row is that writer.
   *
   * `ADJL`/`BD` rather than the verification-policy roles `POL`/`POLA`, which
   * look like the closer fit: no operator row in this deployment holds either,
   * and roles are read from the database on every resolve, so a `POL` gate
   * would 403 every credential that exists. `S-9 provider.tier_adjusted` is the
   * register's own precedent for a provider-facing label and uses the same two.
   *
   * `SINGLE` rather than `S-9`'s `TWO_PERSON` for the same reason from the
   * other side — no second operator holds `ADJL` or `BD`, so `TWO_PERSON` would
   * be unusable — and because, unlike a tier change, this is reversible and
   * moves no money.
   */
  'V-7': define({
    code: 'V-7',
    family: OverrideFamily.VERIFICATION,
    action: 'provider.verified',
    label: 'Set or clear a provider’s verified label',
    roles: [OperatorRole.ADJL, OperatorRole.BD],
    approval: ApprovalMode.SINGLE,
    reversible: true,
    implemented: true,
  }),

  // ── P · Policy lifecycle ─────────────────────────────────────────────────
  'P-3': define({
    code: 'P-3',
    family: OverrideFamily.POLICY,
    action: 'policy.killed',
    label: 'Demote ACTIVE to SHADOW (kill switch)',
    roles: [OperatorRole.POL, OperatorRole.SRE],
    approval: ApprovalMode.BREAK_GLASS,
    reversible: true,
    // The policy panel. The kill switch itself already exists behind the
    // verification aggregator; what does not exist is the operator-facing route, and
    // building it means the policy lifecycle states it belongs to.
    implemented: false,
  }),

  // ── A · Access and routing ───────────────────────────────────────────────
  'A-2': define({
    code: 'A-2',
    family: OverrideFamily.ACCESS,
    action: 'binding.paused_by_operator',
    label: 'Suspend or pause a binding',
    roles: [OperatorRole.SRE, OperatorRole.ADJ],
    approval: ApprovalMode.SINGLE,
    reversible: true,
    // The register requires this to be distinguishable from a circuit-breaker
    // pause and from a provider-initiated one. `B-5` shipped the provider's own
    // pause with a `pause_reason` vocabulary; the operator value reuses it.
    implemented: true,
  }),
  'A-1': define({
    code: 'A-1',
    family: OverrideFamily.ACCESS,
    action: 'provider.suspended',
    label: 'Suspend a provider',
    roles: [OperatorRole.ADJL, OperatorRole.CMP],
    approval: ApprovalMode.TWO_PERSON,
    reversible: true,
    implemented: false,
  }),
  /**
   * Block an organization or a wallet — the leaked-key response.
   *
   * Numbered after the access rows the register already enumerates (`A-8` is
   * the prohibited one), not in a gap, so no code ever means two things.
   *
   * `ADJL`/`SRE`: the incident roles, the same pairing `S-1` uses for the other
   * "stop it now" action. `SRE` is on call when a key leaks at 03:00; `ADJL` is
   * who decides about an account in daylight. `SINGLE` because a block that
   * waits for a second person is a block that lands after the money moved, and
   * because it takes nobody's money — it is reversible by `A-10`.
   */
  'A-9': define({
    code: 'A-9',
    family: OverrideFamily.ACCESS,
    action: 'account.blocked',
    label: 'Block an organization or a wallet',
    roles: [OperatorRole.ADJL, OperatorRole.SRE],
    approval: ApprovalMode.SINGLE,
    reversible: true,
    implemented: true,
  }),
  /**
   * Lift a block. The asymmetry with `A-9` is the point: blocking is cheap
   * and fast because a wrong block costs an apology, while lifting the block
   * of a leaked key costs whatever the key can then spend — so the second
   * identity is demanded here and not there. The checker must be `ADJL`; the
   * maker may be the `SRE` who blocked it.
   */
  'A-10': define({
    code: 'A-10',
    family: OverrideFamily.ACCESS,
    action: 'account.unblocked',
    label: 'Lift a block on an organization or a wallet',
    roles: [OperatorRole.ADJL, OperatorRole.SRE],
    approval: ApprovalMode.TWO_PERSON,
    approverRoles: [OperatorRole.ADJL],
    reversible: true,
    implemented: true,
  }),
  /**
   * Prepare the ARBITER's on-chain block of an address (`setBlocked(a, true)`,
   * assay-evm D-19). Block only: the contract lets the arbiter block and only
   * the admin unblock, so there is no unblocking row. The incident roles of
   * `A-9` plus `TRE`, the arbiter page's other role.
   */
  'A-11': define({
    code: 'A-11',
    family: OverrideFamily.ACCESS,
    action: 'account.chain_block_prepared',
    label: 'Prepare the arbiter’s on-chain block of an address',
    roles: [OperatorRole.ADJL, OperatorRole.SRE, OperatorRole.TRE],
    approval: ApprovalMode.SINGLE,
    reversible: false,
    implemented: true,
  }),
  /**
   * The operator directory (`operators`). Who may act on this console is
   * itself an intervention, and it is recorded like one.
   *
   * Adding someone grants authority, so it is two-person: a second
   * `OPS_ADMIN` approves it through the approvals queue. Changing roles or the
   * authority limit is single-person when it only lowers them, and raised to
   * two-person for the occurrence when it adds a role or raises the limit
   * (`OperatorDirectoryService`). Removing is single-person — the safe
   * direction. Nobody acts on their own row, and an approver may not be the
   * operator being changed.
   */
  'A-12': define({
    code: 'A-12',
    family: OverrideFamily.ACCESS,
    action: 'operator.added',
    label: 'Add an operator',
    roles: [OperatorRole.OPS_ADMIN],
    approval: ApprovalMode.TWO_PERSON,
    approverRoles: [OperatorRole.OPS_ADMIN],
    reversible: true,
    implemented: true,
  }),
  'A-13': define({
    code: 'A-13',
    family: OverrideFamily.ACCESS,
    action: 'operator.changed',
    label: 'Change an operator’s roles or authority limit',
    roles: [OperatorRole.OPS_ADMIN],
    approval: ApprovalMode.SINGLE,
    approverRoles: [OperatorRole.OPS_ADMIN],
    reversible: true,
    implemented: true,
  }),
  'A-14': define({
    code: 'A-14',
    family: OverrideFamily.ACCESS,
    action: 'operator.removed',
    label: 'Remove an operator',
    roles: [OperatorRole.OPS_ADMIN],
    approval: ApprovalMode.SINGLE,
    reversible: true,
    implemented: true,
  }),
});

/** Every code, ordered by family then numerically — the console's own order. */
export const OVERRIDE_CODES: readonly string[] = Object.freeze(
  Object.keys(OVERRIDE_REGISTER).sort((a, b) => {
    const [fa, na] = a.split('-');
    const [fb, nb] = b.split('-');
    return fa === fb ? Number(na) - Number(nb) : fa.localeCompare(fb);
  }),
);

export function lookupOverride(code: string): OverrideDefinition | undefined {
  return OVERRIDE_REGISTER[code];
}

/**
 * True when `roles` contains at least one the definition names.
 *
 * A definition with an empty `roles` list is performable by nobody, which is
 * the correct reading of `S-4` ("Automatic — rule, not a person") and of
 * `A-8` ("Nobody · Prohibited"), and is why this returns false rather than
 * true on an empty list.
 */
export function rolesSatisfy(
  definition: OverrideDefinition,
  roles: readonly OperatorRole[],
): boolean {
  if (definition.roles.length === 0) return false;
  return definition.roles.some((required) => roles.includes(required));
}

/**
 * True when `roles` may approve a two-person occurrence of the definition.
 *
 * A row that names no approver roles accepts any second operator, which is the
 * rule every two-person row had before `approverRoles` existed.
 */
export function approverRolesSatisfy(
  definition: OverrideDefinition,
  roles: readonly OperatorRole[],
): boolean {
  if (!definition.approverRoles) return true;
  return definition.approverRoles.some((required) => roles.includes(required));
}
