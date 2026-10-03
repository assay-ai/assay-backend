#!/usr/bin/env node

/**
 * Helper script for creating empty migrations
 * Usage: yarn migration:create <MigrationName>
 * Example: yarn migration:create SeedInitialData
 */

const { execSync } = require('child_process');
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

const migrationPath = path.join('src/database/postgres/migrations', migrationName);

const command = `yarn typeorm migration:create ${migrationPath}`;

console.log(`🔄 Creating empty migration: ${migrationName}`);
console.log(`📁 Path: ${migrationPath}\n`);

try {
  execSync(command, { stdio: 'inherit' });
  console.log(`\n✅ Migration created successfully!`);
} catch (error) {
  console.error(`\n❌ Failed to create migration`);
  process.exit(1);
}
