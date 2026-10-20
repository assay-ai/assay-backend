import { getAddress } from 'viem';

import { AccountId, CHAIN_IDS } from '@modules/chains/ports/caip.types';
import { McpCallerKind, McpSession } from '@modules/mcp/ports/mcp-session.port';
import {
  ASSAY_APP_SENTENCE,
  allocateOfferSeq,
  fundingFixUrl,
  unaffordableOnRedeem,
  VoucherRequirement,
  checksummedRequirement,
  delegationHint,
  delegationTerms,
  escrowNotOpenNotice,
  paymentKeyNotice,
} from '@modules/mcp/services/mcp-tool-call.service';
import { PaymentErrorCode, PaymentErrors } from '@modules/payment/errors/payment.errors';
import { AppError } from '@shared/errors/app-errors';
import { EscrowDelegationService } from '@modules/settlement/services/escrow-delegation.service';

const EVM = CHAIN_IDS.ROBINHOOD_TESTNET;
const PAYER = `${EVM}:0x18103e1D79257c695B2FBbd4b346CD2Ba7927296` as AccountId;
const DELEGATE = `${EVM}:0x5555555555555555555555555555555555555555` as AccountId;

const session = (overrides: Partial<McpSession> = {}): McpSession => ({
  credentialId: 'cred-1',
  organizationId: 'org-1',
  agentId: 'agent-1',
  agentAccount: PAYER,
  chainId: EVM,
  label: null,
  callerKind: McpCallerKind.AGENT,
  paymentsAllowed: true,
  storedCredential: true,
  ...overrides,
});

const WEB = 'https://app.assay.test';
const CREDENTIAL = '7b0c5f8e-3d2a-4b6c-9e1f-0a1b2c3d4e5f';

/**
 * PAYMENT_REQUIRED on eip155 tells the agent who may sign: the payer (the
 * user's escrow), a delegate the payer authorised on chain, or the payer's
 * EIP-1271 wallet — and which delegate key is bound to this credential.
 */
describe('rail-B PAYMENT_REQUIRED — agent payment delegation', () => {
  it('names the accepted signers and the bound delegate on eip155', () => {
    expect(delegationTerms(session({ delegateAccount: DELEGATE }))).toEqual({
      signers: ['payer', 'delegate'],
      delegate: DELEGATE,
    });
    expect(delegationHint(session({ delegateAccount: DELEGATE }))).toContain(DELEGATE);
    expect(delegationHint(session({ delegateAccount: DELEGATE }))).toContain(PAYER);
  });

  it('prints the payer and the delegate in EIP-55, as the requirement names them', () => {
    const lower = session({
      agentAccount: PAYER.toLowerCase() as AccountId,
      delegateAccount: DELEGATE.toLowerCase() as AccountId,
    });
    expect(delegationHint(lower)).toContain(PAYER);
    expect(delegationHint(lower)).not.toContain(PAYER.toLowerCase());
    expect(delegationHint(session({ agentAccount: PAYER.toLowerCase() as AccountId }))).toContain(
      PAYER,
    );
  });

  it('says how to bind a delegate when none is bound', () => {
    expect(delegationTerms(session())).toEqual({
      signers: ['payer', 'delegate'],
      delegate: null,
    });
    expect(delegationHint(session())).toContain('POST /agents/me/delegate');
  });

  it('adds nothing on Solana, whose escrow has no delegation', () => {
    const solana = session({
      chainId: CHAIN_IDS.SOLANA_DEVNET,
      agentAccount:
        `${CHAIN_IDS.SOLANA_DEVNET}:Agent1111111111111111111111111111111111111` as AccountId,
    });
    expect(delegationTerms(solana)).toEqual({});
    expect(delegationHint(solana)).toBe('');
  });
});

/**
 * The enable-paid link on PAYMENT_REQUIRED (spec §7.10 item 2, R-PAY-4, H2):
 * only on eip155, only with no delegate bound, and only for a payment client.
 */
describe('rail-B PAYMENT_REQUIRED — the enable-paid fixUrl', () => {
  it('payment client, no delegate → fixUrl exact and sentence appended', () => {
    const notice = paymentKeyNotice(session({ credentialId: CREDENTIAL }), WEB);
    const fixUrl = `${WEB}/agents/enable-paid?credential=${CREDENTIAL}`;
    expect(notice).toEqual({
      fixUrl,
      sentence: ` Paid calls need a payment key on your computer: ${fixUrl}`,
    });
  });

  it('third-party grant → no fixUrl, "Paid tools need the Assay app on your computer."', () => {
    const notice = paymentKeyNotice(
      session({ credentialId: CREDENTIAL, paymentsAllowed: false }),
      WEB,
    );
    expect(notice).toEqual({
      fixUrl: null,
      sentence: ' Paid tools need the Assay app on your computer.',
    });
    expect(ASSAY_APP_SENTENCE).toBe(' Paid tools need the Assay app on your computer.');
  });

  it('fails closed: paymentsAllowed missing or not exactly true → no fixUrl', () => {
    for (const paymentsAllowed of [undefined, 'true', 1, null]) {
      const notice = paymentKeyNotice(
        session({ credentialId: CREDENTIAL, paymentsAllowed: paymentsAllowed as never }),
        WEB,
      );
      expect(notice).toEqual({ fixUrl: null, sentence: ASSAY_APP_SENTENCE });
    }
  });

  it('no stored credential (a person or config session) or no WEB_APP_URL → no fixUrl', () => {
    expect(paymentKeyNotice(session({ storedCredential: undefined }), WEB).fixUrl).toBeNull();
    expect(paymentKeyNotice(session({ credentialId: CREDENTIAL }), undefined).fixUrl).toBeNull();
  });

  it('delegate bound → no fixUrl and no sentence, for any client', () => {
    for (const paymentsAllowed of [true, false]) {
      expect(
        paymentKeyNotice(session({ delegateAccount: DELEGATE, paymentsAllowed }), WEB),
      ).toEqual({ fixUrl: null, sentence: '' });
    }
  });

  it('nothing on Solana', () => {
    const solana = session({
      chainId: CHAIN_IDS.SOLANA_DEVNET,
      agentAccount:
        `${CHAIN_IDS.SOLANA_DEVNET}:Agent1111111111111111111111111111111111111` as AccountId,
    });
    expect(paymentKeyNotice(solana, WEB)).toEqual({ fixUrl: null, sentence: '' });
  });

  /**
   * `paymentKeyNotice` is pure: it reads the session and the web origin only.
   * The evidence for the whole paid path is the integration spy on the
   * chain's `readContract` in the equivalence suite (third-party T5 case).
   */
  it('no chain adapter call on this path (spy)', () => {
    const list = jest.spyOn(EscrowDelegationService.prototype, 'list');
    try {
      paymentKeyNotice(session({ credentialId: CREDENTIAL }), WEB);
      paymentKeyNotice(session({ paymentsAllowed: false }), WEB);
      expect(list).not.toHaveBeenCalled();
    } finally {
      list.mockRestore();
    }
  });
});

/**
 * Every eip155 address an agent is asked to sign is EIP-55: `assay-mcp`'s
 * signer accepts no other spelling (Task 2.3, M5).
 */
/**
 * A buyer who never deposited has no escrow row, so no seq and no offer: the
 * refusal says where to open the escrow instead of leaving a dead end.
 */
describe('rail-B offer with no escrow — where to fund it', () => {
  const notOpen = () => PaymentErrors.escrowNotOpen({ account: PAYER });

  it('payment client → {WEB}/funding as fixUrl and in the text', () => {
    const error = escrowNotOpenNotice(notOpen(), session(), WEB) as AppError;
    expect(error.errorCode).toBe(PaymentErrorCode.PAYMENT_ESCROW_NOT_OPEN);
    expect(error.message).toBe(
      `No escrow is open for this account: ${PAYER}. Add funds to open it, then call again: ${WEB}/funding`,
    );
    expect(error.context).toMatchObject({ fixUrl: `${WEB}/funding` });
  });

  it('third-party grant or no WEB_APP_URL → the Assay app sentence and no fixUrl', () => {
    for (const [s, web] of [
      [session({ paymentsAllowed: false }), WEB],
      [session({ paymentsAllowed: undefined }), WEB],
      [session(), undefined],
    ] as const) {
      const error = escrowNotOpenNotice(notOpen(), s, web) as AppError;
      expect(error.message).toBe(
        `No escrow is open for this account: ${PAYER}. Paid tools need the Assay app on your computer.`,
      );
      expect(error.context?.fixUrl).toBeUndefined();
    }
  });

  it('any other error, or one carrying a reason, passes through unchanged', () => {
    const other = new Error('boom');
    expect(escrowNotOpenNotice(other, session(), WEB)).toBe(other);
    const withReason = PaymentErrors.escrowNotOpen({ account: PAYER, reason: 'chain unreachable' });
    expect(escrowNotOpenNotice(withReason, session(), WEB)).toBe(withReason);
  });
});

/**
 * BUG-A-05: a buyer who never deposited must still get PAYMENT_REQUIRED on
 * eip155, so the agent reaches the one enable-paid link (F4) instead of a
 * separate funding detour. The row is recorded only where opening costs nothing.
 */
describe('rail-B offer seq for a buyer who never deposited', () => {
  const ASSET = `${EVM}/erc20:0x915e5d10c1b03b4f4c7e1f1d3b2a8c6f7e9d0a1b` as never;
  const ESCROW = `${EVM}:0x9999999999999999999999999999999999999999` as AccountId;

  function deps(opened: boolean) {
    const state = { opened };
    const seqs = {
      allocate: jest.fn(async () => {
        if (!state.opened) throw PaymentErrors.escrowNotOpen({ account: PAYER });
        return { seq: '1', escrowPda: ESCROW, escrowTokenAccount: ESCROW };
      }),
      recordUnfunded: jest.fn(async () => {
        state.opened = true;
      }),
    };
    const escrow = {
      escrowAddresses: jest.fn(async () => ({ escrowPda: ESCROW, escrowTokenAccount: ESCROW })),
    };
    return { seqs, escrow };
  }

  it('eip155: records the mirror row, then allocates', async () => {
    const d = deps(false);
    await expect(allocateOfferSeq(d, session(), ASSET, null)).resolves.toMatchObject({ seq: '1' });
    expect(d.seqs.recordUnfunded).toHaveBeenCalledWith({
      organizationId: 'org-1',
      accountId: PAYER,
      assetId: ASSET,
      escrowAccountId: ESCROW,
      escrowAssetAccountId: ESCROW,
    });
    expect(d.seqs.allocate).toHaveBeenCalledTimes(2);
  });

  it('a buyer with an escrow row: allocates once and records nothing', async () => {
    const d = deps(true);
    await allocateOfferSeq(d, session(), ASSET, 4n);
    expect(d.seqs.allocate).toHaveBeenCalledWith('org-1', PAYER, 4n);
    expect(d.seqs.recordUnfunded).not.toHaveBeenCalled();
  });

  it('Solana: the refusal stands and nothing is recorded (opening is a paid transaction)', async () => {
    const d = deps(false);
    const solana = session({
      chainId: CHAIN_IDS.SOLANA_DEVNET,
      agentAccount:
        `${CHAIN_IDS.SOLANA_DEVNET}:Agent1111111111111111111111111111111111111` as AccountId,
    });
    await expect(allocateOfferSeq(d, solana, ASSET, null)).rejects.toMatchObject({
      errorCode: PaymentErrorCode.PAYMENT_ESCROW_NOT_OPEN,
    });
    expect(d.seqs.recordUnfunded).not.toHaveBeenCalled();
  });

  it('any other refusal (blocked, chain unreadable) passes through and records nothing', async () => {
    const d = deps(false);
    const blocked = new Error('blocked');
    d.seqs.allocate.mockRejectedValueOnce(blocked);
    await expect(allocateOfferSeq(d, session(), ASSET, null)).rejects.toBe(blocked);
    const unreadable = PaymentErrors.escrowNotOpen({ account: PAYER, reason: 'rpc down' });
    d.seqs.allocate.mockRejectedValueOnce(unreadable);
    await expect(allocateOfferSeq(d, session(), ASSET, null)).rejects.toBe(unreadable);
    expect(d.seqs.recordUnfunded).not.toHaveBeenCalled();
  });

  it('an account another organization holds is refused, not adopted', async () => {
    const d = deps(false);
    const claimed = PaymentErrors.escrowAccountClaimed({ account: PAYER });
    d.seqs.recordUnfunded.mockRejectedValueOnce(claimed);
    await expect(allocateOfferSeq(d, session(), ASSET, null)).rejects.toBe(claimed);
    expect(d.seqs.allocate).toHaveBeenCalledTimes(1);
  });
});

/**
 * BUG-A-05, after enabling: a payer who turned paid calls on before any deposit
 * is told to add funds, with the link, rather than "no escrow is open".
 */
describe('rail-B redemption against an escrow with no funds', () => {
  it('a never-funded escrow and a short balance are both "add funds"', () => {
    expect(unaffordableOnRedeem(PaymentErrors.escrowNotOpen({ account: PAYER }))).toBe(true);
  });

  it('a chain that could not be read is not', () => {
    expect(
      unaffordableOnRedeem(PaymentErrors.escrowNotOpen({ account: PAYER, reason: 'rpc down' })),
    ).toBe(false);
    expect(unaffordableOnRedeem(new Error('boom'))).toBe(false);
  });

  it('the funding link goes to a payment client only', () => {
    expect(fundingFixUrl(session(), WEB)).toBe(`${WEB}/funding`);
    expect(fundingFixUrl(session({ paymentsAllowed: false }), WEB)).toBeNull();
    expect(fundingFixUrl(session(), undefined)).toBeNull();
  });
});

describe('rail-B PAYMENT_REQUIRED — EIP-55 addresses', () => {
  const lower = (account: string) => account.toLowerCase();
  const ASSET = `${EVM}/erc20:0x915e5d10c1b03b4f4c7e1f1d3b2a8c6f7e9d0a1b`;
  const requirement = (overrides: Partial<VoucherRequirement> = {}): VoucherRequirement => ({
    rail: 'B',
    scheme: 'voucher',
    network: EVM,
    payer: lower(PAYER) as AccountId,
    payTo: `${EVM}:0x8ba1f109551bd432803012645ac136ddd64dba72` as AccountId,
    provider: `${EVM}:0xab5801a7d398351b8be11c439e05c5b3259aec9b` as AccountId,
    providerId: 'provider-1',
    amount: { amount: '1000', asset: ASSET as never, decimals: 6 },
    resource: '/mcp/tools/get_weather',
    requestHash: `sha256:${'0'.repeat(64)}`,
    seq: '7',
    maxTimeoutSeconds: 300,
    signers: ['payer', 'delegate'],
    delegate: lower(DELEGATE) as AccountId,
    ...overrides,
  });

  it('checksums payTo, asset, payer, provider and delegate', () => {
    expect(checksummedRequirement(requirement())).toEqual({
      ...requirement(),
      payer: PAYER,
      payTo: `${EVM}:0x8ba1f109551bD432803012645Ac136ddd64DBA72`,
      provider: `${EVM}:0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B`,
      amount: {
        amount: '1000',
        asset: `${EVM}/erc20:${getAddress('0x915e5d10c1b03b4f4c7e1f1d3b2a8c6f7e9d0a1b')}`,
        decimals: 6,
      },
      delegate: DELEGATE,
    });
  });

  it('keeps the asset namespace lower case and a null delegate null', () => {
    const out = checksummedRequirement(requirement({ delegate: null }));
    expect(out.delegate).toBeNull();
    expect(out.amount.asset).toMatch(/\/erc20:0x/);
  });

  it('is idempotent on checksummed input', () => {
    const once = checksummedRequirement(requirement());
    expect(checksummedRequirement(once)).toEqual(once);
  });

  it('leaves a Solana requirement unchanged', () => {
    const solana = requirement({
      network: CHAIN_IDS.SOLANA_DEVNET,
      payer: `${CHAIN_IDS.SOLANA_DEVNET}:Agent1111111111111111111111111111111111111` as AccountId,
    });
    expect(checksummedRequirement(solana)).toBe(solana);
  });
});
