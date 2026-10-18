/**
 * Whether grants of `clientId` may bind a payment key and use the API host
 * (§6.3.13, owner decision H2). `paymentClients` is the parsed
 * `OAUTH_PAYMENT_CLIENTS` (`parsePaymentClientsEnv`), which today admits only
 * the built-in `assay-mcp` client.
 *
 * The one predicate for every place that answers this: the OAuth session
 * source (`paymentsAllowed`, which delegate binding checks), the consent page
 * (`OAuthClientRegistry.isPaymentClient`) and the credentials list
 * (`credentialClientView`), so they cannot disagree.
 */
export function isPaymentClient(paymentClients: readonly string[], clientId: string): boolean {
  return paymentClients.includes(clientId);
}
