import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, OnApplicationBootstrap } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Job, UnrecoverableError } from 'bullmq';
import videoConfig from '../config/video.config';
import { MediaRejectedError } from '../media/media.errors';
import {
  PROCESS_VIDEO_JOB,
  PROCESSING_ERROR_REASON,
  VIDEO_PROCESSING_QUEUE,
  type ProcessVideoJobData,
} from './video-processing.constants';
import { VideoProcessingService } from './video-processing.service';

@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessingProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  private readonly logger = new Logger(VideoProcessingProcessor.name);

  constructor(
    private readonly videoProcessingService: VideoProcessingService,
    @Inject(videoConfig.KEY)
    private readonly video: ConfigType<typeof videoConfig>,
  ) {
    super();
  }

  onApplicationBootstrap(): void {
    this.worker.concurrency = this.video.workerConcurrency;
  }

  async process(job: Job): Promise<void> {
    switch (job.name) {
      case PROCESS_VIDEO_JOB:
        return this.processVideo(job as Job<ProcessVideoJobData>);
      default:
        this.logger.warn(`Ignoring unknown job "${job.name}" (${job.id})`);
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job | undefined, error: Error): Promise<void> {
    if (!job || job.name !== PROCESS_VIDEO_JOB) {
      return;
    }
    const { videoId } = job.data as ProcessVideoJobData;
    const attempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < attempts) {
      return;
    }
    if (await this.videoProcessingService.isFailed(videoId)) {
      return;
    }
    this.logger.error(
      `Video ${videoId} failed after ${job.attemptsMade} attempts: ${error.message}`,
    );
    await this.videoProcessingService.markFailed(
      videoId,
      PROCESSING_ERROR_REASON,
    );
  }

  private async processVideo(job: Job<ProcessVideoJobData>): Promise<void> {
    const { videoId } = job.data;
    try {
      await this.videoProcessingService.process(videoId);
    } catch (error) {
      if (error instanceof MediaRejectedError) {
        await this.videoProcessingService.markFailed(videoId, error.reasonCode);
        throw new UnrecoverableError(`${error.reasonCode}: ${error.message}`);
      }
      throw error;
    }
  }
}
