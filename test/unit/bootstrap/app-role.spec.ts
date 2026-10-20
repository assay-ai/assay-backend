import { DynamicModule, Inject, Injectable, Module, Optional, Type } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';

import { AppApiModule } from '@bootstrap/api/app.module';
import { AppMcpModule } from '@bootstrap/mcp/app.module';
import { AppRoleModule } from '@shared/app-role/app-role.module';
import { APP_ROLE, AppRole, DEFAULT_APP_ROLE, resolveAppRole } from '@shared/app-role/app-role';

// `bull-board.module.ts` has a type error ts-jest reports and the build does not;
// the API app imports it, and it has nothing to do with the role.
jest.mock('../../../src/bull-board/bull-board.module', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Module } = require('@nestjs/common');
  class BullBoardConfigModule {}
  Module({})(BullBoardConfigModule);
  return { BullBoardConfigModule };
});

@Injectable()
class RoleProbe {
  readonly role: AppRole;

  constructor(@Optional() @Inject(APP_ROLE) role?: AppRole) {
    this.role = resolveAppRole(role);
  }
}

/** The `AppRoleModule.forRoot(...)` an app module imports. */
function roleModuleOf(app: Type): DynamicModule {
  const imports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, app) ?? []) as unknown[];
  const found = imports.filter(
    (entry): entry is DynamicModule =>
      typeof entry === 'object' &&
      entry !== null &&
      (entry as DynamicModule).module === AppRoleModule,
  );
  expect(found).toHaveLength(1);
  return found[0];
}

/** Resolve the role as a provider in a module importing `imports` sees it. */
async function roleSeenWith(imports: DynamicModule[]): Promise<AppRole> {
  @Module({ providers: [RoleProbe] })
  class Consumer {}

  const moduleRef = await Test.createTestingModule({ imports: [...imports, Consumer] }).compile();
  return moduleRef.get(RoleProbe).role;
}

describe('APP_ROLE', () => {
  it("the MCP app resolves APP_ROLE === 'mcp'", async () => {
    await expect(roleSeenWith([roleModuleOf(AppMcpModule)])).resolves.toBe('mcp');
  });

  it("the API app resolves APP_ROLE === 'api'", async () => {
    await expect(roleSeenWith([roleModuleOf(AppApiModule)])).resolves.toBe('api');
  });

  it("a module without the provider gets 'api' through the optional default", async () => {
    expect(DEFAULT_APP_ROLE).toBe('api');
    await expect(roleSeenWith([])).resolves.toBe('api');
  });

  it('is global, so a consumer does not import it', () => {
    expect(roleModuleOf(AppMcpModule).global).toBe(true);
    expect(roleModuleOf(AppMcpModule).exports).toContain(APP_ROLE);
  });
});
