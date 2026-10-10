import { AccountId, AssetId, CHAIN_IDS, toAccountId } from '@modules/chains/ports/caip.types';
import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import { EscrowController } from '@modules/settlement/controllers/escrow.controller';
import { EscrowIntentKind } from '@modules/settlement/ports/escrow-intent-builder.port';
import {
  GasGrantRefusal,
  WithdrawGasGrant,
} from '@modules/settlement/ports/withdraw-gas-grant.port';
import {
  EscrowAccountService,
  EscrowState,
} from '@modules/settlement/services/escrow-account.service';
import {
  EscrowIntentResult,
  WithdrawalService,
} from '@modules/settlement/services/withdrawal.service';
import { MoneyUtil } from '@shared/utils/money.util';

/**
 * `POST /escrow/withdrawals/intent`'s HTTP face for the EVM withdrawal gas grant.
 *
 * Two things are only provable at this layer.
 *
 * **The recipient is the session's account.** The grant funds the account
 * `WithdrawalService` hands it, and this controller is what decides which
 * account that is. Every route here takes it from `@CurrentSession()` and none
 * takes it from the request — so a body that names somewhere else must not
 * reach the grant. `withdraw()` is the one route with an address-shaped field
 * in its body (`destination`), which makes it the one place that claim can be
 * tested rather than asserted in prose.
 *
 * **What the wire carries.** The port's `GRANTED` knows the exact wei that
 * left the relayer; the DTO does not publish it, and neither cap appears
 * anywhere in the response. See `WithdrawGasGrantDto`'s comment for the
 * reasoning — a buyer cannot act on either figure, and publishing them lets
 * anyone with a session bracket the platform's faucet in two calls.
 */

const CHAIN = CHAIN_IDS.ROBINHOOD_TESTNET;
const BUYER: AccountId = toAccountId(CHAIN, '0x5B38Da6a701c568545dCfcB03FcB875f56beddC4');
const ATTACKER = '0x000000000000000000000000000000000000dEaD';
const ASSET = `${CHAIN}/erc20:0x7E99c98e066032b2Ef5768ff18Ed090e1aB921ac` as AssetId;

const SESSION: McpSession = {
  credentialId: 'cred-1',
  organizationId: 'org-11111111-1111-4111-8111-111111111111',
  agentId: 'agent-1',
  agentAccount: BUYER,
  chainId: CHAIN,
  label: null,
};

const GRANTED_WEI = 7_200_000_000_000n;
const GRANT_HASH = `0x${'ab'.repeat(32)}`;

function escrowState(): EscrowState {
  const zero = MoneyUtil.of(0n, ASSET, 6);
  return {
    exists: true,
    account: BUYER,
    escrowPda: null,
    escrowTokenAccount: null,
    balance: zero,
    openHolds: zero,
    spendable: zero,
    withdrawRequested: zero,
    withdrawAvailableAt: null,
    serverTime: new Date().toISOString(),
    withdrawDelaySeconds: 3_600,
    maxVoucherAmount: zero,
    maxPerWindow: zero,
    spentInWindow: zero,
    windowStartedAt: null,
    windowSeconds: 86_400,
    seqHigh: '0',
    nextSeq: '1',
    observedAt: new Date().toISOString(),
    // The chain answered — `EscrowState` now says so explicitly, so that an
    // unreadable chain and a readable-but-empty escrow cannot render alike.
    chainReadable: true,
  };
}

function buildController(gasGrant: WithdrawGasGrant | null) {
  const buildIntent = jest.fn(
    async (): Promise<EscrowIntentResult> => ({
      transaction: {
        namespace: 'eip155',
        chainId: CHAIN,
        kind: 'transaction',
        to: '0x3333333333333333333333333333333333333333',
        data: '0x3ccfd60b',
        value: '0',
        from: '0x5B38Da6a701c568545dCfcB03FcB875f56beddC4',
        nonce: '4',
        gas: '60000',
        maxFeePerGas: '100000000',
        maxPriorityFeePerGas: '10000000',
      } as never,
      escrow: escrowState(),
      gasGrant,
    }),
  );

  const withdrawals = { buildIntent } as unknown as WithdrawalService;
  const escrows = { assetFor: jest.fn(async () => ASSET) } as unknown as EscrowAccountService;

  return { controller: new EscrowController(escrows, withdrawals), buildIntent };
}

describe('EscrowController — the withdrawal gas grant on the wire', () => {
  it('reports a grant as its status and its transaction hash', async () => {
    const { controller } = buildController({
      kind: 'GRANTED',
      hash: GRANT_HASH,
      wei: GRANTED_WEI,
    });

    const response = await controller.withdraw(SESSION, {});

    expect(response.gasGrant).toEqual({
      status: 'GRANTED',
      reason: null,
      transactionHash: GRANT_HASH,
    });
  });

  it('never publishes the wei that was granted, nor any cap', async () => {
    /*
      The exact figure is in the alert, in the `evm_gas_grants` row and on the
      chain — three places an operator can read it and a prober cannot. Paired
      with `ABOVE_PER_GRANT_CAP` a published wei brackets the per-grant cap in
      two calls; paired with `DAILY_CAP_REACHED` a published running total
      brackets the daily one.

      Asserted against the SERIALISED response rather than the object, because
      `toEqual` above is satisfied by an extra key whose value is `undefined`
      and `JSON.stringify` is what the buyer's browser actually receives.
    */
    const { controller } = buildController({
      kind: 'GRANTED',
      hash: GRANT_HASH,
      wei: GRANTED_WEI,
    });

    const wire = JSON.stringify(await controller.withdraw(SESSION, {}), (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    );

    expect(wire).toContain(GRANT_HASH);
    expect(wire).not.toContain(GRANTED_WEI.toString());
    expect(wire).not.toMatch(/"wei"/);
  });

  it.each([
    ['ALREADY_GRANTED', GasGrantRefusal.ALREADY_GRANTED],
    ['BUYER_HAS_GAS', GasGrantRefusal.BUYER_HAS_GAS],
    ['RELAYER_FLOAT_LOW', GasGrantRefusal.RELAYER_FLOAT_LOW],
  ])('reports the refusal %s by name, with no hash', async (_name, reason) => {
    const { controller } = buildController({ kind: 'REFUSED', reason });

    expect((await controller.withdraw(SESSION, {})).gasGrant).toEqual({
      status: 'REFUSED',
      reason,
      transactionHash: null,
    });
  });

  it('distinguishes an outage from a control firing', async () => {
    // `UNAVAILABLE` is not one of the seven refusals and must never be printed
    // as one: a refusal means the system worked.
    const { controller } = buildController({ kind: 'UNAVAILABLE' });

    expect((await controller.withdraw(SESSION, {})).gasGrant).toEqual({
      status: 'UNAVAILABLE',
      reason: null,
      transactionHash: null,
    });
  });

  it('carries null through for a chain with no gas grant', async () => {
    const { controller } = buildController(null);

    expect((await controller.withdraw(SESSION, {})).gasGrant).toBeNull();
  });

  it('builds for the SESSION account even when the body names another address', async () => {
    /*
      The degenerate this kills: a grant that funds an address of the caller's
      choosing. `destination` is the only address-shaped field a buyer can put
      on this route, and it must not become the account the platform sends ETH
      to. The controller passes `session.agentAccount` as `account` and wraps
      `destination` separately — so the account the grant is asked about is the
      buyer's own, and the builder refuses the mismatched destination on top.
    */
    const { controller, buildIntent } = buildController(null);

    await controller.withdraw(SESSION, { destination: ATTACKER });

    const [organizationId, account, , input] = buildIntent.mock.calls[0] as unknown as [
      string,
      AccountId,
      AssetId,
      { kind: EscrowIntentKind; destination: AccountId | null },
    ];

    expect(organizationId).toBe(SESSION.organizationId);
    expect(account).toBe(BUYER);
    expect(account).not.toContain(ATTACKER);
    // The named destination still travels — as a DESTINATION, which
    // `EvmEscrowIntentBuilder` then refuses because `withdraw()` pays
    // `msg.sender` and takes no destination argument.
    expect(input.destination).toBe(toAccountId(CHAIN, ATTACKER));
    expect(input.kind).toBe(EscrowIntentKind.WITHDRAW);
  });
});
