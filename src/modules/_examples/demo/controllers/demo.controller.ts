import { Body, Controller, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { DemoService } from '../services/demo.service';
import { TriggerDemoPingDto } from '../dto/trigger-demo-ping.dto';

/**
 * Smoke-test endpoint for the BullMQ + Bull Board wiring.
 *
 * Only mounted when `DEMO_ENABLED=true`. Hit `POST /api/v1/demo/ping` from
 * Swagger to enqueue a `demo.ping` job, then open `/api/admin/queues` to
 * watch it flow through the dashboard.
 *
 * This whole module exists as a reference template; once a real feature is
 * wired up the same way, the demo can be removed.
 */
@ApiTags('Demo')
@Controller('demo')
export class DemoController {
  constructor(private readonly demoService: DemoService) {}

  @Post('ping')
  @ApiOperation({
    summary: 'Enqueue a demo.ping job — verifies BullMQ + Bull Board wiring end-to-end',
  })
  @ApiResponse({ status: 201, description: 'Job enqueued; returns jobId.' })
  async ping(@Body() dto: TriggerDemoPingDto): Promise<{ jobId: string }> {
    return this.demoService.triggerPing(dto.message ?? 'hello');
  }
}
