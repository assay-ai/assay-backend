import { ToolErrorCode } from '@modules/tool/errors/tool.errors';

import {
  PAYOUT_ACCOUNT,
  PAYOUT_CHAIN,
  ROUTING_CONTEXT,
  ScriptedInvoker,
  TOOL_ID,
  buildBinding,
  buildProvider,
  buildRouter,
  ok,
  status,
  usdc,
} from './helpers/routing-fixtures';

/**
 * Rail B over MCP — the router's two new obligations.
 *
 * A voucher names its provider inside the signed bytes, so the buyer has to be
 * told WHICH provider before signing (`offer`), and the call that spends the
 * voucher must be served by THAT provider and no other (`onlyProviderId`).
 * Failing over to a different provider would serve a call the signature does
 * not pay for: the chain credits `voucher.provider`, whoever answered.
 */
describe('pinning a call to the provider a voucher names', () => {
  const providers = [buildProvider('provider-a'), buildProvider('provider-b')];
  const bindings = [buildBinding('provider-a'), buildBinding('provider-b')];
  const stakes = { 'provider-a': usdc(1000), 'provider-b': usdc(1000) };

  describe('offer — choosing the payee before anything is signed', () => {
    it('names a routable provider, its payout account and the chain it settles on', async () => {
      const invoker = new ScriptedInvoker({});
      const { router } = buildRouter({ bindings, providers, stakes, invoker });

      const offer = await router.offer(TOOL_ID, ROUTING_CONTEXT);

      // `random` defaults to "always the first entry".
      expect(offer).toEqual({
        providerId: 'provider-a',
        providerAccount: PAYOUT_ACCOUNT,
        settlementChain: PAYOUT_CHAIN,
      });
    });

    it('dials nobody — an offer is not a call', async () => {
      const invoker = new ScriptedInvoker({});
      const { router } = buildRouter({ bindings, providers, stakes, invoker });

      await router.offer(TOOL_ID, ROUTING_CONTEXT);

      expect(invoker.invocations).toHaveLength(0);
    });

    it('honours the pin, so a retry names the provider already signed for', async () => {
      const invoker = new ScriptedInvoker({});
      const { router } = buildRouter({ bindings, providers, stakes, invoker });

      const offer = await router.offer(TOOL_ID, {
        ...ROUTING_CONTEXT,
        onlyProviderId: 'provider-b',
      });

      expect(offer.providerId).toBe('provider-b');
    });

    it('refuses with TOOL_NO_ELIGIBLE_BINDING when nothing is routable', async () => {
      const invoker = new ScriptedInvoker({});
      const { router } = buildRouter({ bindings, providers, stakes: {}, invoker });

      await expect(router.offer(TOOL_ID, ROUTING_CONTEXT)).rejects.toMatchObject({
        errorCode: ToolErrorCode.TOOL_NO_ELIGIBLE_BINDING,
      });
    });
  });

  describe('route — onlyProviderId', () => {
    it('serves the pinned provider even when the draw would pick another', async () => {
      const invoker = new ScriptedInvoker({
        'binding-provider-a': async () => ok(),
        'binding-provider-b': async () => ok(),
      });
      const { router } = buildRouter({ bindings, providers, stakes, invoker });

      const routed = await router.route({
        toolId: TOOL_ID,
        input: { query: 'q' },
        callId: 'call-1',
        context: { ...ROUTING_CONTEXT, onlyProviderId: 'provider-b' },
      });

      expect(routed.providerId).toBe('provider-b');
      expect(invoker.providerIds).toEqual(['provider-b']);
    });

    it('never fails over to a provider the voucher does not name', async () => {
      const invoker = new ScriptedInvoker({
        'binding-provider-a': async () => ok(),
        'binding-provider-b': async () => status(503),
      });
      const { router } = buildRouter({ bindings, providers, stakes, invoker });

      await expect(
        router.route({
          toolId: TOOL_ID,
          input: { query: 'q' },
          callId: 'call-1',
          context: { ...ROUTING_CONTEXT, onlyProviderId: 'provider-b' },
        }),
      ).rejects.toMatchObject({ errorCode: ToolErrorCode.TOOL_ALL_BINDINGS_FAILED });
      expect(invoker.providerIds).toEqual(['provider-b']);
    });

    it('refuses a pin naming a provider with no binding behind the tool', async () => {
      const invoker = new ScriptedInvoker({ 'binding-provider-a': async () => ok() });
      const { router } = buildRouter({ bindings, providers, stakes, invoker });

      await expect(
        router.route({
          toolId: TOOL_ID,
          input: { query: 'q' },
          callId: 'call-1',
          context: { ...ROUTING_CONTEXT, onlyProviderId: 'provider-z' },
        }),
      ).rejects.toMatchObject({ errorCode: ToolErrorCode.TOOL_NO_ELIGIBLE_BINDING });
      expect(invoker.invocations).toHaveLength(0);
    });
  });
});
