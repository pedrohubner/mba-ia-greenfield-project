import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, OnApplicationBootstrap } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Job, UnrecoverableError } from 'bullmq';
import videoConfig from '../config/video.config';
import { MediaRejectedError } from '../media/media.errors';
import {
  CLEANUP_STALE_UPLOADS_JOB,
  PROCESS_VIDEO_JOB,
  PROCESSING_ERROR_REASON,
  VIDEO_PROCESSING_QUEUE,
  type ProcessVideoJobData,
} from './video-processing.constants';
import { VideoProcessingProducer } from './video-processing.producer';
import { VideoProcessingService } from './video-processing.service';
import { StaleUploadsService } from './stale-uploads.service';

@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessingProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  private readonly logger = new Logger(VideoProcessingProcessor.name);

  constructor(
    private readonly videoProcessingService: VideoProcessingService,
    private readonly staleUploadsService: StaleUploadsService,
    private readonly videoProcessingProducer: VideoProcessingProducer,
    @Inject(videoConfig.KEY)
    private readonly video: ConfigType<typeof videoConfig>,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    this.worker.concurrency = this.video.workerConcurrency;
    await this.videoProcessingProducer.scheduleStaleUploadsCleanup();
  }

  async process(job: Job): Promise<void> {
    switch (job.name) {
      case PROCESS_VIDEO_JOB:
        return this.processVideo(job as Job<ProcessVideoJobData>);
      case CLEANUP_STALE_UPLOADS_JOB:
        return this.cleanupStaleUploads();
      default:
        throw new Error(`Unknown job "${job.name}" (${job.id})`);
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

  private async cleanupStaleUploads(): Promise<void> {
    const removed = await this.staleUploadsService.cleanupStaleDrafts();
    const requeued = await this.staleUploadsService.requeueStuckUploads();
    if (removed > 0 || requeued > 0) {
      this.logger.log(
        `Stale uploads cleanup: ${removed} drafts removed, ${requeued} videos re-enqueued`,
      );
    }
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
