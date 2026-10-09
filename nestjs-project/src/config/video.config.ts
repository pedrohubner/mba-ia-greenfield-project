import { registerAs } from '@nestjs/config';

export default registerAs('video', () => ({
  workerConcurrency: parseInt(process.env.VIDEO_WORKER_CONCURRENCY || '1', 10),
  staleUploadTtlHours: parseInt(process.env.STALE_UPLOAD_TTL_HOURS || '24', 10),
  staleUploadedRequeueMinutes: parseInt(
    process.env.STALE_UPLOADED_REQUEUE_MINUTES || '15',
    10,
  ),
}));
