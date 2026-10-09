import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { createTestBullRootModule } from '../test/queue';
import { cleanupVideoStorage } from '../test/storage';
import { User } from '../users/entities/user.entity';
import { Video, VideoProcessingStatus } from './entities/video.entity';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService (integration)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let videosService: VideosService;
  let storageService: StorageService;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        createTestBullRootModule(),
        VideosModule,
      ],
    }).compile();

    dataSource = module.get(DataSource);
    videosService = module.get(VideosService);
    storageService = module.get(StorageService);
  });

  afterAll(async () => {
    await cleanupVideoStorage(dataSource);
    await cleanAllTables(dataSource);
    await module.close();
  });

  beforeEach(async () => {
    await cleanupVideoStorage(dataSource);
    await cleanAllTables(dataSource);
  });

  async function createUserWithChannel(): Promise<{
    user: User;
    channel: Channel;
  }> {
    const user = await dataSource.getRepository(User).save({
      email: `videos_svc_${Date.now()}@example.com`,
      password: 'hashed',
    });
    const channel = await dataSource.getRepository(Channel).save({
      name: 'Videos',
      nickname: `videos-svc-${Date.now()}`,
      user_id: user.id,
    });
    return { user, channel };
  }

  it("should persist the draft in the caller's channel with an open multipart upload", async () => {
    const { user, channel } = await createUserWithChannel();

    const result = await videosService.initiateUpload(user.id, {
      filename: 'aula.mp4',
      size_bytes: 10485760,
      content_type: 'video/mp4',
    });

    const row = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ public_id: result.video.public_id });
    expect(row).toMatchObject({
      channel_id: channel.id,
      title: 'aula',
      size_bytes: 10485760,
      processing_status: VideoProcessingStatus.PENDING_UPLOAD,
      object_key: `videos/${row.id}/original.mp4`,
    });
    expect(row.upload_id).toBeTruthy();
    await expect(
      storageService.listParts(row.object_key, row.upload_id!),
    ).resolves.toEqual([]);
  });

  it('should sign part URLs, list only the uploaded parts and re-sign the missing one', async () => {
    const { user } = await createUserWithChannel();
    const partSize = 5 * 1024 * 1024;
    const { video } = await videosService.initiateUpload(user.id, {
      filename: 'retomada.mp4',
      size_bytes: 3 * partSize,
      content_type: 'video/mp4',
    });

    const signed = await videosService.signPartUrls(
      user.id,
      video.public_id,
      [1, 2, 3],
    );
    const etags: string[] = [];
    for (const part of signed.parts.slice(0, 2)) {
      const response = await fetch(part.url, {
        method: 'PUT',
        body: new Uint8Array(Buffer.alloc(partSize, part.part_number)),
      });
      expect(response.status).toBe(200);
      etags.push(response.headers.get('etag')!);
    }

    const uploaded = await videosService.listUploadedParts(
      user.id,
      video.public_id,
    );
    expect(uploaded).toEqual({
      part_size: partSize,
      part_count: 3,
      parts: [
        { part_number: 1, etag: etags[0], size: partSize },
        { part_number: 2, etag: etags[1], size: partSize },
      ],
    });

    const missing = await videosService.signPartUrls(
      user.id,
      video.public_id,
      [3],
    );
    const response = await fetch(missing.parts[0].url, {
      method: 'PUT',
      body: new Uint8Array(Buffer.alloc(1024, 3)),
    });
    expect(response.status).toBe(200);
    const afterResume = await videosService.listUploadedParts(
      user.id,
      video.public_id,
    );
    expect(afterResume.parts.map((part) => part.part_number)).toEqual([
      1, 2, 3,
    ]);
  });
});
