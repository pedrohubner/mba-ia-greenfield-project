import type { DefaultJobOptions } from 'bullmq';

export const VIDEO_PROCESSING_QUEUE = 'video-processing';

export const PROCESS_VIDEO_JOB = 'process-video';

export const CLEANUP_STALE_UPLOADS_JOB = 'cleanup-stale-uploads';

export const PROCESSING_ERROR_REASON = 'PROCESSING_ERROR';

export const WORKER_SOURCE_URL_TTL_SECONDS = 3600;

export interface ProcessVideoJobData {
  videoId: string;
}

export const VIDEO_PROCESSING_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: { age: 86400 },
  removeOnFail: { age: 604800 },
} as const satisfies DefaultJobOptions;
