#!/usr/bin/env node

/**
 * Helper script for creating empty migrations
 * Usage: yarn migration:create <MigrationName>
 * Example: yarn migration:create SeedInitialData
 */

const { execFileSync } = require('child_process');
const path = require('path');

const migrationName = process.argv[2];

if (!migrationName) {
  console.error('❌ Error: Migration name is required');
  console.log('\nUsage:');
  console.log('  yarn migration:create <MigrationName>');
  console.log('\nExample:');
  console.log('  yarn migration:create SeedInitialData');
  process.exit(1);
}

// The name becomes a file name and a subprocess argument, so hold it to what
// the existing migrations use: letters, digits, `-` and `_`.
if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(migrationName)) {
  console.error(
    `❌ Error: Invalid migration name "${migrationName}" (use letters, digits, - and _)`,
  );
  process.exit(1);
}

// The yarn that launched this script, run by the current node: no shell and
// no PATH lookup between the name above and typeorm's argv.
const yarnPath = process.env.npm_execpath;
if (!yarnPath) {
  console.error(`❌ Error: Run this through yarn (\`yarn migration:create <MigrationName>\`)`);
  process.exit(1);
}

const migrationPath = path.join('src/database/postgres/migrations', migrationName);

console.log(`🔄 Creating empty migration: ${migrationName}`);
console.log(`📁 Path: ${migrationPath}\n`);

try {
  execFileSync(process.execPath, [yarnPath, 'typeorm', 'migration:create', migrationPath], {
    stdio: 'inherit',
  });
  console.log(`\n✅ Migration created successfully!`);
} catch (error) {
  console.error(`\n❌ Failed to create migration`);
  process.exit(1);
}
