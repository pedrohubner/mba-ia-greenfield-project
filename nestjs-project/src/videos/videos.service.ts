import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { isPgUniqueViolationOnColumn } from '../common/database/pg-errors';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import { CreateVideoDto } from './dto/create-video.dto';
import {
  InitiateUploadResponseDto,
  VideoResponseDto,
} from './dto/video-response.dto';
import {
  SignPartUrlsResponseDto,
  UploadedPartsResponseDto,
} from './dto/upload-parts-response.dto';
import { Video, VideoProcessingStatus } from './entities/video.entity';
import {
  InvalidUploadPartsException,
  InvalidUploadStateException,
  UnsupportedMediaTypeException,
  VideoNotFoundException,
} from './exceptions/video.exceptions';
import { generatePublicId, isValidPublicId } from './public-id.util';
import { toVideoResponse } from './video.presenter';
import { deriveVideoTitle, fileExtension } from './video-title.util';
import {
  ALLOWED_VIDEO_CONTENT_TYPES,
  PUBLIC_ID_MAX_ATTEMPTS,
  VIDEO_STORAGE_KEYS,
} from './videos.constants';

const PUBLIC_ID_COLUMN = 'public_id';

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    @Inject(storageConfig.KEY)
    private readonly storage: ConfigType<typeof storageConfig>,
  ) {}

  async initiateUpload(
    userId: string,
    dto: CreateVideoDto,
  ): Promise<InitiateUploadResponseDto> {
    if (
      !(ALLOWED_VIDEO_CONTENT_TYPES as readonly string[]).includes(
        dto.content_type,
      )
    ) {
      throw new UnsupportedMediaTypeException();
    }

    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new Error(`Channel not found for user ${userId}`);
    }

    const id = randomUUID();
    const objectKey = VIDEO_STORAGE_KEYS.original(
      id,
      fileExtension(dto.filename),
    );
    const uploadId = await this.storageService.createMultipartUpload(
      objectKey,
      dto.content_type,
    );

    let video: Video;
    try {
      video = await this.insertWithUniquePublicId({
        id,
        channel_id: channel.id,
        title: deriveVideoTitle(dto.filename, dto.title),
        original_filename: dto.filename,
        content_type: dto.content_type,
        size_bytes: dto.size_bytes,
        object_key: objectKey,
        upload_id: uploadId,
      });
    } catch (err) {
      await this.abortQuietly(objectKey, uploadId);
      throw err;
    }

    return {
      video: await this.present(video),
      upload: {
        part_size: this.storage.partSizeBytes,
        part_count: this.partCount(dto.size_bytes),
      },
    };
  }

  async signPartUrls(
    userId: string,
    publicId: string,
    partNumbers: number[],
  ): Promise<SignPartUrlsResponseDto> {
    const video = await this.findOwnedOrFail(userId, publicId);
    this.assertPendingUpload(video);

    const partCount = this.partCount(video.size_bytes);
    if (partNumbers.some((partNumber) => partNumber > partCount)) {
      throw new InvalidUploadPartsException();
    }

    const ttlSeconds = this.storage.partUrlTtlSeconds;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    const parts = await Promise.all(
      partNumbers.map(async (partNumber) => ({
        part_number: partNumber,
        url: await this.storageService.signUploadPartUrl(
          video.object_key,
          video.upload_id!,
          partNumber,
          ttlSeconds,
        ),
      })),
    );

    return { parts, expires_at: expiresAt.toISOString() };
  }

  async listUploadedParts(
    userId: string,
    publicId: string,
  ): Promise<UploadedPartsResponseDto> {
    const video = await this.findOwnedOrFail(userId, publicId);
    this.assertPendingUpload(video);

    const parts = await this.storageService.listParts(
      video.object_key,
      video.upload_id!,
    );

    return {
      part_size: this.storage.partSizeBytes,
      part_count: this.partCount(video.size_bytes),
      parts: parts.map((part) => ({
        part_number: part.partNumber,
        etag: part.etag,
        size: part.size,
      })),
    };
  }

  async findOwnedOrFail(userId: string, publicId: string): Promise<Video> {
    if (!isValidPublicId(publicId)) {
      throw new VideoNotFoundException();
    }
    const video = await this.videoRepository.findOne({
      where: { public_id: publicId, channel: { user_id: userId } },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  assertPendingUpload(video: Video): void {
    if (
      video.processing_status !== VideoProcessingStatus.PENDING_UPLOAD ||
      !video.upload_id
    ) {
      throw new InvalidUploadStateException();
    }
  }

  async present(video: Video): Promise<VideoResponseDto> {
    const thumbnailUrl = video.thumbnail_key
      ? await this.storageService.signGetObjectUrl(video.thumbnail_key, {
          audience: 'public',
          ttlSeconds: this.storage.thumbnailUrlTtlSeconds,
        })
      : null;
    return toVideoResponse(video, thumbnailUrl);
  }

  private partCount(sizeBytes: number): number {
    return Math.ceil(sizeBytes / this.storage.partSizeBytes);
  }

  private async insertWithUniquePublicId(
    fields: Partial<Video>,
  ): Promise<Video> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.videoRepository.save(
          this.videoRepository.create({
            ...fields,
            public_id: generatePublicId(),
          }),
        );
      } catch (err) {
        if (
          attempt >= PUBLIC_ID_MAX_ATTEMPTS ||
          !isPgUniqueViolationOnColumn(err, PUBLIC_ID_COLUMN)
        ) {
          throw err;
        }
      }
    }
  }

  private async abortQuietly(
    objectKey: string,
    uploadId: string,
  ): Promise<void> {
    try {
      await this.storageService.abortMultipartUpload(objectKey, uploadId);
    } catch {
      return;
    }
  }
}
