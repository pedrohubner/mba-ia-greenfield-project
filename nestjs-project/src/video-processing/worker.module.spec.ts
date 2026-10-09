import { ModulesContainer } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { MediaProbeService } from '../media/media-probe.service';
import { ThumbnailService } from '../media/thumbnail.service';
import { StorageService } from '../storage/storage.service';
import { VideoProcessingProcessor } from './video-processing.processor';
import { VideoProcessingService } from './video-processing.service';
import { WorkerModule } from './worker.module';

describe('WorkerModule', () => {
  it('should compile with the processor, service, storage and media and no HTTP modules', async () => {
    const module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    expect(module.get(VideoProcessingProcessor)).toBeInstanceOf(
      VideoProcessingProcessor,
    );
    expect(module.get(VideoProcessingService)).toBeInstanceOf(
      VideoProcessingService,
    );
    expect(module.get(StorageService)).toBeInstanceOf(StorageService);
    expect(module.get(MediaProbeService)).toBeInstanceOf(MediaProbeService);
    expect(module.get(ThumbnailService)).toBeInstanceOf(ThumbnailService);

    const moduleNames = [...module.get(ModulesContainer).values()].map(
      (moduleRef) => moduleRef.metatype.name,
    );
    for (const httpModule of ['AuthModule', 'VideosModule', 'UsersModule']) {
      expect(moduleNames).not.toContain(httpModule);
    }
    const controllers = [...module.get(ModulesContainer).values()].flatMap(
      (moduleRef) => [...moduleRef.controllers.keys()],
    );
    expect(controllers).toEqual([]);

    await module.close();
  }, 30000);
});
