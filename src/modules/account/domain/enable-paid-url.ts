/**
 * `{WEB}/agents/enable-paid?credential={id}`: the page where the payer approves
 * a credential's payment key (spec §7.10 item 2). `WEB_APP_URL` is the origin
 * (`MCP_HOST_CONFIG.webAppUrl`), never hard-coded, so each deployment points at
 * its own portal.
 *
 * With `key`, the address the page must find bound or pending on the
 * credential travels in the fragment (`#key=0x…`), which the browser never
 * sends to any server.
 */
export function enablePaidUrl(webAppUrl: string, credentialId: string, key?: string): string {
  const base = `${webAppUrl}/agents/enable-paid?credential=${encodeURIComponent(credentialId)}`;
  return key ? `${base}#key=${key}` : base;
}
