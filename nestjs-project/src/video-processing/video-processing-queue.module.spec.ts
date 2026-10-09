import { Test } from '@nestjs/testing';
import { createTestBullRootModule } from '../test/queue';
import { VideoProcessingQueueModule } from './video-processing-queue.module';
import { VideoProcessingProducer } from './video-processing.producer';

describe('VideoProcessingQueueModule', () => {
  it('should compile and export VideoProcessingProducer', async () => {
    const module = await Test.createTestingModule({
      imports: [createTestBullRootModule(), VideoProcessingQueueModule],
    }).compile();

    expect(module.get(VideoProcessingProducer)).toBeInstanceOf(
      VideoProcessingProducer,
    );
    await module.close();
  });
});
