import { Injectable, Provider } from '@nestjs/common';

import { BLOCKHASH_READER, BlockhashReaderPort, BlockhashReading } from './blockhash.port';

import { SolanaChainAdapter } from './solana-chain.adapter';

/**
 * Solana's implementation of `BlockhashReaderPort` — the chain half of the
 * deposit path's one SVM-shaped need.
 *
 * The port lives beside this class (`./blockhash.port.ts`) because a blockhash
 * is a Solana fact and nothing outside this directory is allowed to know about
 * one. `SolanaDepositRequirementsBuilder` is the only consumer.
 *
 * `DepositService` still speaks only to ports and still imports no `@solana/*`;
 * this class exists to preserve that property, not to erode it.
 */
@Injectable()
export class SolanaBlockhashService implements BlockhashReaderPort {
  constructor(private readonly adapter: SolanaChainAdapter) {}

  async getLatestBlockhash(): Promise<BlockhashReading> {
    return this.adapter.getLatestBlockhash();
  }
}

/**
 * The token binding, declared **here** rather than in `chains.module.ts`.
 *
 * The rule is literal — *nothing outside `chains/solana/` names it* — and a
 * `{ provide: <token> }` entry in the module file is naming it. The module
 * spreads this array instead, so the only file in `src/` that spells the token
 * is the directory that owns it, and
 * `test/unit/architecture/blockhash-stays-in-solana.spec.ts` needs no exemption
 * for the wiring. Deliberately **not** exported by `ChainsModule`:
 * `SolanaDepositRequirementsBuilder`, in this same directory, is the only
 * injector there is ever meant to be.
 */
export const BLOCKHASH_PROVIDERS: Provider[] = [
  SolanaBlockhashService,
  { provide: BLOCKHASH_READER, useExisting: SolanaBlockhashService },
];
