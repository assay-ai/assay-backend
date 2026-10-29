import { Injectable, Logger } from '@nestjs/common';

import { PublicReceiptReadRepository } from '@database/postgres/repositories/public-receipt-read.repository';
import { PublicCatalogueService } from '@modules/catalogue/services/public-catalogue.service';

import { VerificationErrors } from '../errors/verification.errors';
import type { PublicReceiptResponseDto } from './public-receipt.dto';
import { assertPublicReceiptShape, PublicReceiptShapeError } from './public-receipt.guard';
import { toPublicReceipt } from './public-receipt.mapper';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One call's receipt for anybody who has its id.
 *
 * Not found, malformed id, a hidden organization and a free call all end in the
 * **same** 404, so a caller cannot learn which ids exist or why one is hidden.
 * The three steps that keep the response small: a narrow read
 * (`PublicReceiptReadRepository`), a field-by-field mapper, and a shape guard
 * that refuses to send anything it does not know.
 */
@Injectable()
export class PublicReceiptService {
  private readonly logger = new Logger(PublicReceiptService.name);

  constructor(
    private readonly reader: PublicReceiptReadRepository,
    private readonly catalogue: PublicCatalogueService,
  ) {}

  async read(intentId: string): Promise<PublicReceiptResponseDto> {
    if (!UUID.test(intentId)) throw VerificationErrors.receiptNotFound();
    const row = await this.reader.findPublicReceiptRow(intentId.toLowerCase());
    if (!row) throw VerificationErrors.receiptNotFound();

    // Only providers on the public list are named, as on the public explorer.
    const [providers, tools] = await Promise.all([
      this.catalogue.listProviders(),
      this.catalogue.listTools(),
    ]);
    const body = toPublicReceipt(row, {
      providerNames: new Map(providers.providers.map((p) => [p.providerId, p.name])),
      toolNames: new Map(tools.tools.map((t) => [t.id, t.name])),
    });

    try {
      assertPublicReceiptShape(body);
    } catch (error) {
      if (error instanceof PublicReceiptShapeError) {
        // A code defect, not a user error: fail closed and make noise. Paths only, never values.
        this.logger.error(`public_receipt_fence_violation ${error.message}`);
        throw new Error('Public receipt could not be produced');
      }
      throw error;
    }
    return body;
  }
}
