import { Module, Global } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import {
  RedisAdapterProvider,
  REDIS_ADAPTER_CLIENT,
  RedisAdapterPubProvider,
  REDIS_ADAPTER_PUB_CLIENT,
  RedisAdapterSubProvider,
  REDIS_ADAPTER_SUB_CLIENT,
  RedisCommanderProvider,
  REDIS_COMMANDER_CLIENT,
} from './redis-adapter.provider';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    RedisAdapterProvider,
    RedisAdapterPubProvider,
    RedisAdapterSubProvider,
    RedisCommanderProvider,
  ],
  exports: [
    REDIS_ADAPTER_CLIENT,
    REDIS_ADAPTER_PUB_CLIENT,
    REDIS_ADAPTER_SUB_CLIENT,
    REDIS_COMMANDER_CLIENT,
  ],
})
export class RedisAdapterModule {}
