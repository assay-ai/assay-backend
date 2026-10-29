import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { ProtocolAnalyticsController } from '@modules/protocol-analytics/controllers/protocol-analytics.controller';
import { ProtocolAnalyticsService } from '@modules/protocol-analytics/services/protocol-analytics.service';

it('publishes concrete analytics schemas with atomic-unit strings and a consistent aggregate contract', async () => {
  const module = await Test.createTestingModule({
    controllers: [ProtocolAnalyticsController],
    providers: [{ provide: ProtocolAnalyticsService, useValue: { read: jest.fn() } }],
  }).compile();
  const app = module.createNestApplication();
  try {
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().build());
    const schemas = document.components!.schemas!;
    expect(Object.keys((schemas.ProtocolAnalyticsResponseDto as any).properties).sort()).toEqual(
      [
        'state',
        'generatedAt',
        'cacheTtlMs',
        'assets',
        'asset',
        'range',
        'window',
        'totals',
        'previous',
        'daily',
        'topTools',
        'recent',
        'escrow',
        'withheldForPrivacy',
      ].sort(),
    );
    expect((schemas.AnalyticsFigures as any).properties.revenue.type).toBe('string');
    expect((schemas.AnalyticsFigures as any).properties.passRate.nullable).toBe(true);
    expect(JSON.stringify(schemas.ProtocolAnalyticsResponseDto)).toContain(
      '#/components/schemas/AnalyticsFigures',
    );
    expect(document.paths['/public/analytics'].get!.parameters).toHaveLength(2);
    expect(document.paths['/public/analytics'].get!.security).toBeUndefined();
  } finally {
    await app.close();
  }
});
