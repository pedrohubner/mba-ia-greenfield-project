import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { createTestBullRootModule } from '../test/queue';
import { cleanupVideoStorage } from '../test/storage';
import { User } from '../users/entities/user.entity';
import { Video, VideoProcessingStatus } from '../videos/entities/video.entity';
import { generatePublicId } from '../videos/public-id.util';
import { VIDEO_STORAGE_KEYS } from '../videos/videos.constants';
import { StaleUploadsService } from './stale-uploads.service';
import { VideoProcessingQueueModule } from './video-processing-queue.module';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
} from './video-processing.constants';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('StaleUploadsService (integration)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let service: StaleUploadsService;
  let storageService: StorageService;
  let queue: Queue;
  let channel: Channel;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig, videoConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
        createTestBullRootModule(),
        VideoProcessingQueueModule,
        StorageModule,
      ],
      providers: [StaleUploadsService],
    }).compile();

    dataSource = module.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    service = module.get(StaleUploadsService);
    storageService = module.get(StorageService);
    queue = module.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await cleanupVideoStorage(dataSource);
    await cleanAllTables(dataSource);
    await module.close();
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
    await cleanupVideoStorage(dataSource);
    await cleanAllTables(dataSource);
    const user = await dataSource.getRepository(User).save({
      email: `stale_${Date.now()}@example.com`,
      password: 'hashed',
    });
    channel = await dataSource.getRepository(Channel).save({
      name: 'Stale',
      nickname: `stale-${Date.now()}`,
      user_id: user.id,
    });
  });

  async function seedVideo(
    status: VideoProcessingStatus,
    withMultipart: boolean,
  ): Promise<Video> {
    const id = crypto.randomUUID();
    const objectKey = VIDEO_STORAGE_KEYS.original(id, 'mp4');
    const uploadId = withMultipart
      ? await storageService.createMultipartUpload(objectKey, 'video/mp4')
      : null;
    return videoRepository.save(
      videoRepository.create({
        id,
        public_id: generatePublicId(),
        channel_id: channel.id,
        title: 'Stale',
        original_filename: 'stale.mp4',
        content_type: 'video/mp4',
        size_bytes: 1024,
        object_key: objectKey,
        upload_id: uploadId,
        processing_status: status,
      }),
    );
  }

  async function ageVideo(
    video: Video,
    column: 'created_at' | 'updated_at',
    interval: string,
  ): Promise<void> {
    await dataSource.query(
      `UPDATE "videos" SET "${column}" = now() - $2::interval WHERE "id" = $1`,
      [video.id, interval],
    );
  }

  async function queuedJobIds(): Promise<string[]> {
    const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
    return jobs.map((job) => job.id!);
  }

  it('should delete an old draft and abort its multipart upload', async () => {
    const draft = await seedVideo(VideoProcessingStatus.PENDING_UPLOAD, true);
    await ageVideo(draft, 'created_at', '25 hours');

    const removed = await service.cleanupStaleDrafts();

    expect(removed).toBe(1);
    expect(await videoRepository.findOneBy({ id: draft.id })).toBeNull();
    await expect(
      storageService.listParts(draft.object_key, draft.upload_id!),
    ).rejects.toMatchObject({ name: 'NoSuchUpload' });
  });

  it('should keep a recent draft untouched', async () => {
    const draft = await seedVideo(VideoProcessingStatus.PENDING_UPLOAD, true);
    await ageVideo(draft, 'created_at', '1 hour');

    const removed = await service.cleanupStaleDrafts();

    expect(removed).toBe(0);
    expect(await videoRepository.findOneBy({ id: draft.id })).not.toBeNull();
    await expect(
      storageService.listParts(draft.object_key, draft.upload_id!),
    ).resolves.toEqual([]);
  });

  it('should delete an old draft whose multipart upload no longer exists', async () => {
    const draft = await seedVideo(VideoProcessingStatus.PENDING_UPLOAD, true);
    await storageService.abortMultipartUpload(
      draft.object_key,
      draft.upload_id!,
    );
    await ageVideo(draft, 'created_at', '25 hours');

    await expect(service.cleanupStaleDrafts()).resolves.toBe(1);
    expect(await videoRepository.findOneBy({ id: draft.id })).toBeNull();
  });

  it('should re-enqueue a video stuck in uploaded but not a recent one', async () => {
    const stuck = await seedVideo(VideoProcessingStatus.UPLOADED, false);
    const recent = await seedVideo(VideoProcessingStatus.UPLOADED, false);
    await ageVideo(stuck, 'updated_at', '16 minutes');

    const requeued = await service.requeueStuckUploads();

    expect(requeued).toBe(1);
    expect(await queuedJobIds()).toEqual([stuck.id]);
    const job = await queue.getJob(stuck.id);
    expect(job?.name).toBe(PROCESS_VIDEO_JOB);
    expect(job?.data).toEqual({ videoId: stuck.id });
    expect(await queuedJobIds()).not.toContain(recent.id);
  });

  it('should be safe to run twice without failing or duplicating jobs', async () => {
    const draft = await seedVideo(VideoProcessingStatus.PENDING_UPLOAD, true);
    await ageVideo(draft, 'created_at', '25 hours');
    const stuck = await seedVideo(VideoProcessingStatus.UPLOADED, false);
    await ageVideo(stuck, 'updated_at', '16 minutes');

    for (let run = 0; run < 2; run++) {
      await service.cleanupStaleDrafts();
      await service.requeueStuckUploads();
    }

    expect(await videoRepository.findOneBy({ id: draft.id })).toBeNull();
    expect(await queuedJobIds()).toEqual([stuck.id]);
  });
});
