#!/usr/bin/env node

/**
 * Helper script for generating migrations
 * Usage: yarn migration:generate <MigrationName>
 * Example: yarn migration:generate AddUserTable
 */

const { execSync } = require('child_process');
const path = require('path');

const migrationName = process.argv[2];

if (!migrationName) {
  console.error('❌ Error: Migration name is required');
  console.log('\nUsage:');
  console.log('  yarn migration:generate <MigrationName>');
  console.log('\nExample:');
  console.log('  yarn migration:generate AddUserTable');
  process.exit(1);
}

const migrationPath = path.join('src/database/postgres/migrations', migrationName);
const dataSourcePath = 'src/database/postgres/postgres.data-source.ts';

const command = `yarn typeorm migration:generate -d ${dataSourcePath} ${migrationPath}`;

console.log(`🔄 Generating migration: ${migrationName}`);
console.log(`📁 Path: ${migrationPath}\n`);

try {
  execSync(command, { stdio: 'inherit' });
  console.log(`\n✅ Migration generated successfully!`);
} catch (error) {
  console.error(`\n❌ Failed to generate migration`);
  process.exit(1);
}

