import { ChainErrors } from '../errors/chains.errors';
import { AssetId, ChainNamespace, chainIdOf, namespaceOf } from '../ports/caip.types';
import {
  HeldKey,
  HeldPaymentsPort,
  HeldRecord,
  HeldTxResult,
} from '@modules/payment/ports/held-payments.port';

/**
 * `HELD_PAYMENTS` by namespace. Only eip155 has the escrow hold; anywhere else
 * there is no hold (`null` reads) and nothing to move — rail B stays off on
 * Solana until its program has the same hold (analysis §5).
 */
export class NamespaceHeldPayments implements HeldPaymentsPort {
  constructor(private readonly evm: HeldPaymentsPort) {}

  readHeld(asset: AssetId, key: HeldKey): Promise<HeldRecord | null> {
    return this.isEvm(asset) ? this.evm.readHeld(asset, key) : Promise.resolve(null);
  }

  collect(asset: AssetId, keys: readonly HeldKey[]): Promise<HeldTxResult> {
    return this.evmOnly(asset).collect(asset, keys);
  }

  refund(asset: AssetId, keys: readonly HeldKey[]): Promise<HeldTxResult> {
    return this.evmOnly(asset).refund(asset, keys);
  }

  totalHeld(asset: AssetId): Promise<bigint | null> {
    return this.isEvm(asset) ? this.evm.totalHeld(asset) : Promise.resolve(null);
  }

  collectHoldSeconds(asset: AssetId): Promise<number | null> {
    return this.isEvm(asset) ? this.evm.collectHoldSeconds(asset) : Promise.resolve(null);
  }

  private isEvm(asset: AssetId): boolean {
    return namespaceOf(asset) === ChainNamespace.EIP155;
  }

  private evmOnly(asset: AssetId): HeldPaymentsPort {
    if (!this.isEvm(asset)) throw ChainErrors.unsupportedChain({ chainId: chainIdOf(asset) });
    return this.evm;
  }
}
