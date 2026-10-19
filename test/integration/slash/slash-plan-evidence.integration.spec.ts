import { randomUUID } from 'node:crypto';

import { getAddress, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { DataSource } from 'typeorm';

import { EvmSlashExecutor } from '@modules/chains/evm/evm-slash-executor.service';
import {
  NamespaceSlashCapsReader,
  NamespaceSlashExecutor,
} from '@modules/chains/multiplex/namespace-slash-executor';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { ChainNamespace } from '@modules/chains/ports/caip.types';
import { slashPartRequestId } from '@modules/slash/domain/prorata-slash';
import { Secp256k1EnvSigner } from '@modules/verification/signing/backends/secp256k1-env.signer';

import {
  CHAIN,
  DEPLOYMENT,
  FakeStakeChain,
  MULTICALL,
} from '../../unit/chains/evm/helpers/fake-stake-chain';
import {
  buildProRataSlashServices,
  freshMigratedDatabase,
  ProRataSlashServices,
} from '../helpers/slash-prorata-context';
import { seedProRataCase } from '../helpers/slash-prorata-seed';

/**
 * G7 on EVM, end to end over a real Postgres built from every migration:
 * a window-level SLA case is proposed as one verifier-signed attestation per
 * harmed agent (pro rata by the price of their DATA_FAIL calls), in ONE
 * Multicall3 batch, waits out both clocks, and executes — every due case's
 * parts in one batch — paying each agent 60% of its part and the treasury
 * 30%, with nothing booked to the ledger.
 *
 * The chain is `FakeStakeChain`, an emulator of the `AssayStake` rules the
 * executor depends on (signature recovery, replay lock, caps, 72h door,
 * 60/30 split). Everything else is production code.
 */
const DATABASE = 'assay_slash_plan_evidence_test';
const USDG = `${CHAIN}/erc20:0xDbbC156dD414f43f2c952C1Be0f16A0B9a826Cd3`;
const VERIFIER_SECRET = new Uint8Array(32).fill(5);
const VERIFIER = privateKeyToAccount(toHex(VERIFIER_SECRET)).address;
const PROVIDER = '0xA271A3407D3302f4b4Fbe469b9188487cedd7d45';
const PROVIDER_2 = '0x2222222222222222222222222222222222222223';
const A = `${CHAIN}:0x976ea74026e726554db657fa54763abd0c3a0aa9`;
const B = `${CHAIN}:0x64fecbe18e8998cb2990bce631a042f8e2be1659`;
const C = `${CHAIN}:0xd30814fd3916fc7fc6ea87d4c429f7b0b7cc4d1d`;
const D = `${CHAIN}:0x1111111111111111111111111111111111111114`;

/**
 * Review H-2, against a real Postgres and the fake stake chain: a stored plan
 * is re-checked against the window evidence before anything is signed. The
 * attack is a database edit between planning and signing; here the plan is
 * written straight to `slash_proposal_parts`, as an earlier attempt that never
 * reached the chain would have left it.
 */
describe('a stored slash plan is checked against its evidence before signing', () => {
  let dataSource: DataSource;
  let chain: FakeStakeChain;
  let services: ProRataSlashServices;

  beforeAll(async () => {
    dataSource = await freshMigratedDatabase(DATABASE);
  }, 300_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    // Every case left by an earlier test would be swept again by this one.
    await dataSource.query(
      `TRUNCATE slash_proposal_parts, slash_proposal_events, slash_proposals, sla_strikes,
         sla_window_calls, sla_windows, tool_bindings, payment_intents, provider_chain_enrolments
       CASCADE`,
    );
    chain = new FakeStakeChain(VERIFIER);
    chain.bond(PROVIDER, 180_000_000n, 20_000_000n, 1_000_000n);
    chain.bond(PROVIDER_2, 150_000_000n);
    const backend = new Secp256k1EnvSigner(
      [{ keyId: 'v1', chainId: CHAIN, secretKey: Uint8Array.from(VERIFIER_SECRET) }],
      'test',
    );
    const signer = {
      async sign(request: { payload: Uint8Array }) {
        const signature = await backend.sign('v1', request.payload);
        await chain.trustSignature(toHex(request.payload), toHex(signature));
        return { signature, publicKey: (await backend.getKey('v1')).publicKey };
      },
      async publicKey() {
        return (await backend.getKey('v1')).publicKey;
      },
    };
    const evm = new EvmSlashExecutor(
      new Map([[CHAIN, chain.client]]),
      new Map([[CHAIN, DEPLOYMENT]]),
      chain.relayer,
      { get: () => signer },
      'VerifierSigningService',
      {
        now: () => Number(chain.now) * 1000,
        batchSize: 20,
        multicall: new Map([[CHAIN, MULTICALL]]),
        receiptRetryDelayMs: 0,
      },
    );
    services = buildProRataSlashServices(
      dataSource,
      new NamespaceSlashExecutor(new Map([[ChainNamespace.EIP155, evm]])),
      new NamespaceSlashCapsReader(new Map([[ChainNamespace.EIP155, evm]])),
    );
  });

  const load = async (seeded: { organizationId: string; proposalId: string }) =>
    (await services.proposals.findOneScoped(seeded.organizationId, seeded.proposalId))!;

  const nowOf = () => new Date(Number(chain.now) * 1000);
  const multicallSends = () =>
    chain.sent.filter((tx) => getAddress(tx.to) === getAddress(MULTICALL));

  async function seedWindow(penalty: bigint, provider = PROVIDER) {
    return seedProRataCase(dataSource, {
      providerOrg: randomUUID(),
      stakeAuthority: `${CHAIN}:${provider}`,
      assetId: USDG,
      penalty,
      proposedAt: new Date(nowOf().getTime() - 60_000),
      agents: [
        { account: A, failed: [100_000n, 100_000n, 100_000n], passed: [100_000n] },
        { account: B, failed: [100_000n] },
        { account: C, failed: [50_000n, 50_000n] },
        // Served well: in the window, never a beneficiary.
        { account: D, failed: [], passed: [100_000n] },
        // A failure priced in another asset is not weighed in this one.
        { account: D, failed: [100_000n], assetId: ASSET_IDS.USDC_SOLANA_DEVNET },
      ],
    });
  }

  /** The plan the evidence produces for `seedWindow(250_001n)`, as rows. */
  async function storePlan(
    seeded: {
      organizationId: string;
      proposalId: string;
      windowId: string;
      chainRequestId: string;
    },
    edit: (row: Record<string, string>) => void = () => undefined,
  ) {
    const rows = [
      [B, '100000', '50000'],
      [A, '300000', '150001'],
      [C, '100000', '50000'],
    ].map(([account, weight, share]) => {
      const row: Record<string, string> = {
        windowId: seeded.windowId,
        agentAccount: account,
        beneficiaryAccount: account,
        weightAmount: weight,
        uncappedShareAmount: share,
        penaltyAmount: share,
        planPenaltyAmount: '250001',
        planCappedTotal: '250001',
        capBinding: 'NONE',
        chainRequestId: slashPartRequestId(seeded.windowId, seeded.chainRequestId, account),
        chainStatus: 'NONE',
      };
      edit(row);
      return row;
    });
    await services.partsRepository.insertPlan(
      seeded.organizationId,
      seeded.proposalId,
      0,
      rows as never,
    );
  }

  const refusedEvents = async (proposalId: string) =>
    (
      (await dataSource.query(
        `SELECT count(*)::int AS n FROM slash_proposal_events WHERE proposal_id = $1 AND kind = 'PLAN_REFUSED'`,
        [proposalId],
      )) as { n: number }[]
    )[0].n;

  it('signs an untouched stored plan', async () => {
    const seeded = await seedWindow(250_001n);
    await storePlan(seeded);

    expect(await services.execution.proposeDue(nowOf())).toEqual({
      proposed: 1,
      refused: 0,
      failed: 0,
    });
    expect(multicallSends()).toHaveLength(1);
    expect(await refusedEvents(seeded.proposalId)).toBe(0);
  });

  it.each([
    [
      'a beneficiary changed to an outsider',
      (row: Record<string, string>) => {
        if (row.agentAccount === A)
          row.beneficiaryAccount = `${CHAIN}:0x00000000000000000000000000000000000000ee`;
      },
    ],
    [
      'a penalty raised above its share',
      (row: Record<string, string>) => {
        if (row.agentAccount === A) row.penaltyAmount = '200000';
      },
    ],
    [
      'an agent with no failed call in the window',
      (row: Record<string, string>) => {
        if (row.agentAccount === C) {
          row.agentAccount = D;
          row.beneficiaryAccount = D;
        }
      },
    ],
  ])('signs and sends nothing for %s, and flags the case', async (_label, edit) => {
    const seeded = await seedWindow(250_001n);
    await storePlan(seeded, edit);

    expect(await services.execution.proposeDue(nowOf())).toEqual({
      proposed: 0,
      refused: 0,
      failed: 1,
    });
    expect(chain.sent).toHaveLength(0);
    const proposal = await load(seeded);
    expect(proposal.chainLastError).toBe('SLASH_PLAN_EVIDENCE_MISMATCH');
    expect(proposal.chainStatus).toBe('PROPOSING');
    expect(await refusedEvents(seeded.proposalId)).toBe(1);
  });

  it('counts only calls to this provider as evidence', async () => {
    const seeded = await seedWindow(250_001n);
    // Agent A's failed calls re-routed (on paper) to another provider: A is
    // no longer a payer of this provider, so its part is refused.
    await dataSource.query(
      `UPDATE payment_intents SET provider_id = $2
        WHERE agent_account = $1 AND provider_id = $3`,
      [A, randomUUID(), seeded.organizationId],
    );
    await storePlan(seeded);

    expect(await services.execution.proposeDue(nowOf())).toEqual({
      proposed: 0,
      refused: 0,
      failed: 1,
    });
    expect(chain.sent).toHaveLength(0);
  });
});
