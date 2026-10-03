/**
 * Exports the OpenAPI document into ./openapi.yaml.
 *
 * Boots the API module in memory (no HTTP listener) so all Swagger decorators
 * register, then calls SwaggerModule.createDocument() and writes the result.
 *
 * Invocation: `yarn openapi:export`
 *
 * Typical use: wire this into a client repo's codegen (e.g.
 * swift-openapi-generator, openapi-typescript). Optionally add a CI drift
 * guard in this repo if you commit the file.
 */

import 'reflect-metadata';
import { writeFileSync } from 'fs';
import { resolve } from 'path';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import * as yaml from 'yaml';
import { AppApiModule } from '../src/bootstrap/api/app.module';

async function exportOpenApi() {
  const app = await NestFactory.create(AppApiModule, { logger: false });

  const config = new DocumentBuilder()
    .setTitle('GoAssay.AI API')
    .setDescription('GoAssay.AI backend HTTP API. Consumed by clients via OpenAPI codegen.')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);
  const yamlOutput = yaml.stringify(document);

  const outPath = resolve(__dirname, '..', 'openapi.yaml');
  writeFileSync(outPath, yamlOutput, 'utf8');

  // TypeORM's shutdown hook is noisy when the DataSource wasn't actively used
  // by the export run. The artifact is already on disk; swallow shutdown errors.
  try {
    await app.close();
  } catch {
    /* intentionally ignored */
  }

  console.log(`✅ openapi.yaml written to ${outPath}`);
  process.exit(0);
}

void exportOpenApi().catch((error) => {
  // `logger: false` above silences Nest's own ExceptionHandler, so without this
  // catch a boot failure exits 1 having printed *nothing at all* — which is how
  // it stood while the missing `-r dotenv/config` made every run fail on an
  // unregistered asset the operator never got to see named.
  console.error('openapi export failed:', error);
  process.exit(1);
});
