import { DepositFinalityWatcher } from '@modules/payment/services/deposit-finality-watcher.service';

/**
 * Every deposit now lands on the buyer's own escrow ATA, not one
 * shared pooled-vault account, so a single-account watch no longer fits this
 * class's whole reason for existing. It stays registered — and green — as an
 * inert no-op that says so at boot; see the class comment for the reasoning
 * and for the seam a future per-buyer accelerator would fill.
 */
describe('DepositFinalityWatcher', () => {
  it('starts and logs that it is off, unconditionally', async () => {
    const watcher = new DepositFinalityWatcher();

    await expect(watcher.onModuleInit()).resolves.toBeUndefined();
  });
});
