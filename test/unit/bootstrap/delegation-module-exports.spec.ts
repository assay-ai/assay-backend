import { MODULE_METADATA } from '@nestjs/common/constants';

import { AccountApiModule } from '@modules/account/account-api.module';
import { AccountModule } from '@modules/account/account.module';
import { AgentDelegateController } from '@modules/account/controllers/agent-delegate.controller';
import { AgentDelegateService } from '@modules/account/services/agent-delegate.service';
import { EscrowDelegatesController } from '@modules/settlement/controllers/escrow-delegates.controller';
import { EscrowDelegationService } from '@modules/settlement/services/escrow-delegation.service';
import { SettlementApiModule } from '@modules/settlement/settlement-api.module';
import { SettlementModule } from '@modules/settlement/settlement.module';

/**
 * Agent payment delegation's controllers live in the API modules and their
 * services in the domain modules, so each service has to be EXPORTED for the
 * controller to resolve. `AgentDelegateController` died at boot on exactly this
 * (an unexported `AgentDelegateService`) with every unit test green, because a
 * unit harness provides the service itself. Composing the full API graph in the
 * integration suite pulls in `McpModule`'s connections, so the wiring is pinned
 * here instead; the real boot of the API against an anvil fork proved it.
 */
describe('agent-delegation module wiring', () => {
  const meta = (module: object, key: string): unknown[] =>
    (Reflect.getMetadata(key, module) as unknown[] | undefined) ?? [];

  it.each([
    [AccountApiModule, AgentDelegateController, AccountModule, AgentDelegateService],
    [SettlementApiModule, EscrowDelegatesController, SettlementModule, EscrowDelegationService],
  ])(
    '%p mounts its controller and imports the module that exports its service',
    (api, controller, domain, service) => {
      expect(meta(api, MODULE_METADATA.CONTROLLERS)).toContain(controller);
      expect(meta(api, MODULE_METADATA.IMPORTS)).toContain(domain);
      expect(meta(domain, MODULE_METADATA.PROVIDERS)).toContain(service);
      expect(meta(domain, MODULE_METADATA.EXPORTS)).toContain(service);
    },
  );
});
