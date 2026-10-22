import { HTTP_CODE_METADATA } from '@nestjs/common/constants';

import { CallDisputesController } from '@modules/dispute/controllers/call-disputes.controller';
import { DisputeErrorCode, DisputeErrors } from '@modules/dispute/errors/dispute.errors';

/** BUG-OPS-CASES-04: the codes and the sentence the operator console reads. */
describe('call dispute refusals', () => {
  it('a report that is not open answers 409 DISPUTE_NOT_DECIDABLE in plain words', () => {
    for (const state of ['UPHELD', 'REJECTED', 'WITHDRAWN']) {
      const error = DisputeErrors.notDecidable({ state });
      expect(error.errorCode).toBe(DisputeErrorCode.DISPUTE_NOT_DECIDABLE);
      expect(error.statusCode).toBe(409);
      expect(error.message).toBe('This report was already decided or withdrawn.');
    }
  });

  it('withdrawing a report answers 200, not the POST default 201', () => {
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, CallDisputesController.prototype.withdraw)).toBe(
      200,
    );
  });
});
