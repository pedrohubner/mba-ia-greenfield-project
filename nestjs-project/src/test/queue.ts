import { BullModule } from '@nestjs/bullmq';
import type { DynamicModule } from '@nestjs/common';

export const testQueuePrefix = process.env.QUEUE_PREFIX ?? 'bull-test';

export const testRedisConnection = {
  host: process.env.REDIS_HOST ?? 'redis',
  port: Number(process.env.REDIS_PORT ?? 6379),
};

export function createTestBullRootModule(): DynamicModule {
  return BullModule.forRoot({
    connection: testRedisConnection,
    prefix: testQueuePrefix,
  });
}
