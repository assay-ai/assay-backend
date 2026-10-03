import 'reflect-metadata';

import { DELIVERY_OBSERVER } from '@modules/notification/ports/delivery-observer.port';
import { NotificationDeliverProcessor } from '@modules/notification/processors/notification-deliver.processor';
import { NotificationWorkerModule } from '@modules/notification/notification-worker.module';
import { SlashDeliveryObserver } from '@modules/slash/services/slash-delivery-observer.service';
import { SlashOpenerModule } from '@modules/slash/slash-opener.module';

/**
 * The worker actually binds `DELIVERY_OBSERVER`.
 *
 * `notification-deliver.processor.spec.ts` injects a mock observer, so it stays
 * green whether or not anything provides the real one. The failure that test
 * cannot see is a worker that boots without the binding: Nest would refuse to
 * resolve the processor, and the visible symptom is a dead response clock —
 * exactly the bug the delivery observer was added to fix, reintroduced silently.
 *
 * **What this asserts is the declaration, not runtime resolution.** It reads the
 * real `@Module()` metadata off the real class, so deleting the provider or the
 * import turns it red; it does not boot Nest, because doing so needs Postgres,
 * Redis and a BullMQ connection, and instantiating a `@Processor()` starts a
 * live worker. Runtime resolution is proved by the worker starting at all.
 */
describe('NotificationWorkerModule wiring', () => {
  it('binds DELIVERY_OBSERVER to the slash observer', () => {
    const providers = Reflect.getMetadata('providers', NotificationWorkerModule) as unknown[];

    const binding = providers.find(
      (provider): provider is { provide: unknown; useExisting: unknown } =>
        typeof provider === 'object' && provider !== null && 'provide' in provider,
    );

    expect(binding).toBeDefined();
    expect(binding?.provide).toBe(DELIVERY_OBSERVER);
    expect(binding?.useExisting).toBe(SlashDeliveryObserver);
  });

  it('still registers the processor that consumes it', () => {
    const providers = Reflect.getMetadata('providers', NotificationWorkerModule) as unknown[];

    expect(providers).toContain(NotificationDeliverProcessor);
  });

  it('imports the module that exports the observer', () => {
    const imports = Reflect.getMetadata('imports', NotificationWorkerModule) as unknown[];

    expect(imports).toContain(SlashOpenerModule);
  });

  it('SlashOpenerModule exports the observer, or the import above buys nothing', () => {
    const exports = Reflect.getMetadata('exports', SlashOpenerModule) as unknown[];

    expect(exports).toContain(SlashDeliveryObserver);
  });
});
