import { Inject, Injectable, Logger } from '@nestjs/common';

import { AgentCredentialRepository } from '@database/postgres/repositories/agent-credential.repository';
import { AgentRepository } from '@database/postgres/repositories/agent.repository';
import { PaymentIntentRepository } from '@database/postgres/repositories/payment-intent.repository';
import { ToolRepository } from '@database/postgres/repositories/tool.repository';
import { parseAccountId } from '@modules/chains/ports/caip.types';
import { agentLabelOf, toolNameOf } from '@modules/notification/domain/notice-text';
import {
  NOTIFICATION_PORT,
  NotificationEvent,
  NotificationPort,
} from '@modules/notification/ports/notification.port';

import { formatPaymentKeyAmount, paymentKeyEnding } from '../domain/payment-key-text';
import { PaymentIntent, PaymentRail } from '../ports/payment.types';

/** The grain of `payment_key.first_spend`: one per chain and key, forever (`ONCE`). */
export function paymentKeyFirstSpendDedupeKey(chainId: string, delegate: string): string {
  let address = delegate;
  try {
    address = parseAccountId(delegate).address;
  } catch {
    // Not CAIP-10: use the value as given.
  }
  const normalised = /^0x[0-9a-fA-F]+$/.test(address) ? address.toLowerCase() : address;
  return `payment-key-first-spend:${chainId}:${normalised}`;
}

/**
 * `payment_key.first_spend`: tells the account holder the first time a payment
 * key — the delegate key `assay-mcp` keeps in a computer's keychain — signs a
 * voucher that holds money (spec §7.9 "Detection", §7.10 item 6). It is the
 * signal for a stolen laptop or malware running as the user (threats T2, T12):
 * a key the person never used, spending, is the thing they need to hear about.
 *
 * "First" is decided twice. The table answers it (no earlier voucher of the
 * key held money), so a lost suppression key cannot turn this into a notice
 * per call; the catalogue's `ONCE` rule, keyed by chain and key, then keeps two
 * concurrent first vouchers to one notice.
 *
 * Called from the paid path, so `afterAdmitted` never waits and never throws:
 * the call it reports on must not be slowed or failed by the report.
 *
 * The notice names the key by its last eight characters (the fingerprint the
 * person saw when they approved it) and the credential by its name; it carries
 * no full address, token or signature.
 */
@Injectable()
export class PaymentKeyFirstSpendService {
  private readonly logger = new Logger(PaymentKeyFirstSpendService.name);

  constructor(
    private readonly intents: PaymentIntentRepository,
    @Inject(NOTIFICATION_PORT) private readonly notifications: NotificationPort,
    // Read only to name things in the body.
    private readonly credentials: AgentCredentialRepository,
    private readonly agents: AgentRepository,
    private readonly tools: ToolRepository,
  ) {}

  /** Fire and forget, for the paid path: an admitted voucher in `FUNDS_SECURED`. */
  afterAdmitted(intent: PaymentIntent): void {
    void this.notifyIfFirst(intent).catch((error: unknown) => {
      this.logger.warn(
        `First-spend check failed for intent ${intent.id}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  /**
   * Sends the notice when `intent` is its key's first voucher that held money.
   * Returns whether it asked for one (the notification service may still
   * suppress it as a duplicate).
   */
  async notifyIfFirst(intent: PaymentIntent): Promise<boolean> {
    const delegate = intent.voucherDelegate ?? null;
    if (delegate === null || intent.rail !== PaymentRail.RAIL_B_VOUCHER) return false;

    if (
      await this.intents.hasEarlierDelegateSpend(intent.organizationId, delegate, {
        id: intent.id,
        createdAt: intent.createdAt,
      })
    ) {
      return false;
    }

    const ending = paymentKeyEnding(delegate);
    const amount = formatPaymentKeyAmount(
      intent.price.amount,
      intent.price.asset,
      intent.price.decimals,
    );
    const [holder, tool] = await Promise.all([
      this.holderPhrase(intent),
      toolNameOf(this.tools, intent.toolId),
    ]);

    await this.notifications.notify({
      organizationId: intent.organizationId,
      event: NotificationEvent.PAYMENT_KEY_FIRST_SPEND,
      title: 'A payment key made its first paid call',
      body:
        `The payment key ending ${ending}${holder} paid ${amount}` +
        `${tool ? ` for "${tool}"` : ''}. This is its first paid call. ` +
        `If you did not set up paid calls on this computer, revoke the key now.`,
      subjectType: 'credential',
      subjectId: intent.credentialId ?? null,
      payload: {
        credentialId: intent.credentialId ?? null,
        agentId: intent.agentId,
        chainId: intent.chainId,
        keyEnding: ending,
        intentId: intent.id,
        toolId: intent.toolId,
        amount: intent.price.amount,
        asset: intent.price.asset,
        decimals: intent.price.decimals,
      },
      dedupeKey: paymentKeyFirstSpendDedupeKey(intent.chainId, delegate),
    });
    return true;
  }

  /** `, used by key "Laptop" of "research-bot",` — names only, best effort. */
  private async holderPhrase(intent: PaymentIntent): Promise<string> {
    const [name, label] = await Promise.all([
      this.credentialName(intent),
      agentLabelOf(this.agents, intent.organizationId, intent.agentId),
    ]);
    if (!name && !label) return '';
    const parts = [name ? `key "${name}"` : 'a key', label ? ` of "${label}"` : ''];
    return `, used by ${parts.join('')},`;
  }

  private async credentialName(intent: PaymentIntent): Promise<string | null> {
    if (!intent.credentialId) return null;
    try {
      const credential = await this.credentials.findOne({
        where: { id: intent.credentialId, organizationId: intent.organizationId },
      });
      return credential?.name?.trim() || null;
    } catch {
      return null;
    }
  }
}
