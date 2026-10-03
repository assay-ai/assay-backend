# Database Module Structure

## Overview

Database module structured to support **multiple database systems**:
- **PostgreSQL** - OLTP (Online Transaction Processing) for business logic

## Directory Structure

```
src/database/
├── constants/                   # Shared constants (column types)
│   ├── column-types.ts
│   ├── typeorm-module-options.ts
│   └── index.ts
│
├── postgres/                    # PostgreSQL Module (OLTP)
│   ├── entities/                # Entity definitions
│   │   ├── abstract.entity.ts
│   │   └── post.entity.ts
│   │
│   ├── repositories/            # Repository implementations
│   │   ├── abstract.repository.ts
│   │   └── post.repository.ts
│   │
│   ├── migrations/              # PostgreSQL migrations
│   │
│   ├── postgres.data-source.ts  # TypeORM DataSource for CLI
│   ├── postgres.module.ts       # NestJS Module
│   └── index.ts                 # Barrel exports
│
├── database.module.ts           # Main Database Module
└── index.ts                     # Barrel exports
```

## PostgreSQL Module

### DataSource Configuration

**File**: `postgres/postgres.data-source.ts`

DataSource used by TypeORM CLI to:
- Generate migrations
- Run migrations
- Revert migrations

### NestJS Module

**File**: `postgres/postgres.module.ts`

Module used in runtime application.

### Repositories

All repositories inject DataSource with connection name `'postgres'`:

```typescript
@Injectable()
export class PostRepository extends AbstractRepository<PostEntity> {
  constructor(
    @InjectDataSource('postgres')
    protected readonly dataSource: DataSource
  ) {
    super(PostEntity, dataSource);
  }
}
```

## Migration Commands

### Generate Migration

```bash
yarn migration:generate AddNewColumn
```

### Create Empty Migration

```bash
yarn migration:create SeedInitialData
```

### Run Migrations

```bash
yarn build
yarn migration:run
```

### Revert Migration

```bash
yarn migration:revert
```

### Show Migration Status

```bash
yarn migration:show
```

## Documentation

- **Migration Scripts**: See `scripts/README.md`
- **TypeORM Docs**: https://typeorm.io/
- **NestJS TypeORM**: https://docs.nestjs.com/techniques/database
