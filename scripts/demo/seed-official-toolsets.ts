/**
 * Seed the Official tool sets for a local or e2e stack.
 *
 * ```bash
 * yarn demo:toolsets
 * ```
 *
 * Boots the MCP application context, so the catalogue seed has mirrored its
 * tools into `tools` first. `yarn demo:seed` runs the same step.
 */
import { NestFactory } from '@nestjs/core';
import { getDataSourceToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { AppMcpModule } from '../../src/bootstrap/mcp/app.module';

import { seedOfficialToolsets } from './lib/official-toolsets';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppMcpModule, { logger: false });
  const dataSource = app.get<DataSource>(getDataSourceToken('postgres'));
  const created = await seedOfficialToolsets(dataSource);
  console.log(`official tool sets: ${created} created`);
  await app.close().catch(() => undefined);
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
