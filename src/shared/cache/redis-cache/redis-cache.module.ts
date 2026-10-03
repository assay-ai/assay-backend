import { Module, Global } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RedisCacheProvider, REDIS_CACHE_CLIENT } from './redis-cache.provider';
import { CacheService } from './cache.service';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [RedisCacheProvider, CacheService],
  exports: [REDIS_CACHE_CLIENT, CacheService],
})
export class RedisCacheModule {}
