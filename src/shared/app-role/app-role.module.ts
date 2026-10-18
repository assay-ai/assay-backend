import { DynamicModule, Global, Module } from '@nestjs/common';

import { APP_ROLE, AppRole } from './app-role';

/**
 * Provides `APP_ROLE` to the whole container. Imported once, by the app
 * module: `AppRoleModule.forRoot('mcp')` or `AppRoleModule.forRoot('api')`.
 */
@Global()
@Module({})
export class AppRoleModule {
  static forRoot(role: AppRole): DynamicModule {
    return {
      module: AppRoleModule,
      global: true,
      providers: [{ provide: APP_ROLE, useValue: role }],
      exports: [APP_ROLE],
    };
  }
}
