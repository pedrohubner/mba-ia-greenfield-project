import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { StorageService } from './storage.service';

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

describe('StorageService (signing)', () => {
  let service: StorageService;

  beforeAll(() => {
    service = new StorageService(config);
  });

  afterAll(() => {
    service.onModuleDestroy();
  });

  it('signs upload part URLs with the public endpoint host', async () => {
    const url = new URL(
      await service.signUploadPartUrl(
        'videos/abc/original.mp4',
        'upload-1',
        3,
        3600,
      ),
    );

    expect(url.host).toBe('public.storage.test:9100');
    expect(url.pathname).toBe('/streamtube-media/videos/abc/original.mp4');
    expect(url.searchParams.get('partNumber')).toBe('3');
    expect(url.searchParams.get('uploadId')).toBe('upload-1');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('3600');
  });

  it('signs GET URLs with the public endpoint host for the public audience', async () => {
    const url = new URL(
      await service.signGetObjectUrl('videos/abc/original.mp4', {
        audience: 'public',
        ttlSeconds: 21600,
      }),
    );

    expect(url.host).toBe('public.storage.test:9100');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('21600');
    expect(url.searchParams.has('response-content-disposition')).toBe(false);
  });

  it('signs GET URLs with the internal endpoint host for the internal audience', async () => {
    const url = new URL(
      await service.signGetObjectUrl('videos/abc/original.mp4', {
        audience: 'internal',
        ttlSeconds: 900,
      }),
    );

    expect(url.host).toBe('minio:9000');
  });

  it('includes response-content-disposition when a content disposition is given', async () => {
    const disposition = 'attachment; filename="my video.mp4"';
    const url = new URL(
      await service.signGetObjectUrl('videos/abc/original.mp4', {
        audience: 'public',
        ttlSeconds: 900,
        contentDisposition: disposition,
      }),
    );

    expect(url.searchParams.get('response-content-disposition')).toBe(
      disposition,
    );
  });
});
