import { NamespaceSlashExecutor } from '@modules/chains/multiplex/namespace-slash-executor';
import { ChainId, ChainNamespace } from '@modules/chains/ports/caip.types';
import { oneByOne, SlashExecutorPort } from '@modules/slash/ports/slash-executor.port';

const EVM = 'eip155:46630' as ChainId;
const SOL = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' as ChainId;

function fake(label: string) {
  const seen: string[] = [];
  const port = {
    seen,
    propose: async (request: { requestId: string }) => {
      seen.push(request.requestId);
      return {
        signature: label,
        status: 'PENDING',
        proposedAt: new Date(),
        executableAt: new Date(),
        reservedMinor: '1',
        adopted: false,
      };
    },
    proposeBatch: async (requests: readonly { requestId: string }[]) =>
      oneByOne(requests, (request) => port.propose(request)),
    readRecord: async () => null,
  };
  return port as unknown as SlashExecutorPort & { seen: string[] };
}

describe('NamespaceSlashExecutor', () => {
  const evm = fake('evm');
  const sol = fake('sol');
  const multiplexer = new NamespaceSlashExecutor(
    new Map<string, SlashExecutorPort>([
      [ChainNamespace.EIP155, evm],
      [ChainNamespace.SOLANA, sol],
    ]),
  );
  const request = (chainId: ChainId, requestId: string) => ({
    chainId,
    requestId,
    provider: 'p',
    beneficiary: 'b',
    penaltyMinor: '1',
    policy: 'x',
    responseClass: 'dataFail' as const,
  });

  it('routes each request by its own chain, never a default', async () => {
    await expect(multiplexer.propose(request(EVM, 'e1'))).resolves.toMatchObject({
      signature: 'evm',
    });
    await expect(multiplexer.propose(request(SOL, 's1'))).resolves.toMatchObject({
      signature: 'sol',
    });
  });

  it('splits a mixed batch by namespace and answers in request order', async () => {
    const outcomes = await multiplexer.proposeBatch([
      request(EVM, 'e2'),
      request(SOL, 's2'),
      request(EVM, 'e3'),
    ]);
    expect(outcomes.map((outcome) => outcome.result?.signature)).toEqual(['evm', 'sol', 'evm']);
  });

  it('refuses an unserved namespace before sending any group', async () => {
    const before = evm.seen.length;
    await expect(
      multiplexer.proposeBatch([request(EVM, 'e4'), request('cosmos:hub' as ChainId, 'c1')]),
    ).rejects.toMatchObject({ errorCode: 'CHAIN_UNSUPPORTED' });
    expect(evm.seen.length).toBe(before);
  });
});
