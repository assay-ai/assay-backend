import { AgentCredentialRepository } from '@database/postgres/repositories/agent-credential.repository';
import { SessionEvictions } from '@modules/auth/session-cache/session-evictions.service';
import { AccountId, AssetId } from '@modules/chains/ports/caip.types';
import { McpCallerKind, McpSession } from '@modules/mcp/ports/mcp-session.port';
import { EscrowDelegatesController } from '@modules/settlement/controllers/escrow-delegates.controller';
import { EscrowDelegationService } from '@modules/settlement/services/escrow-delegation.service';
import { AuditLogWriter } from '@shared/audit';

const CHAIN = 'eip155:46630';
const PAYER_ADDRESS = '0x18103e1D79257c695B2FBbd4b346CD2Ba7927296';
const DELEGATE = '0x7E99c98e066032b2Ef5768ff18Ed090e1aB921ac';
const SIGNATURE = `0x${'ab'.repeat(65)}`;
const TX = `0x${'1e'.repeat(32)}`;

const SESSION = {
  credentialId: 'login-1',
  organizationId: 'org-1',
  agentId: 'agent-1',
  agentAccount: `${CHAIN}:${PAYER_ADDRESS}` as AccountId,
  chainId: CHAIN,
  label: null,
  callerKind: McpCallerKind.HUMAN,
  paymentsAllowed: true,
} as McpSession;

function build() {
  const submit = jest.fn(async () => ({
    submission: { transactionHash: TX, blockNumber: '1', gasUsed: '1' },
    asset: `${CHAIN}/erc20:0x0` as AssetId,
    delegates: null,
  }));
  const recordAfterCommit = jest.fn(async () => undefined);
  const promotePendingDelegate = jest.fn(async (): Promise<string[]> => []);
  const evictOrganization = jest.fn(async () => undefined);
  const controller = new EscrowDelegatesController(
    { submit } as unknown as EscrowDelegationService,
    { recordAfterCommit } as unknown as AuditLogWriter,
    { promotePendingDelegate } as unknown as AgentCredentialRepository,
    { evictOrganization } as unknown as SessionEvictions,
  );
  return { controller, submit, recordAfterCommit, promotePendingDelegate, evictOrganization };
}

const SIGNED = { payer: PAYER_ADDRESS, delegate: DELEGATE, nonce: '0', deadline: '1789139970' };

/** BUG-R2-B4-01: a delegate grant or revocation the platform relayed is an audit event. */
describe('EscrowDelegatesController — audit log', () => {
  it('records signer.authorized with the granted caps, never the signature', async () => {
    const { controller, recordAfterCommit } = build();

    await controller.authorize(SESSION, {
      ...SIGNED,
      maxVoucherAmount: '2500000',
      maxPerWindow: '9000000',
      validUntil: '1789139970',
      signature: SIGNATURE,
    });

    expect(recordAfterCommit).toHaveBeenCalledTimes(1);
    expect(recordAfterCommit).toHaveBeenCalledWith({
      organizationId: 'org-1',
      actor: { type: 'user', id: 'login-1' },
      action: 'signer.authorized',
      resourceType: 'escrow_delegate',
      resourceId: `${CHAIN}:${DELEGATE}`,
      before: null,
      after: {
        maxVoucherAmount: '2500000',
        maxPerWindow: '9000000',
        validUntil: new Date(1789139970 * 1000).toISOString(),
        transactionHash: TX,
      },
    });
    expect(JSON.stringify(recordAfterCommit.mock.calls)).not.toContain(SIGNATURE);
  });

  it('records signer.revoked', async () => {
    const { controller, recordAfterCommit } = build();

    await controller.revoke(SESSION, { ...SIGNED, signature: SIGNATURE });

    expect(recordAfterCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'signer.revoked',
        resourceType: 'escrow_delegate',
        resourceId: `${CHAIN}:${DELEGATE}`,
        after: { revoked: true, transactionHash: TX },
      }),
    );
    expect(JSON.stringify(recordAfterCommit.mock.calls)).not.toContain(SIGNATURE);
  });

  it('records nothing when the relay refused', async () => {
    const { controller, submit, recordAfterCommit } = build();
    submit.mockRejectedValueOnce(new Error('refused'));

    await expect(controller.revoke(SESSION, { ...SIGNED, signature: SIGNATURE })).rejects.toThrow(
      'refused',
    );
    expect(recordAfterCommit).not.toHaveBeenCalled();
  });
});

/** D3: the payer's approval of a credential's PENDING key is what makes it the bound key. */
describe('EscrowDelegatesController — approving a pending payment key', () => {
  const AUTHORIZE = {
    ...SIGNED,
    maxVoucherAmount: '2500000',
    maxPerWindow: '9000000',
    validUntil: '1789139970',
    signature: SIGNATURE,
  };

  it('promotes the key for this organization and agent after the grant landed, and evicts sessions', async () => {
    const { controller, promotePendingDelegate, evictOrganization } = build();
    promotePendingDelegate.mockResolvedValueOnce(['cred-1']);

    const answer = await controller.authorize(SESSION, AUTHORIZE);

    expect(promotePendingDelegate).toHaveBeenCalledWith('org-1', 'agent-1', `${CHAIN}:${DELEGATE}`);
    expect(evictOrganization).toHaveBeenCalledWith('org-1');
    // The answer names who took the key (M3).
    expect(answer.promotedCredentialIds).toEqual(['cred-1']);
  });

  it('evicts nothing when no credential waited with the key, and says so', async () => {
    const { controller, evictOrganization } = build();

    const answer = await controller.authorize(SESSION, AUTHORIZE);

    expect(evictOrganization).not.toHaveBeenCalled();
    // Re-parked or discarded meanwhile: the page sees nothing was promoted.
    expect(answer.promotedCredentialIds).toEqual([]);
  });

  it('promotes nothing when the relay refused', async () => {
    const { controller, submit, promotePendingDelegate } = build();
    submit.mockRejectedValueOnce(new Error('refused'));

    await expect(controller.authorize(SESSION, AUTHORIZE)).rejects.toThrow('refused');
    expect(promotePendingDelegate).not.toHaveBeenCalled();
  });

  it('still answers the approval when the promotion fails (the old binding stays)', async () => {
    const { controller, promotePendingDelegate } = build();
    promotePendingDelegate.mockRejectedValueOnce(new Error('db down'));

    await expect(controller.authorize(SESSION, AUTHORIZE)).resolves.toMatchObject({
      transactionHash: TX,
      promotedCredentialIds: [],
    });
  });
});
