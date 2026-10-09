import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import storageConfig from '../config/storage.config';
import { MediaProbeService } from '../media/media-probe.service';
import { assertPlayable } from '../media/media-validation';
import {
  ThumbnailService,
  thumbnailTimestamp,
} from '../media/thumbnail.service';
import { StorageService } from '../storage/storage.service';
import { Video, VideoProcessingStatus } from '../videos/entities/video.entity';
import { VIDEO_STORAGE_KEYS } from '../videos/videos.constants';
import { WORKER_SOURCE_URL_TTL_SECONDS } from './video-processing.constants';

const PROCESSABLE_STATUSES: readonly VideoProcessingStatus[] = [
  VideoProcessingStatus.UPLOADED,
  VideoProcessingStatus.PROCESSING,
];

const THUMBNAIL_CONTENT_TYPE = 'image/jpeg';

@Injectable()
export class VideoProcessingService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly mediaProbeService: MediaProbeService,
    private readonly thumbnailService: ThumbnailService,
    @Inject(storageConfig.KEY)
    private readonly storage: ConfigType<typeof storageConfig>,
  ) {}

  async process(videoId: string): Promise<void> {
    const video = await this.videoRepository.findOneBy({ id: videoId });
    if (!video || !PROCESSABLE_STATUSES.includes(video.processing_status)) {
      return;
    }

    await this.videoRepository.update(
      { id: video.id },
      { processing_status: VideoProcessingStatus.PROCESSING },
    );

    const sourceUrl = await this.storageService.signGetObjectUrl(
      video.object_key,
      { audience: 'internal', ttlSeconds: WORKER_SOURCE_URL_TTL_SECONDS },
    );

    const probe = await this.mediaProbeService.probe(sourceUrl);
    assertPlayable(probe);
    await this.videoRepository.update(
      { id: video.id },
      {
        duration_seconds: probe.durationSeconds,
        width: probe.width,
        height: probe.height,
        video_codec: probe.videoCodec,
        audio_codec: probe.audioCodec,
        container_format: probe.containerFormat,
        bitrate: probe.bitrate,
      },
    );

    const frame = await this.thumbnailService.extractFrame(
      sourceUrl,
      thumbnailTimestamp(probe.durationSeconds ?? 0),
    );
    const thumbnailKey = VIDEO_STORAGE_KEYS.autoThumbnail(video.id);
    await this.storageService.putObject(
      thumbnailKey,
      frame,
      THUMBNAIL_CONTENT_TYPE,
    );

    await this.videoRepository.update(
      { id: video.id },
      {
        thumbnail_key: thumbnailKey,
        processing_status: VideoProcessingStatus.READY,
        processing_error: null,
      },
    );
  }

  async markFailed(videoId: string, reasonCode: string): Promise<void> {
    await this.videoRepository.update(
      { id: videoId },
      {
        processing_status: VideoProcessingStatus.FAILED,
        processing_error: reasonCode,
      },
    );
  }

  async isFailed(videoId: string): Promise<boolean> {
    const video = await this.videoRepository.findOneBy({ id: videoId });
    return video?.processing_status === VideoProcessingStatus.FAILED;
  }
}
