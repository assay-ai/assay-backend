import { Module, Global } from '@nestjs/common';
import { RedisCacheModule } from '../redis-cache/redis-cache.module';

@Global()
@Module({
  imports: [RedisCacheModule],
  // HttpCacheInterceptor is registered in main.ts after TransformInterceptor
  // to ensure cached responses are in the same format as fresh responses
})
export class HttpCacheModule {}
