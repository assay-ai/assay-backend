import { SlashDeliveryObserver } from '@modules/slash/services/slash-delivery-observer.service';

/**
 * The slash side of the delivery observer.
 *
 * Note what this suite deliberately does NOT claim to prove. The
 * "two channels delivering must move the deadline once" guarantee lives in SQL
 * — `markNotifiedIfUnnotified` is guarded on `notified_at IS NULL` — and a test
 * over a mocked service cannot see a predicate the database evaluates. Calling
 * the observer twice here would only prove the mock was called twice. That
 * guarantee belongs to the integration harness; what is checked here is the
 * routing and the never-throws contract, which are this class's own.
 */

const ORG = 'org-1';
const PROPOSAL = 'proposal-1';
const AT = new Date('2026-08-24T05:00:00.000Z');

let proposals: { markDelivered: jest.Mock };
let observer: SlashDeliveryObserver;

beforeEach(() => {
  proposals = { markDelivered: jest.fn().mockResolvedValue(undefined) };
  observer = new SlashDeliveryObserver(proposals as never);
});

describe('SlashDeliveryObserver', () => {
  it('starts the response clock for a slash proposal', async () => {
    await observer.onDelivered(ORG, 'slash_proposal', PROPOSAL, AT);

    expect(proposals.markDelivered).toHaveBeenCalledWith(ORG, PROPOSAL, AT);
  });

  it('ignores a subject it does not own', async () => {
    await observer.onDelivered(ORG, 'payment_intent', 'intent-1', AT);

    expect(proposals.markDelivered).not.toHaveBeenCalled();
  });

  /**
   * The processor calls this after the delivery row is written and the job has
   * effectively succeeded. Throwing would retry a notification that was already
   * delivered, so the port's contract is that this never throws — and the
   * processor's own guard is a second belt, not a substitute for this one.
   */
  it('never throws when the proposal service fails', async () => {
    proposals.markDelivered.mockRejectedValue(new Error('deadlock'));

    await expect(
      observer.onDelivered(ORG, 'slash_proposal', PROPOSAL, AT),
    ).resolves.toBeUndefined();
  });
});
