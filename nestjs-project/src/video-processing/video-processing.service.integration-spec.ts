import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UnrecoverableError, type Job } from 'bullmq';
import { readFile } from 'fs/promises';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import { MediaModule } from '../media/media.module';
import { ThumbnailService } from '../media/thumbnail.service';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import {
  createMediaFixtures,
  type MediaFixtures,
} from '../test/media-fixtures';
import { cleanupVideoStorage } from '../test/storage';
import { User } from '../users/entities/user.entity';
import { Video, VideoProcessingStatus } from '../videos/entities/video.entity';
import { generatePublicId } from '../videos/public-id.util';
import { VIDEO_STORAGE_KEYS } from '../videos/videos.constants';
import { PROCESS_VIDEO_JOB } from './video-processing.constants';
import { StaleUploadsService } from './stale-uploads.service';
import { VideoProcessingProcessor } from './video-processing.processor';
import { VideoProcessingProducer } from './video-processing.producer';
import { VideoProcessingService } from './video-processing.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideoProcessingService (integration)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let service: VideoProcessingService;
  let processor: VideoProcessingProcessor;
  let storageService: StorageService;
  let thumbnailService: ThumbnailService;
  let fixtures: MediaFixtures;
  let channel: Channel;

  beforeAll(async () => {
    fixtures = await createMediaFixtures();
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, videoConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
        StorageModule,
        MediaModule,
      ],
      providers: [VideoProcessingService],
    }).compile();

    dataSource = module.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    service = module.get(VideoProcessingService);
    storageService = module.get(StorageService);
    thumbnailService = module.get(ThumbnailService);
    processor = new VideoProcessingProcessor(
      service,
      {} as StaleUploadsService,
      {} as VideoProcessingProducer,
      module.get<ConfigType<typeof videoConfig>>(videoConfig.KEY),
    );
  }, 120000);

  afterAll(async () => {
    await cleanupVideoStorage(dataSource);
    await cleanAllTables(dataSource);
    await fixtures.cleanup();
    await module.close();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await cleanupVideoStorage(dataSource);
    await cleanAllTables(dataSource);
    const user = await dataSource.getRepository(User).save({
      email: `worker_${Date.now()}@example.com`,
      password: 'hashed',
    });
    channel = await dataSource.getRepository(Channel).save({
      name: 'Worker',
      nickname: `worker-${Date.now()}`,
      user_id: user.id,
    });
  });

  async function seedUploadedVideo(sourceFile: string): Promise<Video> {
    const id = crypto.randomUUID();
    const objectKey = VIDEO_STORAGE_KEYS.original(id, 'mp4');
    const body = await readFile(sourceFile);
    await storageService.putObject(objectKey, body, 'video/mp4');
    return videoRepository.save(
      videoRepository.create({
        id,
        public_id: generatePublicId(),
        channel_id: channel.id,
        title: 'Worker',
        original_filename: 'worker.mp4',
        content_type: 'video/mp4',
        size_bytes: body.length,
        object_key: objectKey,
        processing_status: VideoProcessingStatus.UPLOADED,
      }),
    );
  }

  function jobFor(video: Video): Job {
    return {
      id: video.id,
      name: PROCESS_VIDEO_JOB,
      data: { videoId: video.id },
      opts: { attempts: 3 },
      attemptsMade: 0,
    } as Job;
  }

  it('should process a valid MP4 to ready with metadata and a stored thumbnail', async () => {
    const video = await seedUploadedVideo(fixtures.h264Mp4);
    const statusesDuringThumbnail: VideoProcessingStatus[] = [];
    const realThumbnailService = new ThumbnailService();
    jest
      .spyOn(thumbnailService, 'extractFrame')
      .mockImplementation(async (source, atSeconds) => {
        const row = await videoRepository.findOneByOrFail({ id: video.id });
        statusesDuringThumbnail.push(row.processing_status);
        return realThumbnailService.extractFrame(source, atSeconds);
      });

    await service.process(video.id);

    expect(statusesDuringThumbnail).toEqual([VideoProcessingStatus.PROCESSING]);
    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row).toMatchObject({
      processing_status: VideoProcessingStatus.READY,
      processing_error: null,
      width: 1920,
      height: 1080,
      video_codec: 'h264',
      audio_codec: 'aac',
      thumbnail_key: `thumbnails/${video.id}/auto.jpg`,
    });
    expect(row.duration_seconds).toBeCloseTo(3, 0);
    expect(row.container_format).toContain('mp4');
    expect(row.bitrate).toBeGreaterThan(0);
    const thumbnail = await storageService.headObject(row.thumbnail_key!);
    expect(thumbnail.contentType).toBe('image/jpeg');
    expect(thumbnail.contentLength).toBeGreaterThan(0);
  });

  it('should mark random bytes as failed with INVALID_MEDIA after one attempt and keep the original', async () => {
    const video = await seedUploadedVideo(fixtures.randomBytes);

    await expect(processor.process(jobFor(video))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );

    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row).toMatchObject({
      processing_status: VideoProcessingStatus.FAILED,
      processing_error: 'INVALID_MEDIA',
      thumbnail_key: null,
    });
    await expect(storageService.headObject(row.object_key)).resolves.toEqual(
      expect.objectContaining({ contentType: 'video/mp4' }),
    );
  });

  it('should mark an unsupported codec as failed with UNSUPPORTED_CODEC', async () => {
    const video = await seedUploadedVideo(fixtures.mpeg4Mp4);

    await expect(processor.process(jobFor(video))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );

    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row.processing_status).toBe(VideoProcessingStatus.FAILED);
    expect(row.processing_error).toBe('UNSUPPORTED_CODEC');
  });

  it('should be idempotent: processing a ready video again changes nothing', async () => {
    const video = await seedUploadedVideo(fixtures.h264Mp4);
    await service.process(video.id);
    const first = await videoRepository.findOneByOrFail({ id: video.id });
    const probe = jest.spyOn(thumbnailService, 'extractFrame');

    await service.process(video.id);

    const second = await videoRepository.findOneByOrFail({ id: video.id });
    expect(second).toEqual(first);
    expect(probe).not.toHaveBeenCalled();
  });
});
