import 'reflect-metadata';
import { MODULE_METADATA } from '@nestjs/common/constants';

import { McpModule } from '@modules/mcp/mcp.module';
import { McpCallRecorder } from '@modules/mcp/services/mcp-call-recorder.service';
import { NOTIFICATION_PORT } from '@modules/notification/ports/notification.port';

/**
 * `McpCallRecorder` takes `NOTIFICATION_PORT` as `@Optional()`: when the port
 * is not visible in `McpModule`, Nest injects `undefined` without a word and
 * `call.refused_repeatedly` is never sent (BUG-SEC-01).
 *
 * A token is visible in a module when the module provides it or one of its
 * imports exports it (an exported module passes its own exports on). This
 * walks the real `@Module()` metadata the same way; it does not boot Nest,
 * which needs Postgres, Redis and BullMQ.
 */
type ModuleLike = { module?: unknown; exports?: unknown[]; forwardRef?: () => unknown };

function unwrap(entry: unknown): { target: unknown; dynamicExports: unknown[] } {
  const value = entry as ModuleLike;
  if (value && typeof value.forwardRef === 'function') return unwrap(value.forwardRef());
  if (value && typeof value === 'object' && 'module' in value) {
    return { target: value.module, dynamicExports: value.exports ?? [] };
  }
  return { target: entry, dynamicExports: [] };
}

function isModule(target: unknown): boolean {
  return (
    typeof target === 'function' &&
    (Reflect.getMetadataKeys(target) as string[]).some((key) =>
      Object.values(MODULE_METADATA).includes(key as never),
    )
  );
}

function exportedTokens(entry: unknown, seen = new Set<unknown>()): Set<unknown> {
  const { target, dynamicExports } = unwrap(entry);
  const out = new Set<unknown>();
  if (seen.has(target)) return out;
  seen.add(target);
  const exports = [
    ...(((target && Reflect.getMetadata(MODULE_METADATA.EXPORTS, target as object)) ??
      []) as unknown[]),
    ...dynamicExports,
  ];
  for (const exported of exports) {
    const inner = unwrap(exported).target;
    if (isModule(inner)) {
      for (const token of exportedTokens(exported, seen)) out.add(token);
    } else {
      const provider = exported as { provide?: unknown };
      out.add(
        provider && typeof provider === 'object' && 'provide' in provider
          ? provider.provide
          : exported,
      );
    }
  }
  return out;
}

function visibleTokens(module: object): Set<unknown> {
  const visible = new Set<unknown>();
  const providers = (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, module) ?? []) as unknown[];
  for (const provider of providers) {
    const p = provider as { provide?: unknown };
    visible.add(p && typeof p === 'object' && 'provide' in p ? p.provide : provider);
  }
  const imports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, module) ?? []) as unknown[];
  for (const imported of imports) {
    for (const token of exportedTokens(imported)) visible.add(token);
  }
  return visible;
}

describe('McpModule wiring', () => {
  it('provides McpCallRecorder', () => {
    expect(visibleTokens(McpModule).has(McpCallRecorder)).toBe(true);
  });

  it('makes NOTIFICATION_PORT visible to McpCallRecorder (call.refused_repeatedly)', () => {
    expect(visibleTokens(McpModule).has(NOTIFICATION_PORT)).toBe(true);
  });
});
