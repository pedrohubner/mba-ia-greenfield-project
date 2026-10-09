import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  endpoint: process.env.STORAGE_ENDPOINT || 'http://minio:9000',
  publicEndpoint:
    process.env.STORAGE_PUBLIC_ENDPOINT || 'http://localhost:9000',
  region: process.env.STORAGE_REGION || 'us-east-1',
  accessKey: process.env.STORAGE_ACCESS_KEY!,
  secretKey: process.env.STORAGE_SECRET_KEY!,
  bucket: process.env.STORAGE_BUCKET || 'streamtube-media',
  partSizeBytes: parseInt(
    process.env.STORAGE_PART_SIZE_BYTES || '67108864',
    10,
  ),
  partUrlTtlSeconds: parseInt(
    process.env.STORAGE_PART_URL_TTL_SECONDS || '3600',
    10,
  ),
  playbackUrlTtlSeconds: parseInt(
    process.env.PLAYBACK_URL_TTL_SECONDS || '21600',
    10,
  ),
  downloadUrlTtlSeconds: parseInt(
    process.env.DOWNLOAD_URL_TTL_SECONDS || '900',
    10,
  ),
  thumbnailUrlTtlSeconds: parseInt(
    process.env.THUMBNAIL_URL_TTL_SECONDS || '3600',
    10,
  ),
}));
