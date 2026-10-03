import { EgressRequest, EgressResponse } from '@shared/network/egress';

/**
 * A stand-in for `EgressHttpClient` that records what was asked and answers
 * with whatever the test scripted.
 *
 * The recording is the point: the auth path sends an app secret over one of
 * these calls and must never send it over the other, and the only way to
 * assert that is to hold the requests and look at them.
 */
export class FakeEgressHttpClient {
  readonly requests: EgressRequest[] = [];

  constructor(
    private responder: (
      request: EgressRequest,
    ) => Promise<EgressResponse> | EgressResponse = () => {
      throw new Error('FakeEgressHttpClient: no responder configured');
    },
  ) {}

  respondWith(responder: (request: EgressRequest) => Promise<EgressResponse> | EgressResponse) {
    this.responder = responder;
    return this;
  }

  /** Convenience for the common "always the same 200" case. */
  respondJson(status: number, body: unknown) {
    return this.respondWith(() => okResponse(status, JSON.stringify(body)));
  }

  request(request: EgressRequest): Promise<EgressResponse> {
    this.requests.push(request);
    return Promise.resolve(this.responder(request));
  }

  get lastRequest(): EgressRequest | undefined {
    return this.requests[this.requests.length - 1];
  }
}

export function okResponse(status: number, body: string): EgressResponse {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body,
    bytes: Buffer.byteLength(body),
    url: 'https://auth.privy.io/',
    redirects: 0,
  };
}
