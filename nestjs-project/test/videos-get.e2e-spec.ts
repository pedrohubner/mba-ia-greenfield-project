import { execFile } from 'child_process';
import request from 'supertest';
import { promisify } from 'util';
import { StorageService } from '../src/storage/storage.service';
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
import { generatePublicId } from '../src/videos/public-id.util';
import { VIDEO_STORAGE_KEYS } from '../src/videos/videos.constants';

const execFileAsync = promisify(execFile);

const INTERNAL_FIELDS = [
  'id',
  'channel_id',
  'object_key',
  'upload_id',
  'thumbnail_key',
];

const METADATA_FIELDS = [
  'duration_seconds',
  'width',
  'height',
  'video_codec',
  'audio_codec',
  'container_format',
  'bitrate',
  'processing_error',
  'thumbnail_url',
];

interface VideoBody extends Record<string, unknown> {
  public_id: string;
  processing_status: string;
  processing_error: string | null;
  thumbnail_url: string | null;
}

interface ErrorBody {
  statusCode: number;
  error: string;
  message: unknown;
}

async function tinyJpeg(): Promise<Buffer> {
  const { stdout } = await execFileAsync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=16x16',
      '-frames:v',
      '1',
      '-f',
      'image2',
      '-c:v',
      'mjpeg',
      'pipe:1',
    ],
    { encoding: 'buffer' },
  );
  return stdout;
}

describe('videos-get', () => {
  let ctx: E2eContext;
  let owner: AuthenticatedUser;
  let other: AuthenticatedUser;

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
    owner = await createAuthenticatedUser(ctx, 'get_owner');
    other = await createAuthenticatedUser(ctx, 'get_other');
  });

  async function seedVideo(overrides: Partial<Video>): Promise<Video> {
    const repository = ctx.dataSource.getRepository(Video);
    const id = crypto.randomUUID();
    return repository.save(
      repository.create({
        id,
        public_id: generatePublicId(),
        channel_id: owner.channel.id,
        title: 'Aula semeada',
        original_filename: 'aula.mp4',
        content_type: 'video/mp4',
        size_bytes: 10485760,
        object_key: VIDEO_STORAGE_KEYS.original(id, 'mp4'),
        ...overrides,
      }),
    );
  }

  function getVideo(publicId: string, token?: string) {
    const req = request(ctx.app.getHttpServer()).get(`/videos/${publicId}`);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  }

  it('rascunho-com-metadados-nulos', async () => {
    const created = await request(ctx.app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        filename: 'aula.mp4',
        size_bytes: 10485760,
        content_type: 'video/mp4',
      })
      .expect(201);
    const publicId = (created.body as { video: VideoBody }).video.public_id;

    const res = await getVideo(publicId, owner.accessToken).expect(200);

    const body = res.body as VideoBody;
    expect(body.processing_status).toBe('pending_upload');
    for (const field of METADATA_FIELDS) {
      expect(body[field]).toBeNull();
    }
    for (const field of INTERNAL_FIELDS) {
      expect(body).not.toHaveProperty(field);
    }
  });

  it('video-ready-com-thumbnail-assinada', async () => {
    const id = crypto.randomUUID();
    const thumbnailKey = VIDEO_STORAGE_KEYS.autoThumbnail(id);
    await ctx.app
      .get(StorageService)
      .putObject(thumbnailKey, await tinyJpeg(), 'image/jpeg');
    const video = await seedVideo({
      id,
      object_key: VIDEO_STORAGE_KEYS.original(id, 'mp4'),
      processing_status: VideoProcessingStatus.READY,
      thumbnail_key: thumbnailKey,
      duration_seconds: 3,
      width: 1920,
      height: 1080,
      video_codec: 'h264',
      audio_codec: 'aac',
      container_format: 'mov,mp4,m4a,3gp,3g2,mj2',
      bitrate: 1500000,
    });

    const res = await getVideo(video.public_id, owner.accessToken).expect(200);

    const body = res.body as VideoBody;
    expect(body).toMatchObject({
      processing_status: 'ready',
      duration_seconds: 3,
      width: 1920,
      height: 1080,
      video_codec: 'h264',
      audio_codec: 'aac',
      bitrate: 1500000,
    });
    expect(body.thumbnail_url).toBeTruthy();

    const thumbnail = await fetch(body.thumbnail_url!);
    expect(thumbnail.status).toBe(200);
    expect(thumbnail.headers.get('content-type')).toBe('image/jpeg');
  });

  it('video-failed-expoe-reason-code', async () => {
    const video = await seedVideo({
      processing_status: VideoProcessingStatus.FAILED,
      processing_error: 'INVALID_MEDIA',
    });

    const res = await getVideo(video.public_id, owner.accessToken).expect(200);

    expect(res.body).toMatchObject({
      processing_status: 'failed',
      processing_error: 'INVALID_MEDIA',
    });
  });

  it('outro-usuario-malformado-e-sem-token', async () => {
    const video = await seedVideo({});

    const foreign = await getVideo(video.public_id, other.accessToken).expect(
      404,
    );
    expect((foreign.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');

    const malformed = await getVideo('abc', owner.accessToken).expect(404);
    expect((malformed.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');

    await getVideo(video.public_id).expect(401);
  });
});
