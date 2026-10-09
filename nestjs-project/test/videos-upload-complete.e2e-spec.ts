import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import request from 'supertest';
import { cleanAllTables } from '../src/test/create-test-data-source';
import {
  createAuthenticatedUser,
  createE2eApp,
  type AuthenticatedUser,
  type E2eContext,
} from '../src/test/e2e-app';
import { cleanupVideoStorage } from '../src/test/storage';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
} from '../src/video-processing/video-processing.constants';
import {
  Video,
  VideoProcessingStatus,
} from '../src/videos/entities/video.entity';

const PART_SIZE = 5242880;

interface UploadedPart {
  part_number: number;
  etag: string;
}

interface VideoBody {
  public_id: string;
  processing_status: string;
  size_bytes: number;
}

interface ErrorBody {
  statusCode: number;
  error: string;
  message: unknown;
}

describe('videos-upload-complete', () => {
  let ctx: E2eContext;
  let queue: Queue;
  let owner: AuthenticatedUser;
  let publicId: string;

  beforeAll(async () => {
    ctx = await createE2eApp();
    queue = ctx.app.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await cleanupVideoStorage(ctx.dataSource);
    await cleanAllTables(ctx.dataSource);
    await ctx.app.close();
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
    await cleanupVideoStorage(ctx.dataSource);
    await cleanAllTables(ctx.dataSource);
    ctx.resetThrottling();
    owner = await createAuthenticatedUser(ctx, 'complete_owner');

    const res = await request(ctx.app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        filename: 'aula.mp4',
        size_bytes: 2 * PART_SIZE,
        content_type: 'video/mp4',
      })
      .expect(201);
    publicId = (res.body as { video: VideoBody }).video.public_id;
  });

  async function uploadBothParts(): Promise<UploadedPart[]> {
    const signed = await request(ctx.app.getHttpServer())
      .post(`/videos/${publicId}/upload/part-urls`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ part_numbers: [1, 2] })
      .expect(200);

    const parts: UploadedPart[] = [];
    for (const part of (
      signed.body as { parts: { part_number: number; url: string }[] }
    ).parts) {
      const response = await fetch(part.url, {
        method: 'PUT',
        body: new Uint8Array(Buffer.alloc(PART_SIZE, part.part_number)),
      });
      expect(response.status).toBe(200);
      parts.push({
        part_number: part.part_number,
        etag: response.headers.get('etag')!,
      });
    }
    return parts;
  }

  function complete(body: unknown, token: string | null = owner.accessToken) {
    const req = request(ctx.app.getHttpServer())
      .post(`/videos/${publicId}/upload/complete`)
      .send(body as object);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  }

  function abort(token: string | null = owner.accessToken) {
    const req = request(ctx.app.getHttpServer()).delete(
      `/videos/${publicId}/upload`,
    );
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  }

  function findRow(): Promise<Video> {
    return ctx.dataSource
      .getRepository(Video)
      .findOneByOrFail({ public_id: publicId });
  }

  async function jobsForVideo(videoId: string) {
    const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
    return jobs.filter((job) => job.id === videoId);
  }

  it('complete-move-para-uploaded', async () => {
    const [first, second] = await uploadBothParts();

    const res = await complete({ parts: [second, first] }).expect(200);

    const body = res.body as VideoBody;
    expect(body.processing_status).toBe('uploaded');
    expect(body.size_bytes).toBe(10485760);
    expect((await findRow()).upload_id).toBeNull();
  });

  it('job-unico-e-complete-idempotente', async () => {
    const parts = await uploadBothParts();
    await complete({ parts }).expect(200);
    const row = await findRow();

    const jobs = await jobsForVideo(row.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe(PROCESS_VIDEO_JOB);
    expect(jobs[0].data).toEqual({ videoId: row.id });

    const again = await complete({ parts }).expect(200);
    expect((again.body as VideoBody).processing_status).toBe('uploaded');
    expect(await jobsForVideo(row.id)).toHaveLength(1);
  });

  it('partes-invalidas-422', async () => {
    const [first, second] = await uploadBothParts();

    const missing = await complete({
      parts: [
        first,
        second,
        { part_number: 3, etag: '"0123456789abcdef0123456789abcdef"' },
      ],
    }).expect(422);
    expect((missing.body as ErrorBody).error).toBe('INVALID_UPLOAD_PARTS');

    const wrongEtag = await complete({
      parts: [{ part_number: 1, etag: '"deadbeef"' }, second],
    }).expect(422);
    expect((wrongEtag.body as ErrorBody).error).toBe('INVALID_UPLOAD_PARTS');

    const res = await request(ctx.app.getHttpServer())
      .get(`/videos/${publicId}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect((res.body as VideoBody).processing_status).toBe('pending_upload');
  });

  it('complete-de-video-ready-409', async () => {
    const parts = await uploadBothParts();
    await ctx.dataSource
      .getRepository(Video)
      .update(
        { public_id: publicId },
        { processing_status: VideoProcessingStatus.READY },
      );

    const res = await complete({ parts }).expect(409);

    expect((res.body as ErrorBody).error).toBe('INVALID_UPLOAD_STATE');
  });

  it('validation-pipe-parts-ausente-e-sem-token', async () => {
    const invalid = await complete({}).expect(400);
    expect((invalid.body as ErrorBody).error).toBe('VALIDATION_ERROR');

    await complete({ parts: [{ part_number: 1, etag: '"a"' }] }, null).expect(
      401,
    );
  });

  it('abort-remove-rascunho', async () => {
    const res = await abort().expect(204);
    expect(res.text).toBe('');

    const after = await request(ctx.app.getHttpServer())
      .get(`/videos/${publicId}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(404);
    expect((after.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');
  });

  it('abort-de-video-uploaded-409-e-sem-token', async () => {
    const parts = await uploadBothParts();
    await complete({ parts }).expect(200);

    const res = await abort().expect(409);
    expect((res.body as ErrorBody).error).toBe('INVALID_UPLOAD_STATE');

    await abort(null).expect(401);
  });
});
