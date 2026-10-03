# Migration Scripts

Helper scripts for generating database migrations.

## Migration Strategy

This project uses a **unified migration approach** with **separate database modules**:
- Build once → compile TypeScript to JavaScript
- **PostgreSQL**: Run migrations using compiled `dist/database/postgres/postgres.data-source.js`
- **TimescaleDB** (future): Will use separate data source for time-series data
- Same commands work for both development and production

## Available Scripts

### 1. `migration-generate.js`
Generates a new migration by comparing entity definitions with the current database schema.

**Usage:**
```bash
yarn migration:generate <MigrationName>
```

**Example:**
```bash
yarn migration:generate AddUserTable
```

**What it does:**
- Compares TypeScript entities with database schema
- Generates migration with `up` and `down` methods
- Saves to `src/database/postgres/migrations/`

### 2. `migration-create.js`
Creates an empty migration file for manual migration code.

**Usage:**
```bash
yarn migration:create <MigrationName>
```

**Example:**
```bash
yarn migration:create SeedInitialData
```

**What it does:**
- Creates empty migration template
- Useful for data migrations or complex schema changes
- Saves to `src/database/postgres/migrations/`

## Complete Workflow

### Development Workflow

```bash
# 1. Modify entity files
# Edit src/database/postgres/entities/*.entity.ts

# 2. Generate migration
yarn migration:generate AddNewColumn

# 3. Review generated migration
# Check src/database/postgres/migrations/<timestamp>-AddNewColumn.ts

# 4. Build project (REQUIRED)
yarn build

# 5. Run migration
yarn migration:run

# 6. Start dev server
yarn start:api:dev

# 7. If needed, revert
yarn migration:revert
```

### Production Workflow

```bash
# 1. Build the project
yarn install --production
yarn build

# 2. Deploy files to server
rsync -av dist/ node_modules/ package.json .env user@server:/app/

# 3. On production server
ssh user@server
cd /app

# 4. Run migrations
yarn migration:run

# 5. Start services
yarn start:api:prod
```

## Key Points

### ✅ Do This

1. **Always build before running migrations:**
```bash
yarn build
yarn migration:run
```

2. **Deploy complete package:**
```bash
# Include all of these:
dist/
node_modules/
package.json
.env
```

3. **Use same commands everywhere:**
```bash
# Development
yarn build && yarn migration:run

# Production
yarn build && yarn migration:run
```

### ❌ Don't Do This

1. **Don't skip building:**
```bash
# ❌ Wrong - data-source.js doesn't exist yet
yarn migration:run
```

2. **Don't deploy only dist/:**
```bash
# ❌ Wrong - missing package.json and node_modules
rsync dist/ server:/app/
```

3. **Don't maintain separate dev/prod scripts:**
```bash
# ❌ No longer needed
yarn migration:run:dev
yarn migration:run:prod
```

## File Structure

```
scripts/
├── README.md                    # This file
├── migration-generate.js        # Generate migration from entities
└── migration-create.js          # Create empty migration

src/database/
├── constants/                   # Shared database constants
├── postgres/                    # PostgreSQL module (OLTP)
│   ├── postgres.data-source.ts  # PostgreSQL DataSource (for CLI)
│   ├── postgres.module.ts       # PostgreSQL NestJS module
│   ├── entities/                # PostgreSQL entity definitions
│   ├── repositories/            # PostgreSQL repositories
│   └── migrations/              # PostgreSQL migrations (.ts)
├── timescale/                   # TimescaleDB module (OLAP) - Future
│   └── ...
└── database.module.ts           # Main database module

dist/database/                   # Created after 'yarn build'
└── postgres/
    ├── postgres.data-source.js  # Used by migration:run
    ├── entities/                # Compiled entities
    └── migrations/              # Compiled migrations (.js)
```

## Available Commands

```bash
# Generate migration from entity changes
yarn migration:generate <Name>

# Create empty migration template
yarn migration:create <Name>

# Run pending migrations (uses dist/data-source.js)
yarn migration:run

# Revert last migration (uses dist/data-source.js)
yarn migration:revert

# Show migration status (uses dist/data-source.js)
yarn migration:show
```

## Environment Variables

Required for all migration commands:

```bash
NODE_ENV=production              # Optional, but recommended in production
DATABASE_HOST=localhost
DATABASE_PORT=5432
DATABASE_USER=postgres
DATABASE_PASSWORD=postgres
DATABASE_NAME=starter_db
```

## Troubleshooting

### Error: "Cannot find module 'data-source.js'"

**Problem:** Project not built yet.

**Solution:**
```bash
yarn build
```

### Error: "relation already exists"

**Problem:** Migration already applied or partially applied.

**Solution:**
```bash
# Check migration status
yarn migration:show

# If needed, revert and try again
yarn migration:revert
yarn migration:run
```

### Error: "Cannot connect to database"

**Problem:** Database credentials incorrect or database not running.

**Solution:**
```bash
# Check environment variables
cat .env | grep DATABASE

# Test database connection
psql -h $DATABASE_HOST -U $DATABASE_USER -d $DATABASE_NAME
```

### Error: "typeorm: command not found"

**Problem:** Dependencies not installed.

**Solution:**
```bash
yarn install
```

## Why This Approach?

### ✅ Benefits

1. **Consistency** - Same workflow for dev and production
2. **Simplicity** - One set of commands, not two
3. **Safety** - Use compiled code, same as runtime
4. **Predictability** - What works in dev works in prod

### Before (Complex)

```bash
# Development
yarn migration:run  # Uses .ts files

# Production
yarn migration:run:prod  # Uses .js files
```

**Problem:** Different code paths, potential inconsistencies

### After (Simple)

```bash
# Both environments
yarn build
yarn migration:run  # Always uses .js files
```

**Benefit:** One code path, consistent behaviour across environments

## Best Practices

1. **Always review generated migrations** before running them
2. **Test migrations in staging** before production
3. **Backup database** before running migrations in production
4. **Build before migrating** - ensure compiled code is up-to-date
5. **Never modify existing migrations** that have been deployed
6. **Write reversible migrations** with proper `down()` methods
7. **Keep migrations small** - one logical change per migration

## CI/CD Integration

### GitHub Actions Example

```yaml
- name: Build and Migrate
  run: |
    yarn install --production
    yarn build
    yarn migration:run
  env:
    DATABASE_HOST: ${{ secrets.DATABASE_HOST }}
    DATABASE_PASSWORD: ${{ secrets.DATABASE_PASSWORD }}
```

### Docker Example

```dockerfile
FROM node:18-alpine

WORKDIR /app

# Install dependencies
COPY package.json yarn.lock ./
RUN yarn install --production

# Copy source and build
COPY src ./src
COPY tsconfig.json nest-cli.json ./
RUN yarn build

# Run migrations on startup, then start app
CMD yarn migration:run && node dist/main.js
```

## Support

For more information:
- **Architecture:** See `docs/architecture.md`
- **TypeORM Documentation:** https://typeorm.io/migrations
- **Project README:** `README.md`


