import { Module } from '@nestjs/common';

import { CREDENTIAL_VAULT_KEKS, takeVaultKeks } from './credential-vault.keys';
import { CredentialVaultService } from './credential-vault.service';

/**
 * The vault service and its key set, provided once. Imported by the provider
 * API module (console writes) and `ToolModule` (the invoker's reads) so the env
 * variable is taken in one place. `BindingCredentialRepository` comes from the
 * `@Global` `PostgresModule`.
 */
@Module({
  providers: [
    { provide: CREDENTIAL_VAULT_KEKS, useFactory: () => takeVaultKeks(process.env) },
    CredentialVaultService,
  ],
  exports: [CredentialVaultService, CREDENTIAL_VAULT_KEKS],
})
export class CredentialVaultModule {}
