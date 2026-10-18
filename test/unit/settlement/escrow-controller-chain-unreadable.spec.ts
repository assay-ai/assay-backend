import { AuditLogWriter } from '@shared/audit';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { AccountId, CHAIN_IDS, toAccountId } from '@modules/chains/ports/caip.types';
import { McpCallerKind, McpSession } from '@modules/mcp/ports/mcp-session.port';
import { EscrowController } from '@modules/settlement/controllers/escrow.controller';
import {
  SettlementErrorCode,
  SettlementErrors,
} from '@modules/settlement/errors/settlement.errors';
import {
  EscrowAccountService,
  EscrowState,
} from '@modules/settlement/services/escrow-account.service';
import { WithdrawalService } from '@modules/settlement/services/withdrawal.service';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';

/**
 * What the four escrow routes do when the settlement chain cannot be
 * read, measured live as four identical `500`s carrying
 * `CHAIN_ACCOUNT_LAYOUT_UNEXPECTED … Codec [u64] expected 8 bytes, got 1`.
 *
 * All four resolved `Config.stake_mint` first, which is why they answered the
 * same way. They must not answer the same way any more, and the split is not
 * "read vs write":
 *
 * ```text
 * GET  /escrow                             DEGRADES  200, chainReadable: false
 * POST /escrow/limits-intent               REFUSES   503, SETTLEMENT_ESCROW_CHAIN_UNREADABLE
 * POST /escrow/withdrawals/request-intent  REFUSES   503, SETTLEMENT_ESCROW_CHAIN_UNREADABLE
 * POST /escrow/withdrawals/intent          REFUSES   503, SETTLEMENT_ESCROW_CHAIN_UNREADABLE
 * ```
 *
 * The three `POST`s each build a transaction that **names the escrow's mint**
 * — `set_escrow_limits` and `request_withdraw` through the escrow PDA that
 * mint pins, `withdraw` through the token account it derives. There is no
 * degraded answer available to them that is not a guess, and a guessed mint on
 * `withdraw` is a payout aimed at the wrong token account. So they refuse; the
 * change is that they refuse **by name**, at a status that says "try again
 * later", instead of leaking a decoder's message at 500.
 *
 * This file is at the controller because that is the layer where the four
 * routes are four different things — the service below it cannot show that one
 * of them takes a different path from the other three.
 */

const CHAIN = CHAIN_IDS.SOLANA_DEVNET;
const BUYER: AccountId = toAccountId(CHAIN, 'BuyerAccount111111111111111111111111111111');
// The registry's own devnet entry, not a literal: the mint behind it is
// `SOLANA_DEVNET_USDC_MINT`-overridable, and a hardcoded copy of it here reads
// as unregistered the moment a deployment sets that variable.
const ASSET = ASSET_IDS.USDC_SOLANA_DEVNET;

const SESSION: McpSession = {
  credentialId: 'cred-1',
  organizationId: 'org-11111111-1111-4111-8111-111111111111',
  agentId: 'agent-1',
  agentAccount: BUYER,
  chainId: CHAIN,
  label: null,
  callerKind: McpCallerKind.CONFIG,
};

/** What `EscrowAccountService.assetFor` raises once the chain cannot be read. */
const CHAIN_UNREADABLE = SettlementErrors.escrowChainUnreadable({
  account: BUYER,
  reason:
    'On-chain account does not match the expected layout ' +
    '(JDCR4dmWRKwZoSV5kJAXpLrGh4W7zgYhURzrU4oaNciT) — expected a settlement program Config ' +
    'account, got Codec [u64] expected 8 bytes, got 1',
});

function unreadableState(): EscrowState {
  return {
    exists: null,
    account: BUYER,
    escrowPda: null,
    escrowTokenAccount: null,
    balance: null,
    openHolds: null,
    spendable: null,
    withdrawRequested: null,
    withdrawAvailableAt: null,
    serverTime: new Date().toISOString(),
    withdrawDelaySeconds: 3_600,
    maxVoucherAmount: null,
    maxPerWindow: null,
    spentInWindow: null,
    windowStartedAt: null,
    windowSeconds: 86_400,
    seqHigh: null,
    nextSeq: '7',
    observedAt: null,
    chainReadable: false,
    lifetime: null,
  };
}

function buildController(options?: { screen?: EscrowState }) {
  const escrows = {
    assetFor: jest.fn().mockRejectedValue(CHAIN_UNREADABLE),
    getForConsole: jest.fn().mockResolvedValue(options?.screen ?? unreadableState()),
    get: jest.fn(),
  } as unknown as EscrowAccountService;

  const buildIntent = jest.fn();
  const withdrawals = { buildIntent } as unknown as WithdrawalService;

  return {
    controller: new EscrowController(escrows, withdrawals, {} as AuditLogWriter),
    escrows,
    buildIntent,
  };
}

describe('the escrow routes when the settlement chain cannot be read', () => {
  describe('GET /escrow renders', () => {
    it('answers a payload marked chainReadable: false instead of raising', async () => {
      const { controller } = buildController();

      const response = await controller.get(SESSION);

      expect(response.chainReadable).toBe(false);
      expect(response.exists).toBeNull();
      expect(response.balance).toBeNull();
      // The database half of the screen still arrives — the whole reason for
      // answering at all rather than refusing.
      expect(response.account).toBe(BUYER);
      expect(response.nextSeq).toBe('7');
    });

    it('never resolves the mint on this route, so an unreadable Config cannot refuse it', async () => {
      const { controller, escrows } = buildController();

      await controller.get(SESSION);

      expect(escrows.assetFor).not.toHaveBeenCalled();
    });

    it('carries chainReadable: true through when the chain answered', async () => {
      // The degenerate version of this route is one that stamps
      // `chainReadable: false` on every response. This is the assertion that
      // kills it at the HTTP layer: the flag is the state's, not the DTO
      // mapper's.
      const readable: EscrowState = { ...unreadableState(), chainReadable: true, exists: false };
      const { controller } = buildController({ screen: readable });

      const response = await controller.get(SESSION);

      expect(response.chainReadable).toBe(true);
      expect(response.exists).toBe(false);
    });
  });

  describe('the three *-intent routes refuse, by name', () => {
    it('POST /escrow/limits-intent', async () => {
      const { controller, buildIntent } = buildController();

      await expectErrorCodeAsync(
        () =>
          controller.setLimits(SESSION, { maxVoucherAmount: '1000000', maxPerWindow: '5000000' }),
        SettlementErrorCode.SETTLEMENT_ESCROW_CHAIN_UNREADABLE,
      );
      expect(buildIntent).not.toHaveBeenCalled();
    });

    it('POST /escrow/withdrawals/request-intent', async () => {
      const { controller, buildIntent } = buildController();

      await expectErrorCodeAsync(
        () => controller.requestWithdraw(SESSION, { amount: '1000000' }),
        SettlementErrorCode.SETTLEMENT_ESCROW_CHAIN_UNREADABLE,
      );
      expect(buildIntent).not.toHaveBeenCalled();
    });

    it('POST /escrow/withdrawals/intent', async () => {
      const { controller, buildIntent } = buildController();

      await expectErrorCodeAsync(
        () => controller.withdraw(SESSION, { destination: null }),
        SettlementErrorCode.SETTLEMENT_ESCROW_CHAIN_UNREADABLE,
      );
      expect(buildIntent).not.toHaveBeenCalled();
    });

    it('refuses at 503 — try again — not at the 500 a decoder failure produced', async () => {
      const { controller } = buildController();

      let thrown: unknown;
      try {
        await controller.withdraw(SESSION, { destination: null });
      } catch (error) {
        thrown = error;
      }

      expect((thrown as { statusCode: number }).statusCode).toBe(503);
    });

    it('still builds normally when the chain answers', async () => {
      // Without this, "refuses by name" is satisfiable by a route that refuses
      // every request.
      const { controller, escrows, buildIntent } = buildController();
      (escrows.assetFor as jest.Mock).mockResolvedValue(ASSET);
      buildIntent.mockResolvedValue({
        transaction: {
          namespace: 'solana',
          chainId: CHAIN,
          kind: 'transaction',
          transactionBase64: 'ZmFrZQ==',
          feePayer: 'BuyerAccount111111111111111111111111111111',
          signers: ['BuyerAccount111111111111111111111111111111'],
          blockhash: 'HASH',
          lastValidBlockHeight: '1000',
        },
        escrow: { ...unreadableState(), chainReadable: true, exists: true },
        gasGrant: null,
      });

      const response = await controller.requestWithdraw(SESSION, { amount: '1000000' });

      expect(response.kind).toBe('REQUEST_WITHDRAW');
      expect(buildIntent).toHaveBeenCalledTimes(1);
      expect(response.escrow.chainReadable).toBe(true);
    });
  });
});
