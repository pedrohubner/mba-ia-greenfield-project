import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import videoConfig from '../config/video.config';
import { StorageService } from '../storage/storage.service';
import { Video, VideoProcessingStatus } from '../videos/entities/video.entity';
import { VideoProcessingProducer } from './video-processing.producer';

const NO_SUCH_UPLOAD = 'NoSuchUpload';

const HOUR_MS = 60 * 60 * 1000;

const MINUTE_MS = 60 * 1000;

@Injectable()
export class StaleUploadsService {
  private readonly logger = new Logger(StaleUploadsService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly videoProcessingProducer: VideoProcessingProducer,
    @Inject(videoConfig.KEY)
    private readonly video: ConfigType<typeof videoConfig>,
  ) {}

  async cleanupStaleDrafts(): Promise<number> {
    const cutoff = new Date(
      Date.now() - this.video.staleUploadTtlHours * HOUR_MS,
    );
    const drafts = await this.videoRepository.findBy({
      processing_status: VideoProcessingStatus.PENDING_UPLOAD,
      created_at: LessThan(cutoff),
    });

    for (const draft of drafts) {
      await this.abortQuietly(draft);
      await this.videoRepository.delete({ id: draft.id });
    }
    return drafts.length;
  }

  async requeueStuckUploads(): Promise<number> {
    const cutoff = new Date(
      Date.now() - this.video.staleUploadedRequeueMinutes * MINUTE_MS,
    );
    const stuck = await this.videoRepository.findBy({
      processing_status: VideoProcessingStatus.UPLOADED,
      updated_at: LessThan(cutoff),
    });

    for (const video of stuck) {
      await this.videoProcessingProducer.enqueueProcessing(video.id);
    }
    return stuck.length;
  }

  private async abortQuietly(draft: Video): Promise<void> {
    if (!draft.upload_id) {
      return;
    }
    try {
      await this.storageService.abortMultipartUpload(
        draft.object_key,
        draft.upload_id,
      );
    } catch (error) {
      if ((error as Error).name !== NO_SUCH_UPLOAD) {
        this.logger.warn(
          `Could not abort upload of stale draft ${draft.id}: ${(error as Error).message}`,
        );
      }
    }
  }
}
