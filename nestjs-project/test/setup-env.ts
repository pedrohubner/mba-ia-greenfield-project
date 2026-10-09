process.env.STORAGE_PUBLIC_ENDPOINT =
  process.env.STORAGE_ENDPOINT || 'http://minio:9000';
process.env.STORAGE_PART_SIZE_BYTES = '5242880';
process.env.QUEUE_PREFIX = 'bull-test';
