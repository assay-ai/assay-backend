import { CatalogueController } from '@modules/catalogue/controllers/catalogue.controller';
import { CatalogueService } from '@modules/catalogue/services/catalogue.service';
import { McpSession } from '@modules/mcp/ports/mcp-session.port';

/**
 * B16: the provider routes answer `servesYou` for the CALLER's organization,
 * taken from the session and never from the request.
 */
describe('CatalogueController, servesYou is the caller’s', () => {
  const session = { organizationId: 'org-caller' } as McpSession;

  function wired() {
    const service = {
      listProvidersFor: jest.fn(async () => ({ providers: [] })),
      getProviderFor: jest.fn(async () => ({ providerId: 'p1', tools: [] })),
    } as unknown as CatalogueService;
    return { service, controller: new CatalogueController(service) };
  }

  it('lists providers for the session’s organization', async () => {
    const { service, controller } = wired();
    await controller.listProviders(session);
    expect(service.listProvidersFor).toHaveBeenCalledWith('org-caller');
  });

  it('answers one provider for the session’s organization', async () => {
    const { service, controller } = wired();
    await controller.getProvider({ providerId: 'p1' }, session);
    expect(service.getProviderFor).toHaveBeenCalledWith('p1', 'org-caller');
  });
});
