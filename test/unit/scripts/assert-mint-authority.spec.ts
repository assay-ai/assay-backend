import type { Connection } from '@solana/web3.js';
import { assertMintAuthority } from '../../../scripts/devnet/lib/assert-mint-authority';

const PATH = '~/.x402-keys/devnet-operator.json';
// Real base58 addresses, not placeholders: the function builds a PublicKey
// from `mint`, so a fixture that cannot be one would force the production
// code to tolerate garbage it should reject.
const MINT = 'FG5sGnv611t2nWGK5hVw5WE5hv1HLfx7SwLCtjbuj9xR';
const OPERATOR = '6dauQmUxQCWRyDtQyczEk4rkmtjHEdh9kP82x8B6zeD4';
const SOMEBODY_ELSE = 'DVjo3Ubyy95ktGhzbAopkaGAmWPUsE6kpdpb4So1sRVt';
const conn = (value: unknown) =>
  ({ getParsedAccountInfo: async () => ({ value }) }) as unknown as Connection;
const mintAccount = (mintAuthority: string | null) => ({
  data: { program: 'spl-token', parsed: { type: 'mint', info: { mintAuthority } } },
});

describe('assertMintAuthority', () => {
  it('passes when the signer is the mint authority', async () => {
    await expect(
      assertMintAuthority(conn(mintAccount(OPERATOR)), MINT, OPERATOR, PATH),
    ).resolves.toBeUndefined();
  });

  it('refuses another key, naming both keys and the keypair file', async () => {
    const err = await assertMintAuthority(
      conn(mintAccount(SOMEBODY_ELSE)),
      MINT,
      OPERATOR,
      PATH,
    ).catch((e: Error) => e);
    expect((err as Error).message).toContain(SOMEBODY_ELSE);
    expect((err as Error).message).toContain(OPERATOR);
    expect((err as Error).message).toContain(PATH);
  });

  it('refuses a mint whose authority was revoked', async () => {
    await expect(
      assertMintAuthority(conn(mintAccount(null)), MINT, OPERATOR, PATH),
    ).rejects.toThrow(/revoked|no mint authority/i);
  });

  it('refuses an account that exists but is not a mint', async () => {
    const tokenAccount = { data: { program: 'spl-token', parsed: { type: 'account', info: {} } } };
    await expect(assertMintAuthority(conn(tokenAccount), MINT, OPERATOR, PATH)).rejects.toThrow(
      /not a mint/i,
    );
  });

  it('refuses an account that does not exist', async () => {
    await expect(assertMintAuthority(conn(null), MINT, OPERATOR, PATH)).rejects.toThrow(
      /does not exist/i,
    );
  });

  it('refuses an account whose data is not parsed', async () => {
    await expect(
      assertMintAuthority(conn({ data: Buffer.from('raw') }), MINT, OPERATOR, PATH),
    ).rejects.toThrow(/not a mint|could not be parsed/i);
  });

  it('refuses a mint address that is not base58 at all', async () => {
    await expect(
      assertMintAuthority(conn(mintAccount(OPERATOR)), 'not-a-key!', OPERATOR, PATH),
    ).rejects.toThrow();
  });
});
