/**
 * Read and fund the demo agent's ledger balance.
 *
 * ```bash
 * yarn mcp:ledger balance
 * yarn mcp:ledger fund 5.00
 * ```
 *
 * This is a *demo* funding path, not the product one. The product funds an agent by
 * observing an on-chain deposit and confirming it at finality; this writes the
 * `DEPOSIT` entry that path would eventually write, so the MCP loop can be
 * exercised without a devnet transfer per run. It is not wired into any
 * service and nothing but this file calls it.
 */
import { NestFactory } from '@nestjs/core';

import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { AccountId } from '@modules/chains/ports/caip.types';
import { LedgerEntryType } from '@modules/ledger/ports/ledger.types';
import { LedgerService } from '@modules/ledger/services/ledger.service';
import { MoneyUtil } from '@utils/money.util';

import { AppMcpModule } from '../../src/bootstrap/mcp/app.module';
import { DEMO_CREDENTIALS } from './demo-config';

const ASSET = ASSET_IDS.USDC_SOLANA_DEVNET;
const DECIMALS = 6;

async function main(): Promise<void> {
  const [command, amount] = process.argv.slice(2);
  const app = await NestFactory.createApplicationContext(AppMcpModule, { logger: false });
  const ledger = app.get(LedgerService);

  // `--account=<caip10> --organization=<uuid>` funds an agent that is not in
  // `credentials.json` — the public live demo's identity lives in the database rather
  // than the config snapshot, so it has no entry here to iterate over. Same
  // dev-only DEPOSIT this file already writes; the product path is still an
  // observed on-chain deposit confirmed at finality.
  const accountArg = process.argv.find((arg) => arg.startsWith('--account='));
  const orgArg = process.argv.find((arg) => arg.startsWith('--organization='));
  const targets = accountArg
    ? [
        {
          label: 'ad-hoc account',
          organizationId: (orgArg ?? '').slice('--organization='.length),
          agentAccount: accountArg.slice('--account='.length),
          fundable: true,
        },
      ]
    : DEMO_CREDENTIALS;

  if (accountArg && !orgArg) {
    throw new Error('--account requires --organization: a balance belongs to one tenant.');
  }

  for (const credential of targets) {
    if (command === 'fund' && credential.fundable) {
      const money = MoneyUtil.of(toAtomic(amount ?? '5.00'), ASSET, DECIMALS);
      await ledger.appendNow({
        organizationId: credential.organizationId,
        accountId: credential.agentAccount as AccountId,
        entryType: LedgerEntryType.DEPOSIT,
        money,
      });
    }

    const balance = await ledger.getBalance(
      credential.organizationId,
      credential.agentAccount as AccountId,
      ASSET,
    );

    console.log(
      [
        credential.label.padEnd(24),
        `available ${MoneyUtil.format(balance.available).padStart(12)}`,
        `held ${MoneyUtil.format(balance.held).padStart(12)}`,
        `total ${MoneyUtil.format(balance.total).padStart(12)}`,
      ].join('  '),
    );
  }

  // `TypeOrmCoreModule.onApplicationShutdown` looks up the *default* `DataSource`
  // token while this app registers the named `'postgres'` connection, so closing
  // an application context throws `UnknownElementException`. Pre-existing and
  // unrelated to MCP, and it only bites on shutdown, so
  // the exit is forced rather than the error being reported as a failed run.
  await app.close().catch(() => undefined);
  process.exit(0);
}

/** `"5.00"` → `"5000000"`. Display-only input, so a naive split is enough. */
function toAtomic(decimal: string): string {
  const [whole, fraction = ''] = decimal.split('.');
  return `${whole}${(fraction + '0'.repeat(DECIMALS)).slice(0, DECIMALS)}`.replace(/^0+(?=\d)/, '');
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
