import { Job, UnrecoverableError } from 'bullmq';
import type { ConfigType } from '@nestjs/config';
import videoConfig from '../config/video.config';
import {
  InvalidMediaError,
  UnsupportedCodecError,
} from '../media/media.errors';
import {
  PROCESS_VIDEO_JOB,
  PROCESSING_ERROR_REASON,
} from './video-processing.constants';
import { VideoProcessingProcessor } from './video-processing.processor';
import { VideoProcessingService } from './video-processing.service';

const VIDEO_ID = '7b1e2a0c-1111-4c6e-9a8b-000000000001';

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: VIDEO_ID,
    name: PROCESS_VIDEO_JOB,
    data: { videoId: VIDEO_ID },
    opts: { attempts: 3 },
    attemptsMade: 1,
    ...overrides,
  } as Job;
}

describe('VideoProcessingProcessor', () => {
  let processor: VideoProcessingProcessor;
  let service: {
    process: jest.Mock;
    markFailed: jest.Mock;
    isFailed: jest.Mock;
  };

  beforeEach(() => {
    service = {
      process: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
      isFailed: jest.fn().mockResolvedValue(false),
    };
    processor = new VideoProcessingProcessor(
      service as unknown as VideoProcessingService,
      { workerConcurrency: 1 } as ConfigType<typeof videoConfig>,
    );
  });

  describe('process', () => {
    it('should delegate process-video jobs to the service', async () => {
      await processor.process(job());

      expect(service.process).toHaveBeenCalledWith(VIDEO_ID);
      expect(service.markFailed).not.toHaveBeenCalled();
    });

    it('should not touch the service for unknown job names', async () => {
      await processor.process(job({ name: 'something-else' }));

      expect(service.process).not.toHaveBeenCalled();
    });

    it.each([
      ['INVALID_MEDIA', new InvalidMediaError()],
      ['UNSUPPORTED_CODEC', new UnsupportedCodecError()],
    ])(
      'should mark the video failed with %s and stop retrying',
      async (reasonCode, error) => {
        service.process.mockRejectedValue(error);

        await expect(processor.process(job())).rejects.toBeInstanceOf(
          UnrecoverableError,
        );
        expect(service.markFailed).toHaveBeenCalledWith(VIDEO_ID, reasonCode);
      },
    );

    it('should rethrow transient errors so the job is retried', async () => {
      const failure = new Error('storage unavailable');
      service.process.mockRejectedValue(failure);

      await expect(processor.process(job())).rejects.toBe(failure);
      expect(service.markFailed).not.toHaveBeenCalled();
    });
  });

  describe('onFailed', () => {
    it('should not mark the video failed while attempts remain', async () => {
      await processor.onFailed(job({ attemptsMade: 2 }), new Error('boom'));

      expect(service.markFailed).not.toHaveBeenCalled();
    });

    it('should mark PROCESSING_ERROR after the last attempt', async () => {
      await processor.onFailed(job({ attemptsMade: 3 }), new Error('boom'));

      expect(service.markFailed).toHaveBeenCalledWith(
        VIDEO_ID,
        PROCESSING_ERROR_REASON,
      );
    });

    it('should keep the media reason code when the video is already failed', async () => {
      service.isFailed.mockResolvedValue(true);

      await processor.onFailed(job({ attemptsMade: 3 }), new Error('boom'));

      expect(service.markFailed).not.toHaveBeenCalled();
    });

    it('should ignore events without a job or for other job names', async () => {
      await processor.onFailed(undefined, new Error('boom'));
      await processor.onFailed(
        job({ name: 'something-else', attemptsMade: 3 }),
        new Error('boom'),
      );

      expect(service.markFailed).not.toHaveBeenCalled();
    });
  });
});
