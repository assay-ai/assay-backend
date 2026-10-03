import {
  DepositRequirements,
  DepositRequirementsBuilderPort,
  DepositRequirementsInput,
} from '@modules/payment/ports/deposit-requirements.port';

import { implementationFor } from './namespace-dispatch';

/**
 * `DepositRequirementsBuilderPort` over more than one namespace.
 *
 * Dispatches on `input.chainId`, which `DepositsController` takes from the
 * **resolved** account rather than from the session or the request body — the
 * same value the intent row was written with. A builder chosen any other way
 * could describe a transaction on a chain the intent does not name.
 *
 * ## What the single binding was doing
 *
 * `DEPOSIT_REQUIREMENTS_BUILDER` was `useExisting: SolanaDepositRequirementsBuilder`
 * for every chain. On `eip155` that builder reads `extra.feePayer` and
 * `extra.memo` — fields no EVM `402` carries — so the honest outcome was a
 * `502` blaming the facilitator, and the dishonest one would have been a
 * response telling the browser to make an SPL transfer to an SPL address on a
 * chain that has neither. The union's discriminant existed from the start for
 * this; it just had nothing on the other side of it.
 */
export class NamespaceDepositRequirementsBuilder implements DepositRequirementsBuilderPort {
  constructor(private readonly byNamespace: ReadonlyMap<string, DepositRequirementsBuilderPort>) {}

  async build(input: DepositRequirementsInput): Promise<DepositRequirements> {
    return implementationFor(this.byNamespace, input.chainId).build(input);
  }
}
