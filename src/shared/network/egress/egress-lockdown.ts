/**
 * The third lock, and the only one that is not a source scan.
 *
 * `eslint.config.mjs` and `single-http-client.spec.ts` both read source text.
 * Between them they now catch every named library, every Node socket
 * primitive, `global`/`globalThis` aliasing, `WebSocket`, dynamic imports and
 * `createRequire`. Three things defeat both by construction, and no amount of
 * further regex or AST work changes that:
 *
 * 1. **Code as data.** `eval`, `new Function`, `vm.runInThisContext`,
 *    `new Worker(src, { eval: true })`. The payload is a string, and the source
 *    scan deliberately erases string contents — that erasure is what keeps it
 *    free of false positives.
 * 2. **Aliasing across statements.** `const g = globalThis;` on one line and
 *    `g.fetch(url)` on another. Scope analysis reaches some of it; a `Proxy` or
 *    a computed member reaches past scope analysis.
 * 3. **A dependency's own transport.** `@solana/kit` calls global `fetch`
 *    internally, which the source locks cannot see. A caller-pin test covers
 *    that known case and cannot generalise to every transitive dependency.
 *
 * This guard closes all three the same way: it wraps the primitives themselves,
 * so a call that did not come from {@link EgressHttpClient} throws no matter how
 * it was spelled or which package it came from.
 *
 * ## Default
 *
 * The guard is installed by default outside production and is enabled in other
 * environments with `EGRESS_LOCKDOWN=true`. Its main value is in CI and
 * development, where a call that bypasses `EgressHttpClient` throws on its
 * first run. See `SECURITY.md` for reporting.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { Logger } from '@nestjs/common';
import type * as HttpModule from 'node:http';

/**
 * `require`, not `import * as`, and deliberately.
 *
 * TypeScript's namespace import compiles to a wrapper whose properties are
 * getter-only, so assigning to it throws — and even where it does not throw, it
 * patches a *copy* while every other importer keeps the original. `require`
 * returns the module's real exports object, which is the one thing every caller
 * in the process shares. Patching anything else would produce a guard that
 * passes its own tests and stops nobody.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
const http = require('node:http') as typeof HttpModule;
const https = require('node:https') as typeof HttpModule;
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * ## What this guard deliberately does NOT patch, and why
 *
 * **`net.Socket.prototype.connect`.** It is the layer underneath every route
 * here, and patching it would close `net`, `http2`, `ClientRequest`,
 * `socket.io-client`, `ioredis` and `pg` in one function — which is exactly the
 * problem. `ioredis` and `pg` are legitimate: this process is *supposed* to open
 * sockets to Redis and Postgres, and nothing at that layer distinguishes them
 * from a raw HTTP request an attacker's URL provoked. A guard that has to be
 * taught the difference between Postgres and SSRF will get it wrong, and the
 * fix on the on-call engineer's desk is `EGRESS_LOCKDOWN=false` forever. Source-text
 * bans on `node:net` cover that layer.
 *
 * **`child_process`** and **worker threads**. A subprocess has its own process
 * and a `Worker` has its own realm; an in-process patch reaches neither. Both
 * are banned by the source locks. Do not read this file as claiming otherwise.
 *
 * ## What it is
 *
 * A control for CI and development, not for production — see
 * `isEgressLockdownEnabled`. Its value is that a developer reaching for the
 * library they know gets a red test on the first run instead of a silent SSRF
 * six months later. It is not a sandbox and will not stop someone who already
 * has code execution and wants out.
 */

/**
 * Set for the duration of one {@link EgressHttpClient} hop.
 *
 * `AsyncLocalStorage` rather than a boolean because the flag has to survive the
 * `await`s inside a hop without leaking to work that merely ran concurrently —
 * a plain flag on a shared worker would authorise every other request in flight.
 */
const sanctioned = new AsyncLocalStorage<true>();

/** Run `work` with outbound calls permitted. Called only by the egress client. */
export function withSanctionedEgress<T>(work: () => T): T {
  return sanctioned.run(true, work);
}

function isSanctioned(): boolean {
  return sanctioned.getStore() === true;
}

export class EgressLockdownError extends Error {
  constructor(what: string) {
    super(
      `Blocked: ${what} was called outside EgressHttpClient. Outbound HTTP goes through ` +
        '@shared/network/egress — it is what applies the SSRF checks (post-DNS address ' +
        'rules, pinned connect, per-hop redirect re-checking, body-size and read-time caps). ' +
        'See src/shared/network/egress/egress-lockdown.ts.',
    );
    this.name = 'EgressLockdownError';
  }
}

/**
 * Whether the guard is installed.
 *
 * - `EGRESS_LOCKDOWN` unset → **on outside production, off when
 *   `NODE_ENV=production`**.
 * - `EGRESS_LOCKDOWN` set → the explicit value wins everywhere.
 *
 * The default direction is the opposite of the repo's other flags, and that is
 * a considered trade rather than an oversight. This guard patches process-wide
 * primitives; a misfire in production is an outage, and the failure mode of an
 * outage is that somebody sets the flag to `false` and never sets it back. Its
 * value is almost entirely in CI and development anyway — catching a developer
 * reaching for the library they know, on the first test run, instead of six
 * months later in production.
 *
 * Same call-it-inline rule as `areDiagnosticsEnabled()`: read at boot, after
 * `.env` is loaded, never into a top-of-file constant.
 */
export function isEgressLockdownEnabled(): boolean {
  const configured = process.env.EGRESS_LOCKDOWN;

  if (configured !== undefined && configured !== '') {
    return configured === 'true';
  }

  return process.env.NODE_ENV !== 'production';
}

let installed = false;

/**
 * Wrap the outbound primitives. Idempotent, and safe to call before Nest boots.
 *
 * Deliberately not a Nest provider: by the time the container exists, module
 * construction has already had a chance to make a request.
 */
export function installEgressLockdown(logger = new Logger('EgressLockdown')): void {
  if (installed) return;
  installed = true;

  const deny = (what: string): void => {
    if (isSanctioned()) return;
    throw new EgressLockdownError(what);
  };

  const guardModule = (module: typeof HttpModule, name: string): void => {
    for (const method of ['request', 'get'] as const) {
      const original = module[method];
      module[method] = function guarded(this: unknown, ...args: unknown[]) {
        deny(`${name}.${method}`);
        return (original as (...a: unknown[]) => unknown).apply(this, args);
      } as typeof original;
    }

    // `request` is a factory over `ClientRequest`, and the constructor stays
    // exported. Wrapping only the factory leaves a bypass reachable from
    // *inside the module already patched* — `new http.ClientRequest(url)` —
    // which would reach a metadata service.
    // Only `node:http` exports it — `node:https` re-uses http's, so the check
    // is not defensive padding, it is the difference between guarding one
    // module and throwing at boot.
    const OriginalClientRequest = module.ClientRequest;
    if (typeof OriginalClientRequest === 'function') {
      module.ClientRequest = new Proxy(OriginalClientRequest, {
        construct(target, args): object {
          deny(`${name}.ClientRequest`);
          return Reflect.construct(target, args) as object;
        },
      });
    }
  };

  guardModule(http, 'http');
  guardModule(https, 'https');

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const http2 = require('node:http2') as { connect: (...a: unknown[]) => unknown };
  const originalHttp2Connect = http2.connect;
  http2.connect = function guardedConnect(...args: unknown[]) {
    deny('http2.connect');
    return originalHttp2Connect(...args);
  };

  const globals = globalThis as Record<string, unknown>;

  const originalFetch = globals.fetch;
  if (typeof originalFetch === 'function') {
    globals.fetch = function guardedFetch(...args: unknown[]) {
      deny('fetch');
      return (originalFetch as (...a: unknown[]) => unknown)(...args);
    };
  }

  const OriginalWebSocket = globals.WebSocket;
  if (typeof OriginalWebSocket === 'function') {
    globals.WebSocket = new Proxy(OriginalWebSocket as new (...a: unknown[]) => object, {
      construct(target, args): object {
        deny('WebSocket');
        return Reflect.construct(target, args) as object;
      },
    });
  }

  logger.log('Outbound sockets are locked to EgressHttpClient');
}

/** Test-only. Restoring the primitives would need a second patch layer. */
export function isEgressLockdownInstalled(): boolean {
  return installed;
}
