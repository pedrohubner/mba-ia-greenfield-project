import { getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import { readFile } from 'fs/promises';
import request from 'supertest';
import { cleanAllTables } from '../src/test/create-test-data-source';
import {
  createAuthenticatedUser,
  createE2eApp,
  type AuthenticatedUser,
  type E2eContext,
} from '../src/test/e2e-app';
import {
  createMultipartMp4Fixture,
  type MultipartMp4Fixture,
} from '../src/test/media-fixtures';
import { cleanupVideoStorage } from '../src/test/storage';
import { VIDEO_PROCESSING_QUEUE } from '../src/video-processing/video-processing.constants';
import { VideoProcessingService } from '../src/video-processing/video-processing.service';
import { WorkerModule } from '../src/video-processing/worker.module';
import {
  Video,
  VideoProcessingStatus,
} from '../src/videos/entities/video.entity';
import { generatePublicId } from '../src/videos/public-id.util';
import { VIDEO_STORAGE_KEYS } from '../src/videos/videos.constants';

const PART_SIZE = 5242880;

interface VideoBody {
  public_id: string;
  processing_status: string;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  video_codec: string | null;
}

interface PresignedBody {
  url: string;
  expires_at: string;
}

interface ErrorBody {
  statusCode: number;
  error: string;
  message: unknown;
}

function expectExpiresIn(expiresAt: string, seconds: number): void {
  const delta = new Date(expiresAt).getTime() - Date.now();
  expect(delta).toBeGreaterThan((seconds - 10) * 1000);
  expect(delta).toBeLessThanOrEqual(seconds * 1000);
}

describe('videos-playback-download', () => {
  let ctx: E2eContext;
  let workerModule: TestingModule;
  let processingService: VideoProcessingService;
  let queue: Queue;
  let fixture: MultipartMp4Fixture;
  let owner: AuthenticatedUser;
  let other: AuthenticatedUser;

  beforeAll(async () => {
    ctx = await createE2eApp();
    queue = ctx.app.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
    workerModule = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    processingService = workerModule.get(VideoProcessingService);
    fixture = await createMultipartMp4Fixture();
  }, 120000);

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await cleanupVideoStorage(ctx.dataSource);
    await cleanAllTables(ctx.dataSource);
    await fixture.cleanup();
    await workerModule.close();
    await ctx.app.close();
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
    await cleanupVideoStorage(ctx.dataSource);
    await cleanAllTables(ctx.dataSource);
    ctx.resetThrottling();
    owner = await createAuthenticatedUser(ctx, 'playback_owner');
    other = await createAuthenticatedUser(ctx, 'playback_other');
  });

  function authed(
    method: 'get' | 'post',
    path: string,
    token: string | null = owner.accessToken,
  ) {
    const req = request(ctx.app.getHttpServer())[method](path);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  }

  async function seedVideo(status: VideoProcessingStatus): Promise<Video> {
    const repository = ctx.dataSource.getRepository(Video);
    const id = crypto.randomUUID();
    return repository.save(
      repository.create({
        id,
        public_id: generatePublicId(),
        channel_id: owner.channel.id,
        title: 'Semeado',
        original_filename: 'semeado.mp4',
        content_type: 'video/mp4',
        size_bytes: 1024,
        object_key: VIDEO_STORAGE_KEYS.original(id, 'mp4'),
        processing_status: status,
      }),
    );
  }

  it('fluxo-completo-upload-processamento-streaming-download', async () => {
    const file = await readFile(fixture.path);

    const created = await authed('post', '/videos')
      .send({
        filename: 'fluxo.mp4',
        size_bytes: file.length,
        content_type: 'video/mp4',
        title: 'Fluxo completo',
      })
      .expect(201);
    const createdBody = created.body as {
      video: VideoBody;
      upload: { part_count: number };
    };
    expect(createdBody.upload.part_count).toBe(2);
    const publicId = createdBody.video.public_id;

    const signed = await authed('post', `/videos/${publicId}/upload/part-urls`)
      .send({ part_numbers: [1, 2] })
      .expect(200);
    const parts: { part_number: number; etag: string }[] = [];
    for (const part of (
      signed.body as { parts: { part_number: number; url: string }[] }
    ).parts) {
      const start = (part.part_number - 1) * PART_SIZE;
      const response = await fetch(part.url, {
        method: 'PUT',
        body: new Uint8Array(file.subarray(start, start + PART_SIZE)),
      });
      expect(response.status).toBe(200);
      const etag = response.headers.get('etag');
      expect(etag).toBeTruthy();
      parts.push({ part_number: part.part_number, etag: etag! });
    }

    const completed = await authed(
      'post',
      `/videos/${publicId}/upload/complete`,
    )
      .send({ parts })
      .expect(200);
    expect((completed.body as VideoBody).processing_status).toBe('uploaded');

    const row = await ctx.dataSource
      .getRepository(Video)
      .findOneByOrFail({ public_id: publicId });
    await processingService.process(row.id);
    const processed = await authed('get', `/videos/${publicId}`).expect(200);
    const processedBody = processed.body as VideoBody;
    expect(processedBody.processing_status).toBe('ready');
    expect(processedBody.duration_seconds).toBeGreaterThan(0);
    expect(processedBody.width).toBe(1280);
    expect(processedBody.height).toBe(720);
    expect(processedBody.video_codec).toBe('h264');

    const playback = await authed('get', `/videos/${publicId}/playback`).expect(
      200,
    );
    const playbackBody = playback.body as PresignedBody;
    expect(playbackBody.url).toBeTruthy();
    expectExpiresIn(playbackBody.expires_at, 21600);

    const ranged = await fetch(playbackBody.url, {
      headers: { Range: 'bytes=0-1023' },
    });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-range')).toBe(
      `bytes 0-1023/${file.length}`,
    );
    expect((await ranged.arrayBuffer()).byteLength).toBe(1024);

    const download = await authed('get', `/videos/${publicId}/download`).expect(
      200,
    );
    const downloadBody = download.body as PresignedBody;
    expectExpiresIn(downloadBody.expires_at, 900);

    const downloaded = await fetch(downloadBody.url);
    expect(downloaded.status).toBe(200);
    const disposition = downloaded.headers.get('content-disposition')!;
    expect(disposition.startsWith('attachment')).toBe(true);
    expect(disposition).toContain('Fluxo completo.mp4');
    await downloaded.arrayBuffer();
  });

  it('antes-de-ready-409', async () => {
    const video = await seedVideo(VideoProcessingStatus.PROCESSING);

    const playback = await authed(
      'get',
      `/videos/${video.public_id}/playback`,
    ).expect(409);
    expect((playback.body as ErrorBody).error).toBe('VIDEO_NOT_READY');

    const download = await authed(
      'get',
      `/videos/${video.public_id}/download`,
    ).expect(409);
    expect((download.body as ErrorBody).error).toBe('VIDEO_NOT_READY');
  });

  it('outro-usuario-404-e-sem-token-401', async () => {
    const video = await seedVideo(VideoProcessingStatus.READY);

    const foreign = await authed(
      'get',
      `/videos/${video.public_id}/playback`,
      other.accessToken,
    ).expect(404);
    expect((foreign.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');

    await authed('get', `/videos/${video.public_id}/playback`, null).expect(
      401,
    );
    await authed('get', `/videos/${video.public_id}/download`, null).expect(
      401,
    );
  });
});
