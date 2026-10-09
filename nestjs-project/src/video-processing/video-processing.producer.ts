import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import {
  CLEANUP_STALE_UPLOADS_EVERY_MS,
  CLEANUP_STALE_UPLOADS_JOB,
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
  type ProcessVideoJobData,
} from './video-processing.constants';

@Injectable()
export class VideoProcessingProducer {
  constructor(
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly queue: Queue,
  ) {}

  async enqueueProcessing(videoId: string): Promise<void> {
    const data: ProcessVideoJobData = { videoId };
    await this.queue.add(PROCESS_VIDEO_JOB, data, { jobId: videoId });
  }

  async scheduleStaleUploadsCleanup(): Promise<void> {
    await this.queue.upsertJobScheduler(
      CLEANUP_STALE_UPLOADS_JOB,
      { every: CLEANUP_STALE_UPLOADS_EVERY_MS },
      { name: CLEANUP_STALE_UPLOADS_JOB },
    );
  }
}
