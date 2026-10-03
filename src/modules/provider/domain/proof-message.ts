/**
 * The `message` and `message_version` a proof challenge row stores, from the
 * bytes the chain adapter says are signed.
 *
 * Solana's are a newline-joined text message led by a version tag, so both
 * columns come straight off the text. On eip155 the bytes are a 32-byte
 * EIP-712 digest and what the wallet signs is the typed data — so the row
 * stores the digest as `0x` hex and names the struct as its version.
 *
 * Decoding the digest as UTF-8 was the previous behaviour, and Postgres
 * refuses a 0x00 in a text column (`invalid byte sequence for encoding
 * "UTF8": 0x00`) — about one digest in eight, measured on /provider/setup.
 *
 * Chain-neutral on purpose: it keys on whether the adapter handed out typed
 * data, never on a namespace.
 */
export function renderProofMessage(
  bytes: Uint8Array,
  typedData: { readonly primaryType: string } | null,
): { message: string; messageVersion: string } {
  if (typedData) {
    return {
      message: `0x${Buffer.from(bytes).toString('hex')}`,
      messageVersion: `eip712/${typedData.primaryType}`,
    };
  }
  const message = new TextDecoder().decode(bytes);
  return { message, messageVersion: message.slice(0, message.indexOf('\n')) };
}
