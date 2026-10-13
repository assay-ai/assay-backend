import { Chain, createPublicClient, custom } from 'viem';

import { EgressHttpClient, INTERNAL_EGRESS_POLICY } from '@shared/network/egress';

/**
 * `createPublicClient`, with its requests issued through the egress client.
 *
 * ## Why not viem's own `http()` transport
 *
 * `installEgressLockdown` blocks any HTTP client it cannot see, and viem's
 * `http()` transport reaches global `fetch` from inside the library — a second
 * HTTP client that no source scan can read. The Solana side met the same
 * problem and its first answer was an exemption matched against the call stack.
 * That was deleted: it did not work (the call happens in a nested package, so
 * no frame carried the string) and it was forgeable five ways, including
 * `Error.prepareStackTrace = () => '@solana/kit'`, which exempts every call in
 * the process from anywhere. A stack-text match is attacker-writable and
 * cannot be a trust boundary.
 *
 * This is the durable arrangement `sanctioned-rpc.ts` names as its own
 * replacement: the request goes through {@link EgressHttpClient}, so EVM RPC
 * gets the same post-DNS address rules, pinned connect, per-hop redirect
 * re-checking and body-size and read-time caps as every other outbound call —
 * and the sanctioned scope is the one that class opens around its own socket,
 * which is the narrowest there is.
 *
 * Deliberately **no** outer `withSanctionedEgress` here. It would be redundant
 * (the egress client sanctions its own hop) and it would widen the exemption
 * from one socket to this whole function body, so a later edit that reached for
 * `fetch` inside it would be permitted instead of caught.
 *
 * ## HTTP only
 *
 * `webSocket()` is not offered: every EVM RPC call goes through the HTTP egress
 * client. `sanctioned-evm-rpc.spec.ts` holds a source lock over this directory
 * so that no file here reaches a network primitive directly.
 *
 * `httpClient` is a required argument rather than a defaulted one so that there
 * is exactly one code path: no call site can construct a client that skips the
 * egress boundary, and the module wiring has to hand over the injected
 * instance rather than quietly building a second.
 */
/**
 * A JSON-RPC error, carrying the node's numeric code and — for a revert — the
 * callee's return data.
 *
 * A class rather than a bag on `Error` so that reading `.data` is a type-checked
 * thing a caller does on purpose, instead of a property somebody hopes is there.
 */
export class EvmRpcError extends Error {
  readonly code: number;
  /**
   * The revert selector (and args), or absent. Never anything the caller sent.
   *
   * ABSENT rather than `null` when the node gave nothing usable: viem reads
   * the first error in the chain that has a `data` key, and does
   * `typeof data === 'object' ? data.data : data` — so a `null` there threw a
   * `TypeError` out of every `readContract` that reverted with empty data
   * (`0x`), which is exactly how a function the contract does not have reverts.
   * Absent, viem reports `ContractFunctionRevertedError`, and a caller probing
   * for a function an older contract lacks (`readConfigTerms`) can tell a
   * revert from an outage.
   */
  readonly data?: `0x${string}`;

  constructor(message: string, details: { code: number; data: `0x${string}` | null }) {
    super(message);
    this.name = 'EvmRpcError';
    this.code = details.code;
    if (details.data !== null) this.data = details.data;
  }
}

/**
 * `0x` + a 4-byte selector + at most four 32-byte words.
 *
 * Every error in `Errors.sol` is zero-argument, so 10 characters is the whole
 * of what this deployment ever produces. The four words of slack cover a
 * standard `Error(string)` or `Panic(uint256)` from a dependency, and the cap
 * is what stops a hostile or broken node returning a megabyte that then travels
 * as far as whoever formats the error.
 */
function boundedRevertData(data: unknown): `0x${string}` | null {
  return typeof data === 'string' && /^0x[0-9a-fA-F]{8,264}$/.test(data)
    ? (data.toLowerCase() as `0x${string}`)
    : null;
}

export function createSanctionedEvmClient(url: string, httpClient: EgressHttpClient, chain: Chain) {
  let id = 0;

  return createPublicClient({
    // Without this, viem has no multicall address and refuses every batched
    // `readContract` with `client chain not configured`. The reader batches by
    // design — one round trip per page of escrows rather than one per buyer —
    // so an unbatched fallback is not the same thing and is not wanted.
    chain,
    // `retryCount: 0`: viem retries any transport rejection it does not
    // recognise as an RPC error, so a plain revert — the answer this transport
    // returns most often once the readers land — would be re-sent three times
    // before the caller ever hears about it. A node that has already refused a
    // call does not need to be asked again, and every real retry budget on this
    // path belongs to the egress client, which owns the socket and the deadline.
    transport: custom(
      {
        async request({ method, params }) {
          id += 1;
          const response = await httpClient.request({
            url,
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
            // `INTERNAL_EGRESS_POLICY`, named rather than defaulted — the same
            // declaration `http-facilitator.adapter.ts` and
            // `kora-fee-payer.signer.ts` make, and for the same reason.
            //
            // `url` here came from `EVM_RPC_URLS`, read from `process.env` at
            // boot and never from a request, a database row or a provider,
            // which is precisely the case `EgressTrust.INTERNAL_ALLOWED`
            // documents. The default is `PUBLIC_ONLY`, and under it an
            // operator's own node on a private address is refused: measured on
            // this tree against `http://127.0.0.1:8545`, every eip155 read came
            // back `BLOCKED_ADDRESS` and `GET /escrow` degraded to
            // `chainReadable: false` with nothing on the wire saying why. An
            // EVM node inside a VPC is the ordinary production shape, so the
            // strict default made a working deployment unreachable rather than
            // closing an SSRF — nothing here is attacker-supplied.
            //
            // It relaxes the ADDRESS rule and nothing else: the scheme list,
            // the pinned connect, per-hop redirect re-checking and every limit
            // still apply, and the hop is still sanctioned by the one socket
            // `EgressHttpClient` opens.
            policy: INTERNAL_EGRESS_POLICY,
          });

          // A 502 HTML error page parses to nothing useful, and `undefined` as a
          // result reads downstream as a call that succeeded and returned
          // nothing. Refuse before decoding.
          if (response.status < 200 || response.status >= 300) {
            throw new Error(`EVM RPC ${method} failed: HTTP ${response.status}`);
          }

          const reply = JSON.parse(response.body) as {
            result?: unknown;
            error?: { code: number; message: string; data?: unknown };
          };

          if (reply.error) {
            // The node's numeric code, and nothing the node *said*. An error
            // that quotes what it was handed — or the node's own prose about it
            // — is how a key, an address or a signed payload reaches a log
            // line.
            //
            // One exception, deliberately narrow: `data` on an
            // `eth_call` error is the **callee's return data**, which for this
            // deployment is a bare 4-byte `Errors.sol` selector. It is the only
            // way to say *why* a redemption reverted, and it is not derived
            // from the request — nothing the caller sent can appear in it. It
            // is carried as a typed field rather than interpolated into the
            // message (so no formatter can print it by accident) and is
            // length-bounded, so an `Error(string)` revert cannot smuggle a
            // page of text into a log.
            throw new EvmRpcError(`EVM RPC ${method} failed: code ${reply.error.code}`, {
              code: reply.error.code,
              data: boundedRevertData(reply.error.data),
            });
          }
          return reply.result;
        },
      },
      { retryCount: 0 },
    ),
  });
}

/**
 * The client shape the rest of the EVM directory consumes.
 *
 * Inferred rather than annotated as viem's `PublicClient`: that alias defaults
 * its `account` to a different shape than `custom()` infers, and annotating it
 * makes the compiler walk viem's whole action union (`TS2589: type
 * instantiation is excessively deep`). Inferring gives the same surface and
 * keeps the transport's identity in the type.
 */
export type SanctionedEvmClient = ReturnType<typeof createSanctionedEvmClient>;
