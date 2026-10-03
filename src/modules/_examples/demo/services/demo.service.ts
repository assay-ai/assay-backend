import { Injectable } from '@nestjs/common';
import { DemoPingPublisher } from '../publishers/demo-ping.publisher';

/**
 * Thin service layer for the demo module.
 *
 * Present as a reference shape — feature services hold business logic, throw
 * module-scoped errors, and return DTOs. The demo has no business logic, so
 * this class is intentionally a one-liner delegate to the publisher.
 */
@Injectable()
export class DemoService {
  constructor(private readonly demoPingPublisher: DemoPingPublisher) {}

  async triggerPing(message: string): Promise<{ jobId: string }> {
    const jobId = await this.demoPingPublisher.enqueue(message);
    return { jobId };
  }
}
