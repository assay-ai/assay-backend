import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The platform never pays or owes a provider (no-platform-debt design, step
 * 11's grep test). A provider is credited only by `commitHoldAndCredit`, out
 * of the buyer's own committed hold; nothing in `src/` may write a
 * `platform_absorbed:` credit any more.
 */
const SRC = join(__dirname, '../../../src');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

describe('no platform-paid provider credit', () => {
  it('nothing builds a platform_absorbed: chain ref', () => {
    const writers = sources(SRC).filter((path) => {
      const text = readFileSync(path, 'utf8');
      return (
        /`\$\{PLATFORM_ABSORBED_TX_REF_PREFIX\}/.test(text) ||
        /chainTxRef:\s*['`]platform_absorbed:/.test(text)
      );
    });
    expect(writers).toEqual([]);
  });

  it('the redemption job writes no ledger entry of its own', () => {
    const text = readFileSync(
      join(SRC, 'modules/payment/services/voucher-redemption.service.ts'),
      'utf8',
    );
    expect(text).not.toMatch(/this\.ledger\./);
    expect(text).not.toMatch(/LedgerEntryType\.PROVIDER_CREDIT/);
  });
});
