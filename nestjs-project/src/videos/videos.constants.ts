export const ALLOWED_VIDEO_CONTENT_TYPES = ['video/mp4', 'video/webm'] as const;

export const MAX_VIDEO_SIZE_BYTES = 10 * 1024 * 1024 * 1024;

export const VIDEO_TITLE_MAX_LENGTH = 100;

export const VIDEO_FILENAME_MAX_LENGTH = 255;

export const PUBLIC_ID_MAX_ATTEMPTS = 5;

export const VIDEO_STORAGE_KEYS = {
  original: (videoId: string, extension: string) =>
    `videos/${videoId}/original.${extension}`,
  autoThumbnail: (videoId: string) => `thumbnails/${videoId}/auto.jpg`,
} as const;
