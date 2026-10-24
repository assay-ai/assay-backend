import type { LookupAddress } from 'node:dns';

import {
  EgressError,
  EgressFailureKind,
  EgressHttpClient,
  INTERNAL_EGRESS_POLICY,
  UNTRUSTED_EGRESS_POLICY,
  resolveEgressTarget,
} from '@shared/network/egress';
import {
  LAST_GOOD_DNS_MAX_AGE_MS,
  LastGoodDnsAnswers,
} from '@shared/network/egress/resolve-target';

/**
 * The last-good answer for a transient DNS failure (BUG-X-04).
 *
 * The guard must not get weaker: a cached answer is one that already passed
 * the same policy's address check, per host, at most 10 minutes old, used only
 * after a transient failure and one retry. A fresh answer always wins, so a
 * host that now resolves to a private address is refused as before.
 */
const PUBLIC: LookupAddress = { address: '93.184.216.34', family: 4 };
const PUBLIC_2: LookupAddress = { address: '93.184.216.35', family: 4 };
const PRIVATE: LookupAddress = { address: '10.0.0.5', family: 4 };

function dnsError(code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`getaddrinfo ${code} rpc.example.test`);
  error.code = code;
  return error;
}

/** A lookup that answers from a script, one entry per call; the last one repeats. */
function scripted(...answers: Array<LookupAddress[] | Error>) {
  let call = 0;
  return jest.fn(async (_hostname: string) => {
    const answer = answers[Math.min(call, answers.length - 1)];
    call += 1;
    if (answer instanceof Error) throw answer;
    return answer;
  });
}

async function refusal(promise: Promise<unknown>): Promise<EgressError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(EgressError);
    return error as EgressError;
  }
  throw new Error('expected a refusal');
}

describe('resolveEgressTarget — last good answer on a transient DNS failure', () => {
  let now: number;
  let cache: LastGoodDnsAnswers;
  const URL_A = 'https://rpc.example.test/';

  beforeEach(() => {
    now = 1_000_000;
    cache = new LastGoodDnsAnswers(LAST_GOOD_DNS_MAX_AGE_MS, () => now);
  });

  it('uses a fresh answer when the lookup works, and asks once', async () => {
    const lookup = scripted([PUBLIC]);
    const target = await resolveEgressTarget(URL_A, UNTRUSTED_EGRESS_POLICY, lookup, cache);
    expect(target.address).toBe(PUBLIC.address);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('retries a transient failure once and takes the fresh answer', async () => {
    const lookup = scripted(dnsError('EAI_AGAIN'), [PUBLIC_2]);
    const target = await resolveEgressTarget(URL_A, UNTRUSTED_EGRESS_POLICY, lookup, cache);
    expect(target.address).toBe(PUBLIC_2.address);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('after a retry that fails too, uses the last checked answer of that host', async () => {
    await resolveEgressTarget(URL_A, UNTRUSTED_EGRESS_POLICY, scripted([PUBLIC]), cache);
    now += 9 * 60 * 1000;

    const failing = scripted(dnsError('EAI_AGAIN'));
    const target = await resolveEgressTarget(URL_A, UNTRUSTED_EGRESS_POLICY, failing, cache);

    expect(target.address).toBe(PUBLIC.address);
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it('fails DNS_FAILED as before when the answer is older than 10 minutes', async () => {
    await resolveEgressTarget(URL_A, UNTRUSTED_EGRESS_POLICY, scripted([PUBLIC]), cache);
    now += LAST_GOOD_DNS_MAX_AGE_MS + 1;

    const error = await refusal(
      resolveEgressTarget(URL_A, UNTRUSTED_EGRESS_POLICY, scripted(dnsError('EAI_AGAIN')), cache),
    );
    expect(error.kind).toBe(EgressFailureKind.DNS_FAILED);
  });

  it('fails DNS_FAILED for a host never resolved before (no entry)', async () => {
    const lookup = scripted(dnsError('EAI_AGAIN'));
    const error = await refusal(
      resolveEgressTarget('https://nonexistent.invalid/', UNTRUSTED_EGRESS_POLICY, lookup, cache),
    );
    expect(error.kind).toBe(EgressFailureKind.DNS_FAILED);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('is per host: another host’s answer is never used', async () => {
    await resolveEgressTarget(URL_A, UNTRUSTED_EGRESS_POLICY, scripted([PUBLIC]), cache);
    const error = await refusal(
      resolveEgressTarget(
        'https://other.example.test/',
        UNTRUSTED_EGRESS_POLICY,
        scripted(dnsError('EAI_AGAIN')),
        cache,
      ),
    );
    expect(error.kind).toBe(EgressFailureKind.DNS_FAILED);
  });

  it('does not retry or reuse on a failure that is not transient', async () => {
    await resolveEgressTarget(URL_A, UNTRUSTED_EGRESS_POLICY, scripted([PUBLIC]), cache);
    const lookup = scripted(dnsError('EBADNAME'));
    const error = await refusal(resolveEgressTarget(URL_A, UNTRUSTED_EGRESS_POLICY, lookup, cache));
    expect(error.kind).toBe(EgressFailureKind.DNS_FAILED);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('never accepts a new private address: a fresh answer wins and is refused', async () => {
    await resolveEgressTarget(URL_A, UNTRUSTED_EGRESS_POLICY, scripted([PUBLIC]), cache);
    const error = await refusal(
      resolveEgressTarget(URL_A, UNTRUSTED_EGRESS_POLICY, scripted([PRIVATE]), cache),
    );
    expect(error.kind).toBe(EgressFailureKind.BLOCKED_ADDRESS);
  });

  it('stores nothing that failed the check: a refused answer is not reused later', async () => {
    await refusal(
      resolveEgressTarget(URL_A, UNTRUSTED_EGRESS_POLICY, scripted([PUBLIC, PRIVATE]), cache),
    );
    await refusal(
      resolveEgressTarget(URL_A, UNTRUSTED_EGRESS_POLICY, scripted([PUBLIC, PRIVATE]), cache),
    );
    const error = await refusal(
      resolveEgressTarget(URL_A, UNTRUSTED_EGRESS_POLICY, scripted(dnsError('EAI_AGAIN')), cache),
    );
    expect(error.kind).toBe(EgressFailureKind.DNS_FAILED);
  });

  it('keeps trust levels apart: an internal answer never serves a public-only request', async () => {
    // A private node, reached under INTERNAL_ALLOWED (the operator's own RPC).
    await resolveEgressTarget(URL_A, INTERNAL_EGRESS_POLICY, scripted([PRIVATE]), cache);

    const publicOnly = await refusal(
      resolveEgressTarget(URL_A, UNTRUSTED_EGRESS_POLICY, scripted(dnsError('EAI_AGAIN')), cache),
    );
    expect(publicOnly.kind).toBe(EgressFailureKind.DNS_FAILED);

    const internal = await resolveEgressTarget(
      URL_A,
      INTERNAL_EGRESS_POLICY,
      scripted(dnsError('EAI_AGAIN')),
      cache,
    );
    expect(internal.address).toBe(PRIVATE.address);
  });

  it('without a cache behaves as before (retry once, then DNS_FAILED)', async () => {
    const lookup = scripted(dnsError('EAI_AGAIN'));
    const error = await refusal(resolveEgressTarget(URL_A, UNTRUSTED_EGRESS_POLICY, lookup));
    expect(error.kind).toBe(EgressFailureKind.DNS_FAILED);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it.each(['ENOTFOUND', 'ENODATA', 'ECONNREFUSED', 'EAI_FAIL'])(
    'never reuses an answer on %s (a name that is gone is gone, review M-1)',
    async (code) => {
      await resolveEgressTarget(URL_A, UNTRUSTED_EGRESS_POLICY, scripted([PUBLIC]), cache);
      const lookup = scripted(dnsError(code));
      const error = await refusal(
        resolveEgressTarget(URL_A, UNTRUSTED_EGRESS_POLICY, lookup, cache),
      );
      expect(error.kind).toBe(EgressFailureKind.DNS_FAILED);
      // Not transient: no retry either.
      expect(lookup).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['ETIMEOUT', 'ETIMEDOUT', 'ESERVFAIL'])(
    'reuses the checked answer on %s',
    async (code) => {
      await resolveEgressTarget(URL_A, UNTRUSTED_EGRESS_POLICY, scripted([PUBLIC]), cache);
      const target = await resolveEgressTarget(
        URL_A,
        UNTRUSTED_EGRESS_POLICY,
        scripted(dnsError(code)),
        cache,
      );
      expect(target.address).toBe(PUBLIC.address);
    },
  );

  it('re-checks a reused answer against the guard of the request it serves', async () => {
    // An entry that holds a private address under PUBLIC_ONLY can only come
    // from a broken store; the guard still refuses it on reuse.
    cache.remember(`${UNTRUSTED_EGRESS_POLICY.trust}|rpc.example.test`, [PRIVATE]);
    const error = await refusal(
      resolveEgressTarget(URL_A, UNTRUSTED_EGRESS_POLICY, scripted(dnsError('EAI_AGAIN')), cache),
    );
    expect(error.kind).toBe(EgressFailureKind.BLOCKED_ADDRESS);
  });

  it('keeps a host in use at the newest end, so others do not push it out', () => {
    const small = new LastGoodDnsAnswers(LAST_GOOD_DNS_MAX_AGE_MS, () => now, 2);
    small.remember('a', [PUBLIC]);
    small.remember('b', [PUBLIC]);
    small.remember('a', [PUBLIC]); // resolved again
    small.remember('c', [PUBLIC]);
    expect(small.recall('a')).not.toBeNull();
    expect(small.recall('b')).toBeNull();
  });

  it('keeps at most maxEntries hosts, dropping the oldest', () => {
    const small = new LastGoodDnsAnswers(LAST_GOOD_DNS_MAX_AGE_MS, () => now, 2);
    small.remember('a', [PUBLIC]);
    small.remember('b', [PUBLIC]);
    small.remember('c', [PUBLIC]);
    expect(small.recall('a')).toBeNull();
    expect(small.recall('c')).not.toBeNull();
  });
});

describe('EgressHttpClient — the relay rule is untouched by the last-good answer', () => {
  const previous = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = previous;
  });

  it('refuses a relay hop with no relay in production without any lookup, even with a stored answer', async () => {
    process.env.NODE_ENV = 'production';
    const lookup = scripted([PUBLIC]);
    const client = new EgressHttpClient(lookup);

    const error = await refusal(
      client.request({
        url: 'https://rpc.example.test/',
        policy: { ...UNTRUSTED_EGRESS_POLICY, relay: true },
      }),
    );
    expect(error.kind).toBe(EgressFailureKind.RELAY_UNAVAILABLE);
    expect(lookup).not.toHaveBeenCalled();
  });
});
