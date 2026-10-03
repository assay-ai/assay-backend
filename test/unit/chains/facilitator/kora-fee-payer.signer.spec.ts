import { KoraFeePayerSigner } from '@modules/chains/facilitator/signing/kora-fee-payer.signer';
import { FacilitatorErrorCode } from '@modules/chains/facilitator/errors/facilitator.errors';
import { BaseError } from '@shared/errors/base.error';
import {
  EgressError,
  EgressFailureKind,
  EgressHttpClient,
  EgressRequest,
  EgressResponse,
  EgressTrust,
} from '@shared/network/egress';

/**
 * The signer talks to Kora through `EgressHttpClient`, so the double is the
 * client rather than `axios` — which this file used to mock, and which the
 * signer no longer imports. There is one outbound client, and a test that mocks a second one
 * is a test asserting a code path that cannot exist.
 */
function egressDouble(request: jest.Mock): EgressHttpClient {
  return { request } as unknown as EgressHttpClient;
}

function jsonRpcResult(result: unknown): EgressResponse {
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, result }),
    bytes: 0,
    url: 'http://kora.local:8080/',
    redirects: 0,
  };
}

function jsonRpcError(message: string): EgressResponse {
  return {
    ...jsonRpcResult(null),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message } }),
  };
}

describe('KoraFeePayerSigner', () => {
  let request: jest.Mock;

  beforeEach(() => {
    request = jest.fn();
  });

  function signer(): KoraFeePayerSigner {
    return new KoraFeePayerSigner('http://kora.local:8080', 5000, egressDouble(request));
  }

  /** What was sent, decoded — the signer serialises the body itself now. */
  function sentBody(call = 0): Record<string, unknown> {
    const sent = request.mock.calls[call][0] as EgressRequest;
    return JSON.parse(String(sent.body));
  }

  it('resolves the fee payer from getConfig and caches it across calls', async () => {
    request.mockResolvedValue(
      jsonRpcResult({
        fee_payer: 'H9ityXJKWiwTni6DD5kEA1Hrqi4CSkBU4RyPx1FyHqPp',
        validation_config: {},
      }),
    );

    const kora = signer();
    expect(await kora.getFeePayerAddress()).toBe('H9ityXJKWiwTni6DD5kEA1Hrqi4CSkBU4RyPx1FyHqPp');
    expect(await kora.getFeePayerAddress()).toBe('H9ityXJKWiwTni6DD5kEA1Hrqi4CSkBU4RyPx1FyHqPp');

    expect(request).toHaveBeenCalledTimes(1);
    expect(sentBody()).toMatchObject({ method: 'getConfig' });
  });

  it('sends a transaction via signAndSendTransaction and maps snake_case to the port shape', async () => {
    request.mockResolvedValue(
      jsonRpcResult({ signature: 'SIG123', signed_transaction: 'SIGNEDTX' }),
    );

    const result = await signer().signAndSend('BASE64TX');

    expect(result).toEqual({ signature: 'SIG123', signedTransaction: 'SIGNEDTX' });
    expect(sentBody()).toMatchObject({
      method: 'signAndSendTransaction',
      params: { transaction: 'BASE64TX' },
    });
  });

  it('raises FACILITATOR_SIGNER_UNAVAILABLE when Kora answers a JSON-RPC error', async () => {
    request.mockResolvedValue(jsonRpcError('policy violation: token not allowed'));

    let thrown: unknown;
    try {
      await signer().signAndSend('BASE64TX');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BaseError);
    expect((thrown as BaseError).errorCode).toBe(
      FacilitatorErrorCode.FACILITATOR_SIGNER_UNAVAILABLE,
    );
  });

  it('raises FACILITATOR_SIGNER_UNAVAILABLE when the egress client refuses the call', async () => {
    // The realistic unreachable-Kora shape now: the guard, not the socket, is
    // what the signer sees.
    request.mockRejectedValue(
      new EgressError(EgressFailureKind.CONNECTION_FAILED, 'ECONNREFUSED: connect refused', {
        url: 'http://kora.local:8080/',
      }),
    );

    let thrown: unknown;
    try {
      await signer().getFeePayerAddress();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BaseError);
    expect((thrown as BaseError).errorCode).toBe(
      FacilitatorErrorCode.FACILITATOR_SIGNER_UNAVAILABLE,
    );
    expect((thrown as BaseError).message).toContain('EGRESS_CONNECTION_FAILED');
  });

  it('calls Kora under the internal trust level, since KORA_RPC_URL is operator config', async () => {
    // Kora is normally on 127.0.0.1 or a private address, so `PUBLIC_ONLY`
    // would refuse it. This asserts the relaxation is deliberate and narrow —
    // if this ever became the default for provider calls, every SSRF check
    // would be off.
    request.mockResolvedValue(
      jsonRpcResult({ fee_payer: 'H9ityXJKWiwTni6DD5kEA1Hrqi4CSkBU4RyPx1FyHqPp' }),
    );

    await signer().getFeePayerAddress();

    const sent = request.mock.calls[0][0] as EgressRequest;
    expect(sent.policy?.trust).toBe(EgressTrust.INTERNAL_ALLOWED);
    expect(sent.policy?.allowedProtocols).toEqual(['http:', 'https:']);
    expect(sent.policy?.limits.totalTimeoutMs).toBe(5000);
  });
});
