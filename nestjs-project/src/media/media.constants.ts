export const MEDIA_REASON_CODES = {
  INVALID_MEDIA: 'INVALID_MEDIA',
  UNSUPPORTED_CODEC: 'UNSUPPORTED_CODEC',
} as const;

export type MediaReasonCode =
  (typeof MEDIA_REASON_CODES)[keyof typeof MEDIA_REASON_CODES];

export const FFPROBE_TIMEOUT_MS = 120_000;

export const FFMPEG_TIMEOUT_MS = 120_000;

export const THUMBNAIL_MAX_BUFFER_BYTES = 20 * 1024 * 1024;

export const THUMBNAIL_MAX_WIDTH = 1280;

export const PLAYABLE_FORMATS = [
  { container: 'mp4', videoCodecs: ['h264'] },
  { container: 'webm', videoCodecs: ['vp8', 'vp9', 'av1'] },
] as const;
