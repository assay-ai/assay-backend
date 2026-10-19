import { AccountId } from '@modules/chains/ports/caip.types';
import { SlashExecutionService } from '@modules/slash/services/slash-execution.service';
import { SlashProposalStatus } from '@modules/slash/domain/slash-proposal-state';

/**
 * The beneficiary the chain is handed, and where it comes from.
 *
 * ## Why it is not resolved on this path any more
 *
 * An earlier approach set `beneficiary_account` in `openFromStrike` /
 * `openFromVerdict`. That could not work: resolving the account reads the chain
 * through `SLASH_EXECUTOR`, and proposals are opened on the SLA-window and
 * operator paths, neither of which is the scheduler. So the write moved to
 * the execution path, immediately before signing, where it also became a record
 * of what was actually signed rather than a prediction.
 *
 * The two-phase slash moved it once more, and one step earlier: `beneficiary` is a field of
 * the **proposal** attestation, so `proposeOne` resolves and persists it before
 * it signs (see `slash-execution.service.spec.ts`,
 * *"stamps the beneficiary before it signs"*). By the time a case is executable
 * the on-chain `SlashRecord` already names an account, and re-resolving here
 * could only produce a second answer — refused by the program if it checks, and
 * paying an account the judgement never authorised if it does not.
 *
 * So this file now pins the opposite property: **`executeOne` reads the stamped
 * column and never resolves.**
 *
 * ## The conversion this covers
 *
 * `slash_proposals.beneficiary_account` is CAIP-10. `SlashExecutorPort` takes a
 * bare base58 address and calls `address()` on it, which **throws** on the
 * prefixed form. This boundary is the only place the two spellings meet.
 */

const ORG = 'org-1';
const PROPOSAL_ID = 'proposal-1';
const VAULT = 'solana:dev:VaultPDA1111' as AccountId;
/** The chain the penalty is denominated on — `chainIdOf(proposal.assetId)`, written out. */
const PENALTY_CHAIN = 'solana:dev';
const STAKE_AUTHORITY = 'solana:dev:StakeAuth9999';

function proposal(overrides: Record<string, unknown> = {}) {
  return {
    id: PROPOSAL_ID,
    organizationId: ORG,
    providerId: 'provider-1',
    toolId: 'tool-1',
    assetId: 'solana:dev/token:MintAAA',
    chainRequestId: 'req-1',
    penaltyAmount: '1000000',
    // Stamped by `proposeOne`, three days before this case became executable.
    beneficiaryAccount: VAULT,
    status: SlashProposalStatus.UPHELD,
    chainStatus: 'PENDING',
    chainExecutableAt: new Date('2026-08-24T04:00:00.000Z'),
    ...overrides,
  };
}

function build() {
  const proposals = {
    findChainExecutable: jest.fn().mockResolvedValue([{ organizationId: ORG, id: PROPOSAL_ID }]),
    findOneScoped: jest.fn().mockResolvedValue(proposal()),
    transitionIfIn: jest.fn().mockResolvedValue(1),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const executor = {
    executeProposal: jest.fn().mockResolvedValue({
      signature: 'sig-1',
      appliedMinor: '900000',
      agentAmountMinor: '540000',
      platformAmountMinor: '270000',
      executedAt: new Date('2026-08-24T05:00:00.000Z'),
    }),
    reverse: jest.fn(),
    settlementTreasury: jest.fn().mockResolvedValue('solana:dev:Treasury3333' as AccountId),
  };
  const lifecycle = { appendEventDirect: jest.fn().mockResolvedValue(undefined) };
  const notifications = { notify: jest.fn().mockResolvedValue(undefined) };
  const overrides = { record: jest.fn().mockResolvedValue(undefined) };

  // The stake authority is a column on the per-chain ENROLMENT, looked
  // up for the chain the penalty's own `asset_id` names — so the executor is
  // handed collateral on the chain that is actually taking it.
  //
  // The fake answers **only** the pair it was asked for, deliberately. One that
  // answered any `findOneBy` with the same row makes the chain argument
  // unobservable: a service hardcoding a chain, or reading the provider's
  // enrolment on some other chain, would get the same authority back and every
  // assertion below would still pass. Here a wrong question returns `null` and
  // the execution refuses, which a test can see.
  const enrolments = {
    findOneBy: jest.fn(async (where: { organizationId: string; chainId: string }) =>
      where.organizationId === 'provider-1' && where.chainId === PENALTY_CHAIN
        ? {
            organizationId: 'provider-1',
            chainId: PENALTY_CHAIN,
            stakeAuthorityAccountId: STAKE_AUTHORITY,
          }
        : null,
    ),
  };

  const service = new SlashExecutionService(
    proposals as never,
    enrolments as never,
    lifecycle as never,
    overrides as never,
    notifications as never,
    { sweepBatchSize: 10 } as never,
    executor as never,
  );

  return { service, proposals, executor, enrolments };
}

describe('SlashExecutionService — the beneficiary on the execute path', () => {
  it('hands the port a bare base58 address, not the CAIP-10 column', async () => {
    const { service, executor } = build();

    await service.executeDue();

    expect(executor.executeProposal).toHaveBeenCalledWith(
      expect.objectContaining({ beneficiary: 'VaultPDA1111' }),
    );
  });

  /**
   * The bug that meant no slash had ever reached the chain: `providerId` is an
   * organization uuid and the port hands `provider` straight to `address()`,
   * which rejects it. Proved separately: `address()` throws on the uuid.
   */
  it('hands the port the provider stake authority, not the organization id', async () => {
    const { service, executor } = build();

    await service.executeDue();

    expect(executor.executeProposal).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'StakeAuth9999' }),
    );
  });

  it('uses the stamped column and never resolves a second answer', async () => {
    // The on-chain record already names an account, chosen and signed for at
    // proposal time. A beneficiary resolved now is a different question's
    // answer, and the program would either refuse it or pay it.
    const { service, executor } = build();

    await service.executeDue();

    expect(executor.executeProposal).toHaveBeenCalledWith(
      expect.objectContaining({ beneficiary: 'VaultPDA1111' }),
    );
  });

  it('refuses a case whose beneficiary was never stamped, rather than choosing one', async () => {
    // Reaching here without one means the row was written by a path that
    // skipped `proposeOne` — so there is no on-chain record to execute either,
    // and the honest answer is a refusal the next tick can retry.
    const { service, proposals, executor } = build();
    proposals.findOneScoped.mockResolvedValue(proposal({ beneficiaryAccount: null }));

    const result = await service.executeDue();

    expect(result).toEqual({ executed: 0, voided: 0, failed: 1 });
    expect(executor.executeProposal).not.toHaveBeenCalled();
    // Nothing was claimed: the refusal happens before `UPHELD → EXECUTING`, so
    // the case is not left in flight for a reconciler that has nothing to read.
    expect(proposals.transitionIfIn).not.toHaveBeenCalled();
  });

  it('refuses to execute against a provider with no proved stake authority', async () => {
    const { service, enrolments, executor, proposals } = build();
    enrolments.findOneBy.mockResolvedValue({
      organizationId: 'provider-1',
      chainId: PENALTY_CHAIN,
      stakeAuthorityAccountId: null,
    });

    const result = await service.executeDue();

    expect(result).toEqual({ executed: 0, voided: 0, failed: 1 });
    expect(executor.executeProposal).not.toHaveBeenCalled();
    // Resolved before the claim for the same reason: `readRecord` needs the
    // stake authority too, so a row stranded in `EXECUTING` by this refusal
    // could not be reconciled either.
    expect(proposals.transitionIfIn).not.toHaveBeenCalled();
  });

  it('executes a case that could never have executed before', async () => {
    const { service, executor } = build();

    const result = await service.executeDue();

    expect(result).toEqual({ executed: 1, voided: 0, failed: 0 });
    expect(executor.executeProposal).toHaveBeenCalledTimes(1);
  });
});

/**
 * Which chain's collateral a slash reaches into.
 *
 * `slash_proposals.asset_id` is CAIP-19 and names its own chain, so the
 * enrolment read is scoped to that chain and to no other. This is deliberately
 * **not** one of the settlement-chain derivation sites — the proposal's asset
 * is a record of a choice already made, not a choice being made — and the
 * enumeration in `tool/domain/routing/eligibility.ts` says so. But "not a
 * derivation site" is not "untested": nothing else in this tree
 * observes which chain is asked about, and the fake used to answer any chain
 * with the same row.
 */
describe('SlashExecutionService — the stake authority is read on the PENALTY’s chain', () => {
  it('scopes the enrolment read to chainIdOf(proposal.assetId)', async () => {
    const { service, enrolments } = build();

    await service.executeDue();

    expect(enrolments.findOneBy).toHaveBeenCalledWith({
      organizationId: 'provider-1',
      chainId: PENALTY_CHAIN,
    });
  });

  it('refuses when the provider has no enrolment on that chain', async () => {
    // Bonded elsewhere is not bonded here. A slash that fell back to another
    // chain's authority would sign an attestation against collateral the
    // settling chain cannot see — and the provider whose account it names never
    // served the call.
    const { service, enrolments, executor } = build();
    enrolments.findOneBy.mockResolvedValue(null);

    const result = await service.executeDue();

    expect(result).toEqual({ executed: 0, voided: 0, failed: 1 });
    expect(executor.executeProposal).not.toHaveBeenCalled();
  });
});
