import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import {
  Video,
  VideoProcessingStatus,
  VideoPublicationStatus,
} from './entities/video.entity';
import { presentVideo, toVideoResponse } from './video.presenter';

const config: ConfigType<typeof storageConfig> = {
  endpoint: 'http://minio:9000',
  publicEndpoint: 'http://public.storage.test:9100',
  region: 'us-east-1',
  accessKey: 'access-key',
  secretKey: 'secret-key',
  bucket: 'streamtube-media',
  partSizeBytes: 5242880,
  partUrlTtlSeconds: 3600,
  playbackUrlTtlSeconds: 21600,
  downloadUrlTtlSeconds: 900,
  thumbnailUrlTtlSeconds: 3600,
};

function buildVideo(overrides: Partial<Video> = {}): Video {
  return Object.assign(new Video(), {
    id: '7b1e2a0c-1111-4c6e-9a8b-000000000001',
    public_id: 'AbCdEfGhIjK',
    channel_id: '7b1e2a0c-2222-4c6e-9a8b-000000000002',
    title: 'Minha aula',
    original_filename: 'aula.mp4',
    content_type: 'video/mp4',
    size_bytes: 10485760,
    object_key: 'videos/7b1e2a0c-1111-4c6e-9a8b-000000000001/original.mp4',
    upload_id: null,
    thumbnail_key: null,
    processing_status: VideoProcessingStatus.READY,
    publication_status: VideoPublicationStatus.DRAFT,
    processing_error: null,
    duration_seconds: 3,
    width: 1920,
    height: 1080,
    video_codec: 'h264',
    audio_codec: 'aac',
    container_format: 'mov,mp4,m4a,3gp,3g2,mj2',
    bitrate: 1500000,
    created_at: new Date('2026-10-09T10:00:00.000Z'),
    updated_at: new Date('2026-10-09T10:05:00.000Z'),
    ...overrides,
  });
}

describe('toVideoResponse', () => {
  it('should return exactly the public Video shape', () => {
    expect(toVideoResponse(buildVideo(), null)).toEqual({
      public_id: 'AbCdEfGhIjK',
      title: 'Minha aula',
      original_filename: 'aula.mp4',
      content_type: 'video/mp4',
      size_bytes: 10485760,
      processing_status: 'ready',
      publication_status: 'draft',
      processing_error: null,
      duration_seconds: 3,
      width: 1920,
      height: 1080,
      video_codec: 'h264',
      audio_codec: 'aac',
      container_format: 'mov,mp4,m4a,3gp,3g2,mj2',
      bitrate: 1500000,
      thumbnail_url: null,
      created_at: '2026-10-09T10:00:00.000Z',
      updated_at: '2026-10-09T10:05:00.000Z',
    });
  });

  it('should never serialize internal fields', () => {
    const response = toVideoResponse(
      buildVideo({
        upload_id: 'upload-1',
        thumbnail_key: 'thumbnails/x/auto.jpg',
      }),
      'https://signed',
    );

    for (const key of [
      'id',
      'channel_id',
      'object_key',
      'upload_id',
      'thumbnail_key',
    ]) {
      expect(response).not.toHaveProperty(key);
    }
  });

  it('should expose processing_error when the video failed', () => {
    const response = toVideoResponse(
      buildVideo({
        processing_status: VideoProcessingStatus.FAILED,
        processing_error: 'INVALID_MEDIA',
      }),
      null,
    );

    expect(response.processing_error).toBe('INVALID_MEDIA');
  });

  it('should hide a stale processing_error when the video is not failed', () => {
    const response = toVideoResponse(
      buildVideo({
        processing_status: VideoProcessingStatus.PROCESSING,
        processing_error: 'PROCESSING_ERROR',
      }),
      null,
    );

    expect(response.processing_error).toBeNull();
  });
});

describe('presentVideo', () => {
  let storageService: StorageService;

  beforeAll(() => {
    storageService = new StorageService(config);
  });

  afterAll(() => {
    storageService.onModuleDestroy();
  });

  it('should leave thumbnail_url null without a thumbnail_key', async () => {
    const response = await presentVideo(buildVideo(), storageService, 3600);

    expect(response.thumbnail_url).toBeNull();
  });

  it('should sign the thumbnail on the public host with the thumbnail TTL', async () => {
    const response = await presentVideo(
      buildVideo({ thumbnail_key: 'thumbnails/abc/auto.jpg' }),
      storageService,
      3600,
    );

    const url = new URL(response.thumbnail_url!);
    expect(url.host).toBe('public.storage.test:9100');
    expect(url.pathname).toBe('/streamtube-media/thumbnails/abc/auto.jpg');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('3600');
  });
});
