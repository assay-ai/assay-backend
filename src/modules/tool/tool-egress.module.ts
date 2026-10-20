import { Global, Module } from '@nestjs/common';

import { CredentialVaultModule } from '@modules/provider/credentials/credential-vault.module';
import { takeEnvSigningKeys } from '@modules/verification/signing/backends/env-key-source';
import { NetworkModule } from '@shared/network/network.module';

import { BINDING_INVOKER } from './ports/binding-invoker.port';
import { RequestSignerService } from './request-auth/request-signer.service';
import {
  PROVIDER_REQUEST_SIGNING_KEYS_ENV,
  REQUEST_SIGNING_KEYS,
} from './request-auth/request-signing.keys';
import { EgressBindingInvoker } from './services/egress-binding.invoker';

/**
 * The provider call itself: the invoker, the request signer and the credential
 * vault it reads at dial time.
 *
 * Kept out of `ToolModule` so that only the processes that dial providers need
 * `PROVIDER_REQUEST_SIGNING_KEYS` and `CREDENTIAL_VAULT_KEKS`. `ToolModule` is
 * also reached by the scheduler (slash case briefs, toolset sweeps — quotes and
 * catalogue reads, never a call), and pulling the secrets into that graph would
 * make the scheduler fail its boot in production for keys it never uses.
 *
 * Imported by `AppApiModule` (the mapping tester, the public demo, the JWKS
 * route) and `AppMcpModule` (`tools/call`). `@Global` so the router in
 * `ToolModule` resolves `BINDING_INVOKER` without `ToolModule` importing this:
 * in a process that does not import it, `ProviderRouterService.route` refuses
 * loudly instead of the boot failing for an unused secret.
 */
@Global()
@Module({
  imports: [NetworkModule, CredentialVaultModule],
  providers: [
    // Ed25519 request signing: keys read once from the environment and deleted from it.
    {
      provide: REQUEST_SIGNING_KEYS,
      useFactory: () => takeEnvSigningKeys(process.env, PROVIDER_REQUEST_SIGNING_KEYS_ENV),
    },
    RequestSignerService,
    EgressBindingInvoker,
    { provide: BINDING_INVOKER, useExisting: EgressBindingInvoker },
  ],
  exports: [BINDING_INVOKER, REQUEST_SIGNING_KEYS, RequestSignerService],
})
export class ToolEgressModule {}
