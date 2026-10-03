import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ChainsModule } from '@modules/chains/chains.module';
import { ENABLED_CHAINS } from '@modules/chains/enabled-chains';
import { settlementAssetsOn } from '@modules/chains/ports/asset-registry';
import { AssetId, ChainId, chainIdOf, isAssetId } from '@modules/chains/ports/caip.types';
import { SettlementErrors } from '@modules/settlement/errors/settlement.errors';

import { PublicReservesController } from './controllers/public-reserves.controller';
import {
  PUBLIC_RESERVES_CONFIG,
  PublicReservesConfig,
  PublicReservesService,
} from './services/public-reserves.service';

/** Frame `HoO9X` draws four history rows. */
const HISTORY_LIMIT = 4;

export const PUBLIC_RESERVES_ASSET_ENV = 'PUBLIC_RESERVES_ASSET';

/**
 * Is proof of reserves configured on this deployment?
 *
 * Called **inline** in the API bootstrap's `imports` array, after
 * `ConfigModule.forRoot(...)`, per `docs/architecture.md` §"Feature Flags": a
 * `process.env` read from a top-of-file constant resolves before `.env` is
 * loaded and would silently disable the module on every developer machine.
 *
 * Unset means the route is not registered at all, and `/reserves` 404s. That is
 * the intended shape — the page renders "not configured on this deployment"
 * rather than an empty set of tiles, and an empty set of tiles reads as zero
 * reserves, which is a claim.
 */
export function isPublicReservesConfigured(): boolean {
  return (process.env[PUBLIC_RESERVES_ASSET_ENV] ?? '').trim().length > 0;
}

/**
 * The public proof-of-reserves surface.
 *
 * ## Why this is not `settlement-api.module.ts`
 *
 * `SettlementApiModule` in that file holds the `EscrowController`, and the
 * two cannot share one module because they do not share a **lifetime**: the
 * escrow surface is core and registers unconditionally, while this one is
 * behind `PUBLIC_RESERVES_ASSET` and its `useFactory` throws at boot when that
 * is unset. Merging them either 404s every escrow route on a deployment with no
 * reserves asset, or refuses to boot one. So the reserves half moved here and
 * kept its own name.
 *
 * ## Every enabled chain, as a LIST — and this REVERSED an earlier decision
 *
 * This module used to publish exactly one config-chosen asset, arguing that
 * the page layout has room for one 4-tile grid and that an "every enabled asset"
 * page would print devnet figures beside mainnet ones under the heading *proof
 * of reserves*. Multichain support reverses it, because balances are **a list,
 * never a sum** and because the mislabel that argument feared is
 * not fixed by publishing one chain — it is fixed by every panel naming its own
 * network, which is now a non-null `chainId` on every row.
 *
 * The one-asset shape had a worse failure mode than the mislabel it prevented:
 * a deployment reconciling two chains published one of them, so the other chain
 * could be short for as long as anybody liked and the public page would say
 * nothing at all. Absence looked like health.
 *
 * The list is **derived** from the enabled chains through `settlementAssetsOn`,
 * the same function `ReconciliationJob` uses, so there is one place to forget to
 * add a chain rather than two.
 *
 * ## `PUBLIC_RESERVES_ASSET` survives as the switch, and is still checked
 *
 * It no longer chooses what is published, but it still decides *whether* the
 * route exists (`isPublicReservesConfigured`, called inline in the API
 * bootstrap), and it is still validated: it must be a real CAIP-19 on an
 * enabled chain, **and** it must be one of the assets the derivation actually
 * publishes. Reducing it to a bare on/off flag would leave a variable whose
 * value nothing reads, which is how a stale value survives a migration and
 * misleads the next operator. There is no Joi schema and no `validate:` on
 * `ConfigModule` in this repo, so the check lives in a throwing `useFactory`,
 * which is the idiom every token in `chains.module.ts` already uses and which
 * genuinely fails the boot rather than logging.
 *
 * The enabled list is **injected**, not re-parsed. `ChainsModule` provides and
 * exports `ENABLED_CHAINS`, and importing it here is free: the only bootstrap
 * that registers this module (`bootstrap/api/app.module.ts`) already registers
 * `PaymentModule`, `ProviderModule` and `SettlementModule` unconditionally, and
 * all three import `ChainsModule` — so the RPC client, the vault and the slash
 * executor are already constructed in this process, and a Nest module is a
 * singleton per application. An earlier revision re-parsed the variable here
 * and justified it with that weight; the weight is not real, and two readers of
 * one fact is one place too many for a future narrowing applied at the token to
 * silently miss.
 */
@Module({
  imports: [ChainsModule],
  controllers: [PublicReservesController],
  providers: [
    PublicReservesService,
    {
      provide: PUBLIC_RESERVES_CONFIG,
      useFactory: (config: ConfigService, enabled: readonly ChainId[]): PublicReservesConfig => {
        const raw = (config.get<string>(PUBLIC_RESERVES_ASSET_ENV) ?? '').trim();

        if (!isAssetId(raw)) {
          throw SettlementErrors.publicReservesAssetInvalid({
            variable: PUBLIC_RESERVES_ASSET_ENV,
            value: raw,
          });
        }

        const chain = chainIdOf(raw as AssetId);
        if (!enabled.includes(chain)) {
          throw SettlementErrors.publicReservesAssetNotEnabled({
            variable: PUBLIC_RESERVES_ASSET_ENV,
            value: raw,
            chain,
            enabled: enabled.join(', '),
          });
        }

        const assets = enabled.flatMap((chainId) => settlementAssetsOn(chainId));

        // The named asset must be one the derivation publishes. Without this
        // the variable would be validated against the chain list and then
        // ignored, so naming an unregistered mint on an enabled chain would
        // boot cleanly and publish a page that never mentions it.
        if (!assets.includes(raw as AssetId)) {
          throw SettlementErrors.publicReservesAssetNotEnabled({
            variable: PUBLIC_RESERVES_ASSET_ENV,
            value: raw,
            chain,
            enabled: assets.join(', '),
          });
        }

        return { assets, historyLimit: HISTORY_LIMIT };
      },
      inject: [ConfigService, ENABLED_CHAINS],
    },
  ],
})
export class PublicReservesApiModule {}
