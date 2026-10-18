import { OAuthClientKind } from '@database/postgres/entities/oauth-client.entity';

/**
 * Whether grants of `client` may bind a payment key and use the API host
 * (§6.3.13, owner decision H2): a `BUILTIN` row whose id is in
 * `paymentClients`, the parsed `OAUTH_PAYMENT_CLIENTS`
 * (`parsePaymentClientsEnv`), which today admits only the built-in `assay-mcp`
 * client. The kind is a belt: the parser already refuses any other id, and
 * `classify` never gives that id another kind.
 *
 * The one predicate for every place that answers this: the OAuth session
 * source (`paymentsAllowed`, which delegate binding checks), the consent page
 * (`OAuthClientRegistry.isPaymentClient`) and the credentials list
 * (`credentialClientView`), so they cannot disagree.
 */
export function isPaymentClient(
  paymentClients: readonly string[],
  client: { readonly kind: OAuthClientKind; readonly clientId: string },
): boolean {
  return client.kind === OAuthClientKind.BUILTIN && paymentClients.includes(client.clientId);
}
