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
  Video,
  VideoProcessingStatus,
} from '../src/videos/entities/video.entity';

const PART_SIZE = 5242880;

interface ErrorBody {
  statusCode: number;
  error: string;
  message: unknown;
}

interface PartUrlsBody {
  parts: { part_number: number; url: string }[];
  expires_at: string;
}

interface UploadedPartsBody {
  part_size: number;
  part_count: number;
  parts: { part_number: number; etag: string; size: number }[];
}

describe('videos-upload-parts', () => {
  let ctx: E2eContext;
  let owner: AuthenticatedUser;
  let other: AuthenticatedUser;
  let publicId: string;

  beforeAll(async () => {
    ctx = await createE2eApp();
  });

  afterAll(async () => {
    await cleanupVideoStorage(ctx.dataSource);
    await cleanAllTables(ctx.dataSource);
    await ctx.app.close();
  });

  beforeEach(async () => {
    await cleanupVideoStorage(ctx.dataSource);
    await cleanAllTables(ctx.dataSource);
    ctx.resetThrottling();
    owner = await createAuthenticatedUser(ctx, 'parts_owner');
    other = await createAuthenticatedUser(ctx, 'parts_other');

    const res = await request(ctx.app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        filename: 'aula.mp4',
        size_bytes: 3 * PART_SIZE,
        content_type: 'video/mp4',
      })
      .expect(201);
    publicId = (res.body as { video: { public_id: string } }).video.public_id;
  });

  function signParts(token: string, partNumbers: unknown) {
    return request(ctx.app.getHttpServer())
      .post(`/videos/${publicId}/upload/part-urls`)
      .set('Authorization', `Bearer ${token}`)
      .send({ part_numbers: partNumbers });
  }

  function listParts(token: string, id = publicId) {
    return request(ctx.app.getHttpServer())
      .get(`/videos/${id}/upload/parts`)
      .set('Authorization', `Bearer ${token}`);
  }

  it('assina-lote-de-partes', async () => {
    const before = Date.now();

    const res = await signParts(owner.accessToken, [1, 2]).expect(200);

    const body = res.body as PartUrlsBody;
    expect(body.parts.map((part) => part.part_number)).toEqual([1, 2]);
    for (const part of body.parts) {
      expect(part.url).toBeTruthy();
    }
    const expiresIn = new Date(body.expires_at).getTime() - before;
    expect(expiresIn).toBeGreaterThanOrEqual(3600 * 1000 - 5000);
    expect(expiresIn).toBeLessThanOrEqual(3600 * 1000 + 5000);
  });

  it('lista-partes-enviadas-para-retomada', async () => {
    const signed = (await signParts(owner.accessToken, [1, 2, 3]).expect(200))
      .body as PartUrlsBody;

    const etags: string[] = [];
    for (const part of signed.parts.slice(0, 2)) {
      const response = await fetch(part.url, {
        method: 'PUT',
        body: new Uint8Array(Buffer.alloc(PART_SIZE, part.part_number)),
      });
      expect(response.status).toBe(200);
      const etag = response.headers.get('etag');
      expect(etag).toBeTruthy();
      etags.push(etag!);
    }

    const res = await listParts(owner.accessToken).expect(200);

    const body = res.body as UploadedPartsBody;
    expect(body.part_count).toBe(3);
    expect(body.part_size).toBe(PART_SIZE);
    expect(body.parts).toEqual([
      { part_number: 1, etag: etags[0], size: PART_SIZE },
      { part_number: 2, etag: etags[1], size: PART_SIZE },
    ]);
  });

  it('parte-acima-de-part-count-422', async () => {
    const res = await signParts(owner.accessToken, [4]).expect(422);

    expect((res.body as ErrorBody).error).toBe('INVALID_UPLOAD_PARTS');
  });

  it('validation-pipe-lista-vazia-ou-duplicada', async () => {
    const empty = await signParts(owner.accessToken, []).expect(400);
    expect((empty.body as ErrorBody).error).toBe('VALIDATION_ERROR');

    const duplicated = await signParts(owner.accessToken, [1, 1]).expect(400);
    expect((duplicated.body as ErrorBody).error).toBe('VALIDATION_ERROR');
  });

  it('outro-usuario-e-inexistente-404-identicos', async () => {
    const foreign = await listParts(other.accessToken).expect(404);
    expect((foreign.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');

    const missing = await listParts(owner.accessToken, 'AAAAAAAAAAA').expect(
      404,
    );
    expect(missing.body).toEqual(foreign.body);

    const foreignSign = await signParts(other.accessToken, [1]).expect(404);
    expect((foreignSign.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');
  });

  it('estado-uploaded-409', async () => {
    await ctx.dataSource
      .getRepository(Video)
      .update(
        { public_id: publicId },
        { processing_status: VideoProcessingStatus.UPLOADED },
      );

    const sign = await signParts(owner.accessToken, [1]).expect(409);
    expect((sign.body as ErrorBody).error).toBe('INVALID_UPLOAD_STATE');

    const list = await listParts(owner.accessToken).expect(409);
    expect((list.body as ErrorBody).error).toBe('INVALID_UPLOAD_STATE');
  });

  it('sem-token-401-nas-duas-rotas', async () => {
    await request(ctx.app.getHttpServer())
      .post(`/videos/${publicId}/upload/part-urls`)
      .send({ part_numbers: [1] })
      .expect(401);

    await request(ctx.app.getHttpServer())
      .get(`/videos/${publicId}/upload/parts`)
      .expect(401);
  });
});
