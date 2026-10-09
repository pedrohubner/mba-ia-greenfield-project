import request from 'supertest';
import { Video } from '../src/videos/entities/video.entity';
import { cleanAllTables } from '../src/test/create-test-data-source';
import {
  createAuthenticatedUser,
  createE2eApp,
  type AuthenticatedUser,
  type E2eContext,
} from '../src/test/e2e-app';
import { cleanupVideoStorage } from '../src/test/storage';

interface InitiateUploadBody {
  video: Record<string, unknown> & {
    public_id: string;
    title: string;
    processing_status: string;
    publication_status: string;
  };
  upload: { part_size: number; part_count: number };
}

interface ErrorBody {
  statusCode: number;
  error: string;
  message: unknown;
}

const INTERNAL_FIELDS = [
  'id',
  'channel_id',
  'object_key',
  'upload_id',
  'thumbnail_key',
];

const validBody = {
  filename: 'aula.mp4',
  size_bytes: 10485760,
  content_type: 'video/mp4',
};

describe('videos-create', () => {
  let ctx: E2eContext;
  let owner: AuthenticatedUser;

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
    owner = await createAuthenticatedUser(ctx, 'videos_create');
  });

  function countVideos(): Promise<number> {
    return ctx.dataSource.getRepository(Video).count();
  }

  it('cria-rascunho-com-titulo-derivado-do-arquivo', async () => {
    const res = await request(ctx.app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send(validBody)
      .expect(201);

    const body = res.body as InitiateUploadBody;
    expect(body.video.processing_status).toBe('pending_upload');
    expect(body.video.publication_status).toBe('draft');
    expect(body.video.title).toBe('aula');
    expect(body.video.public_id).toMatch(/^[A-Za-z0-9_-]{11}$/);
    expect(body.upload).toEqual({ part_size: 5242880, part_count: 2 });
    for (const field of INTERNAL_FIELDS) {
      expect(body).not.toHaveProperty(field);
      expect(body.video).not.toHaveProperty(field);
    }

    const rows = await ctx.dataSource
      .getRepository(Video)
      .findBy({ public_id: body.video.public_id });
    expect(rows).toHaveLength(1);
    expect(rows[0].channel_id).toBe(owner.channel.id);
    expect(rows[0].upload_id).toBeTruthy();
  });

  it('titulo-informado-e-aparado', async () => {
    const res = await request(ctx.app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ ...validBody, title: '  Minha aula  ' })
      .expect(201);

    expect((res.body as InitiateUploadBody).video.title).toBe('Minha aula');
  });

  it('formato-nao-suportado-415', async () => {
    const res = await request(ctx.app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        filename: 'aula.mkv',
        size_bytes: 10485760,
        content_type: 'video/x-matroska',
      })
      .expect(415);

    const body = res.body as ErrorBody;
    expect(body).toMatchObject({
      statusCode: 415,
      error: 'UNSUPPORTED_MEDIA_TYPE',
    });
    expect(typeof body.message).toBe('string');
    expect(await countVideos()).toBe(0);
  });

  it('validation-pipe-tamanho-acima-de-10-gib', async () => {
    const res = await request(ctx.app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        filename: 'grande.mp4',
        size_bytes: 10737418241,
        content_type: 'video/mp4',
      })
      .expect(400);

    const body = res.body as ErrorBody;
    expect(body.error).toBe('VALIDATION_ERROR');
    expect(Array.isArray(body.message)).toBe(true);
    expect((body.message as string[]).join(' ')).toContain('size_bytes');
  });

  it('sem-token-401', async () => {
    await request(ctx.app.getHttpServer())
      .post('/videos')
      .send(validBody)
      .expect(401);

    expect(await countVideos()).toBe(0);
  });
});
