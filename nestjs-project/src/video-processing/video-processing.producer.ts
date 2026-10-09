import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
  type ProcessVideoJobData,
} from './video-processing.constants';

@Injectable()
export class VideoProcessingProducer {
  constructor(
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly queue: Queue<ProcessVideoJobData>,
  ) {}

  async enqueueProcessing(videoId: string): Promise<void> {
    await this.queue.add(PROCESS_VIDEO_JOB, { videoId }, { jobId: videoId });
  }
}
