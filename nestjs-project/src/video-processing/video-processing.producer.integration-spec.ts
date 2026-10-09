import { getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import {
  createTestBullRootModule,
  testQueuePrefix,
  testRedisConnection,
} from '../test/queue';
import { VideoProcessingQueueModule } from './video-processing-queue.module';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
} from './video-processing.constants';
import { VideoProcessingProducer } from './video-processing.producer';

describe('VideoProcessingProducer (integration)', () => {
  let module: TestingModule;
  let producer: VideoProcessingProducer;
  let queue: Queue;
  let redis: Redis;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [createTestBullRootModule(), VideoProcessingQueueModule],
    }).compile();
    await module.init();

    producer = module.get(VideoProcessingProducer);
    queue = module.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
    redis = new Redis(testRedisConnection);
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await redis.quit();
    await module.close();
  });

  it('should enqueue a single job keyed by videoId when called twice', async () => {
    const videoId = randomUUID();

    await producer.enqueueProcessing(videoId);
    await producer.enqueueProcessing(videoId);

    const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe(videoId);
    expect(jobs[0].name).toBe(PROCESS_VIDEO_JOB);
    expect(jobs[0].data).toEqual({ videoId });
  });

  it('should apply the default retry and retention options to the job', async () => {
    const videoId = randomUUID();

    await producer.enqueueProcessing(videoId);

    const job = await queue.getJob(videoId);
    expect(job?.opts).toMatchObject({
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { age: 86400 },
      removeOnFail: { age: 604800 },
    });
  });

  it('should store the job under the test queue prefix', async () => {
    const videoId = randomUUID();

    await producer.enqueueProcessing(videoId);

    expect(testQueuePrefix).toBe('bull-test');
    expect(
      await redis.exists(
        `${testQueuePrefix}:${VIDEO_PROCESSING_QUEUE}:${videoId}`,
      ),
    ).toBe(1);
    expect(
      await redis.exists(`bull:${VIDEO_PROCESSING_QUEUE}:${videoId}`),
    ).toBe(0);
  });
});
