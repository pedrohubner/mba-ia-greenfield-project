---
libs:
  "@nestjs/bullmq":
    version: "^11.0.5"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-10-08T09:26:38-03:00"
  "bullmq":
    version: "^6.3.11"
    context7_id: "/taskforcesh/bullmq/v6.3.11"
    fetched_at: "2026-10-08T09:26:38-03:00"
  "@aws-sdk/client-s3":
    version: "^3.1147.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-10-08T09:26:38-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1147.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-10-08T09:26:38-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-08T09:21:11-03:00"
---

# Library References

Distilled from Context7 (versions checked against the npm registry on 2026-10-08). None of these packages is installed yet in `nestjs-project/package.json`; the versions above are the install targets. Focus: the surfaces `phase-03-videos` TDs actually use.

### @nestjs/bullmq

_Used by `phase-03-videos/TD-01` (queue), `TD-06` (producer), `TD-07` (worker), `TD-13` (failure events)._

- **Compatibility:** pinned to `^11.0.5` (per `phase-03-videos/TD-01` revision 2026-10-09). `12.0.0` peers on NestJS 11 too, but it is ESM-only (`"type": "module"`) and the project's ts-jest (CommonJS) cannot load it. `11.0.5` is CommonJS and peers on `@nestjs/common|core ^10 || ^11` and `bullmq ^3 || ^4 || ^5 || ^6`.
- **Root connection:** `BullModule.forRootAsync({ imports, inject, useFactory })` registers a **global** shared config (`connection`, `defaultJobOptions`, …). This fits the inherited convention: inject a `registerAs` namespace (e.g., `queueConfig.KEY`) instead of hard-coding the host. The host is the Compose service name (`redis`), never `localhost`.
- **Queue registration:** `BullModule.registerQueue({ name, defaultJobOptions })` in the feature module. Per-queue options are merged over the shared config. Each queue provider closes itself on `onApplicationShutdown`.
- **Producer side (API):** inject with `@InjectQueue('<name>') queue: Queue` (type from `bullmq`), or `moduleRef.get(getQueueToken('<name>'))`. The API only registers the queue. It must **not** import the processor class.
- **Consumer side (worker):** `@Processor('<name>', { concurrency })` on a class that `extends WorkerHost`, implementing `async process(job: Job): Promise<unknown>`. The second argument takes raw BullMQ `WorkerOptions` (`concurrency`, `limiter`, …). Worker lifecycle events come from `@OnWorkerEvent('failed' | 'completed' | 'error' | 'stalled' | …)` methods on the same class.
- **Separate process (TD-07):** a worker entrypoint built with `NestFactory.createApplicationContext(WorkerModule)` gets processors discovered by the module's explorer. The worker module imports `BullModule.forRootAsync` + `registerQueue` + the processor provider, and no HTTP modules. Call `enableShutdownHooks()` so workers close cleanly.
- **Testing:** module compilation tests with a real `registerQueue` need a reachable Redis (Compose `redis` service). Close the app (`await app.close()`) to release Redis handles, or Jest hangs.

### bullmq

_Used by `phase-03-videos/TD-01`, `TD-03` (cleanup scheduler), `TD-06` (`jobId = videoId`), `TD-13` (retry policy)._

- **v6 breaking change — install `ioredis` explicitly:** `ioredis` is no longer a direct dependency of `bullmq` 6. It is an **optional peer**, and Redis users must add it to `package.json` themselves. The `Connection` constructor parameter was replaced by an optional `BackendFactory`. `Queue#client`, `Worker#blockingClient` and similar internals are gone; reach the raw client via `getBackend()`. `Worker#waitUntilReady()` now resolves to `void`, and `Worker#resume()` is async.
- **Redis requirement:** run Redis with `maxmemory-policy noeviction`, because evicted keys corrupt queue state.
- **Connection retry semantics:** producers (the API enqueueing from an HTTP request) should fail fast. Keep the default `maxRetriesPerRequest` (20) or set it to 1. Workers hold connections indefinitely and use `maxRetriesPerRequest: null`. With `@nestjs/bullmq`, set the worker-side value in the worker app's `forRootAsync` connection.
- **Idempotent enqueue (TD-06):** `queue.add(name, data, { jobId: videoId })`. Adding a job whose `jobId` already exists is a no-op, so a retried `complete` call does not create a duplicate job. (The v5 `debounce` option was removed in v6 in favor of `deduplication` ids. `jobId` uniqueness is the simpler fit here.)
- **Retry policy (TD-13):** `attempts: 3`, `backoff: { type: 'exponential', delay: <ms> }` in `defaultJobOptions` or per `add`. Throwing `UnrecoverableError` (import from `bullmq`) inside the processor moves the job straight to `failed` and ignores the remaining attempts. Use it for invalid or unsupported media.
- **Stalled jobs:** a job whose lock expires (for example, a worker crash) is moved back to `wait` by the stalled-checker, or to `failed` after `maxStalledCount` (default 1). This is how crashed workers recover without custom code.
- **Retention:** `removeOnComplete` / `removeOnFail` accept `true | number | { age, count }`. The default keeps jobs forever. Set bounded values (e.g., `removeOnFail: { age: 86400 * 7 }`) so Redis does not grow without limit. The DB (`processing_status` + `processing_error`) is the durable record, not Redis.
- **Repeatable cleanup job (TD-03) — v6 API:** `queue.add(..., { repeat })`, `getRepeatableJobs`, `removeRepeatable*` and `Repeat` were **removed in v6**. Use `queue.upsertJobScheduler(schedulerId, { pattern: '<cron>' | every: <ms> }, { name, data, opts })`, which is idempotent by `schedulerId`. Manage schedulers with `getJobSchedulers()` / `removeJobScheduler()`.

### @aws-sdk/client-s3

_Used by `phase-03-videos/TD-02`, `TD-03`, `TD-04`, `TD-05`, `TD-06`, `TD-08`._

- **Client for MinIO/S3-compatible storage:** `new S3Client({ endpoint, region, credentials: { accessKeyId, secretAccessKey }, forcePathStyle: true })`. `forcePathStyle` (the v3 name of v2's `s3ForcePathStyle`) is required for MinIO-style `http://host:9000/bucket/key` addressing. An explicit `endpoint` on the client takes precedence over `AWS_ENDPOINT_URL*` env vars. Do not rely on those vars; read the endpoint from the `registerAs` storage config.
- **TD-05 — two clients:** the internal client (`STORAGE_ENDPOINT`, e.g. `http://minio:9000`) performs real calls. The public client (`STORAGE_PUBLIC_ENDPOINT`) is used only for `getSignedUrl`. Both use identical credentials, region and `forcePathStyle`.
- **Multipart lifecycle (TD-02/TD-03), all via `client.send(new XCommand(input))`:**
  - `CreateMultipartUploadCommand({ Bucket, Key, ContentType })` returns `UploadId`.
  - `ListPartsCommand({ Bucket, Key, UploadId, PartNumberMarker?, MaxParts? })` returns `Parts[] { PartNumber, ETag, Size }`, `IsTruncated` and `NextPartNumberMarker`. The page size is at most 1000 parts. ~160 parts at 64 MiB fit in one page, but still loop on `IsTruncated`.
  - `CompleteMultipartUploadCommand({ Bucket, Key, UploadId, MultipartUpload: { Parts: [{ PartNumber, ETag }] } })`. Parts must be in ascending `PartNumber` order, and each ETag must match what storage returned for that part.
  - `AbortMultipartUploadCommand({ Bucket, Key, UploadId })` discards the uploaded parts (the `abort` endpoint).
- **Validation after complete (TD-03/TD-06):** `HeadObjectCommand({ Bucket, Key })` returns `ContentLength` and `ContentType`. Re-check `ContentLength ≤ 10 GiB` before enqueueing.
- **Thumbnail write (TD-08):** `PutObjectCommand({ Bucket, Key: 'thumbnails/{videoId}/auto.jpg', Body, ContentType: 'image/jpeg' })`.
- **S3 limits behind TD-03's numbers:** part size from 5 MiB to 5 GiB (the last part may be smaller), at most 10,000 parts per upload, and a single-request PUT cap of 5 GiB, which is why a single presigned PUT can't carry 10 GiB.

### @aws-sdk/s3-request-presigner

_Used by `phase-03-videos/TD-02` (part URLs), `TD-08` (worker source URL), `TD-11` (playback/download)._

- **API:** `getSignedUrl(client, command, { expiresIn })` from `@aws-sdk/s3-request-presigner`. `expiresIn` is in seconds and defaults to 900. Signing is a local computation with no network call, which is what lets TD-05 sign with the "public" client from inside a container.
- **Part URLs (TD-02):** `getSignedUrl(publicClient, new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }), { expiresIn: 3600 })`. The browser `PUT`s the raw bytes, and storage returns the part's `ETag` in a response header. Storage CORS must expose `ETag` for the browser to read it.
- **Worker source URL (TD-08 + TD-05 refinement):** sign `GetObjectCommand({ Bucket, Key })` with the **internal** client, because ffprobe/ffmpeg run inside the container.
- **Playback (TD-11):** `GetObjectCommand({ Bucket, Key })` signed with a long TTL (hours). Range requests from `<video>` are served as `206` by storage.
- **Download (TD-11):** `GetObjectCommand({ Bucket, Key, ResponseContentDisposition: 'attachment; filename="…"; filename*=UTF-8\'\'…' })` with a short TTL. Response-header overrides such as `response-content-disposition` are honored **only on signed requests**, which a presigned URL is. Build the filename from the sanitized title (TD-03 revision) plus the original extension.
- **Gotcha:** the host is part of the SigV4 signature, so rewriting a URL's host after signing invalidates it. Always sign with the client whose endpoint matches the consumer (TD-05).
