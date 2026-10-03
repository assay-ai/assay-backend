import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { NoHttpCache } from '@shared/decorators/http-cache.decorator';
import { HealthcheckResponseDto } from '@shared/dtos/healthcheck.dto';

@ApiTags('Healthcheck')
@Controller('health')
export class HealthcheckController {
  @Get()
  @NoHttpCache()
  @ApiOperation({ summary: 'Check the health of the application' })
  @ApiResponse({ status: 200, description: 'Healthcheck successful', type: HealthcheckResponseDto })
  async healthcheck(): Promise<HealthcheckResponseDto> {
    return {
      success: true,
      message: 'Healthcheck successful',
    };
  }
}
