# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 12/13 completed

### SI-03.1 — Infra: dependências, namespaces de config e serviços Docker
- **Status:** completed
- **Tests:** no tests (Infra) — existing suites green: unit 144/144, e2e 52/52; tsc 0; lint 0 errors
- **Observations:**
  - **Storage image:** official `minio/minio` and `minio/mc` no longer pull (Docker Hub and quay.io deny access) after MinIO CE EOL. By user decision, compose uses the community fork `pgsty/minio:RELEASE.2026-08-04T00-00-00Z` and `pgsty/mc:RELEASE.2026-09-16T00-00-00Z` (drop-in, amd64). Recorded as a Revision on TD-04 in `docs/decisions/technical-decisions-phase-03-videos.md`.
  - Plan said `<rootDir>/test/setup-env.ts` for `test/jest-e2e.json`, but that config's `rootDir` (`.`) resolves to `test/`, so the working path is `<rootDir>/setup-env.ts`.
  - Adding required `STORAGE_ACCESS_KEY`/`STORAGE_SECRET_KEY` broke the fixture in `src/config/env.validation.integration-spec.ts`; added both keys to its `requiredEnv`.
  - Local `.env` (git-ignored) received the same new keys as `.env.example`; MinIO root credentials in compose (`streamtube` / `streamtube-secret`) match them.
  - npm recorded `^3.1148.0` for the AWS SDK packages and `^6.3.12` for bullmq (latest within the planned ranges); `ioredis` resolved to `^5.11.1`.

### SI-03.2 — StorageModule: clientes S3 interno/público, multipart e pré-assinatura
- **Status:** completed
- **Tests:** 11 passing (4 unit signing, 6 integration MinIO, 1 module compilation)
- **Observations:**
  - `StorageService` implements `OnModuleDestroy` to `destroy()` both S3 clients so Jest/worker shutdown releases sockets.
  - `src/test/storage.ts` cleanup also aborts in-progress multipart uploads under the test prefix, not only finished objects.
  - The integration spec covers `deleteObject` too (head → `NotFound`), beyond the plan's table.
  - Out of scope: the Storage layout spec's CORS row (browser part PUTs need an allowed origin and an exposed `ETag` header) belongs to no SI's Technical actions. No frontend exists in this phase, so it's untested here. Track it as a follow-up for the frontend phase (configure CORS on the pgsty MinIO, e.g. `MINIO_API_CORS_ALLOW_ORIGIN`).

### SI-03.3 — Entidade Video, migration e gerador de public_id
- **Status:** completed
- **Tests:** 22 passing (5 entity integration, 12 public-id unit, 1 module compilation, 4 migrations integration); full `npm test` 175/175
- **Observations:**
  - Migration generated as `1791555983193-CreateVideos.ts` and applied to the dev DB. CLI `migration:run` → `migration:revert` (table and both enum types removed) → `migration:run` all verified.
  - Following the Data Model (the relation lives on `Video` only), `Channel` gained no inverse `@OneToMany`, even though the typeorm skill defaults to bidirectional relations.
  - Updated `src/database/migrations.integration-spec.ts`, which hard-codes the migration list and the tables it manages, so it includes `CreateVideos`. It now also asserts the `videos` enum types and indexes, and that reverting `CreateVideos` removes the table and enum types. This test file owns the migration ACs.
  - Fix attempt 1: that spec's `beforeAll` ran `DROP TABLE … CASCADE` concurrently via `Promise.all`. With `videos` (FK → `channels`) added, Postgres deadlocked, and the half-dropped DB broke the `afterAll` re-run. Replaced it with a single `DROP TABLE IF EXISTS a, b, … CASCADE` statement.
  - The `bigint` → `number` transformer lives in `video.entity.ts`, as the SI specifies, not in a shared module.
  - The entity spec cleans `videos` explicitly before `cleanAllTables`. The shared `cleanAllTables` helper was not changed because channel deletion already cascades to videos.

### SI-03.4 — Fila de processamento: conexão BullMQ e producer idempotente
- **Status:** completed
- **Tests:** 4 passing (3 producer integration on real Redis, 1 module compilation), no open handles; e2e regression 52/52 with `AppModule` now registering `BullModule.forRootAsync`
- **Observations:**
  - **Library version:** `@nestjs/bullmq@12.0.0` (the version TD-01 pinned) is ESM-only (`"type": "module"`, and so is `@nestjs/bull-shared` 12). The project's ts-jest (CommonJS) could not parse it, so the first run failed to load every suite importing `AppModule`, including all e2e suites. By user decision it is now pinned to `^11.0.5` (CommonJS, peers NestJS `^11` and `bullmq ^6`, same API). Recorded as a Revision on TD-01, and `library-refs.md` was updated (`^11.0.5` plus the compatibility note).
  - Added `src/test/queue.ts` (test `BullModule.forRoot` with the `bull-test` prefix and the Compose Redis connection) for reuse by the worker SIs.
  - The producer integration spec runs `queue.obliterate({ force: true })` before each test and in `afterAll`. It only touches the `bull-test` prefix, never the dev `bull` keys, and the spec asserts that isolation.

### SI-03.8 — MediaModule: ffprobe, validação de formato e extração de thumbnail
- **Status:** completed
- **Tests:** 23 passing (6 parseProbeOutput unit, 8 assertPlayable unit, 3 thumbnailTimestamp unit, 6 integration with real ffmpeg and `lavfi` fixtures, ~6 s)
- **Observations:**
  - **Random-bytes classification:** in experiments, ffprobe on random bytes in a `.bin` file exits 0 and reports a `bin`/`bintext` "video" (detected from the extension). With a `.mp4`/`.webm` name, or with no extension, it exits 1 with `Invalid data found when processing input`. So `MediaProbeService.probe` maps that specific stderr to `InvalidMediaError` and rethrows every other failure (403, network, timeout) unchanged, leaving those retryable for TD-13. The random fixture is named `random.mp4`, matching the real `original.{ext}` keys.
  - `parseProbeOutput` takes the raw stdout string and throws `InvalidMediaError` for invalid JSON or output without `format`/`streams`. This covers the "JSON inválido" case from Technical action 2 at the parse step. `assertPlayable` covers the case with no video stream and the whitelist check.
  - Reason codes and limits live in `src/media/media.constants.ts`. `InvalidMediaError`/`UnsupportedCodecError` extend a `MediaRejectedError` base carrying `reasonCode`, in `src/media/media.errors.ts` (plain errors, not HTTP `DomainException`s). `PROCESSING_ERROR` is left for the worker SI.
  - Added `-v error` to the ffmpeg thumbnail args (not in the plan's list) so the default banner and progress output stay off stderr. execFile timeouts are 120 s and the thumbnail `maxBuffer` is 20 MiB.
  - The container whitelist matches `format_name` tokens split on `,` (`mov,mp4,…` → `mp4`; `matroska,webm` → `webm`). As a side effect, a `.mov` file with H.264 video is accepted, because ffprobe reports it under the same `mov,mp4,…` format name. That follows the plan's rule; worth knowing for TD-09.
  - Fixtures: H.264+AAC MP4 at 1080p (also covers `audioCodec`), VP9 WebM with no audio, MPEG-4 Part 2 MP4 (for `UNSUPPORTED_CODEC`) and 256 KiB of random bytes, all generated in a temp dir and removed in `afterAll`.

### SI-03.5 — Início do upload: POST /videos com pré-cadastro do rascunho
- **Status:** completed
- **Tests:** 26 passing — set A 21 (title util 7, `VideosService` unit 7, `VideosService` integration 1, `ChannelsService` integration incl. 2 new `findByUserId`, `VideosModule` compilation 1); set B 5 (spec-derived `test/videos-create.e2e-spec.ts`)
- **Observations:**
  - Presenter signature: the plan names `toVideoResponse(video)`. It is implemented as the pure `toVideoResponse(video, thumbnailUrl)`, and `VideosService.present(video)` signs the thumbnail (public audience, `THUMBNAIL_URL_TTL_SECONDS`) before calling it. This keeps the presenter free of I/O for its SI-03.11 unit test.
  - `isPgUniqueViolationOnColumn` was extracted to `src/common/database/pg-errors.ts` for the `public_id` retry (max 5 attempts). `ChannelsService` still keeps its own private copy. Making it use the shared helper is a small refactor, left as a separate follow-up so as not to mix scopes.
  - Added `src/videos/videos.constants.ts` (content-type whitelist, 10 GiB limit, `VIDEO_STORAGE_KEYS`) and response DTOs (`VideoResponseDto`, `InitiateUploadResponseDto`) for OpenAPI.
  - A user without a channel (should not happen, since register creates one) raises a plain `Error` → 500. The plan defines no domain error for it.
  - Added shared helpers for the next controller SIs: `src/test/e2e-app.ts` (`createE2eApp` reproduces the `main.ts` pipes and filters and exposes `resetThrottling`; `createAuthenticatedUser` inserts a confirmed user and channel, then logs in via `POST /auth/login`) and `cleanupVideoStorage(dataSource)` in `src/test/storage.ts`. The latter aborts and deletes storage under `videos/{id}/` and `thumbnails/{id}/` for every DB row, so tests don't leak multipart uploads into the shared bucket.
  - The global `ThrottlerGuard` (10 req/min, from Phase 02) also applies to `/videos`. E2E suites reset it in `beforeEach`. Whether video routes should be throttled differently was not decided by the plan (follow-up).
  - Updated the SI-03.3 `videos.module.spec.ts` because `VideosModule` now imports Channels, Storage and the queue, so the test needs storage/queue config plus the test Bull root.

### SI-03.6 — Retomada do upload: assinar URLs de partes e listar partes enviadas
- **Status:** completed
- **Tests:** 26 passing — set A 19 (`videos.service.spec.ts` 17 incl. 10 new for `findOwnedOrFail`/`assertPendingUpload`/`signPartUrls`; `videos.service.integration-spec.ts` 2 incl. the new resume flow on real MinIO); set B 7 (spec-derived `test/videos-upload-parts.e2e-spec.ts`)
- **Observations:**
  - `findOwnedOrFail` resolves ownership in one query (`where: { public_id, channel: { user_id } }`). A malformed id, a missing id and a foreign video all throw the same `VideoNotFoundException`, and the E2E asserts the bodies are identical.
  - `assertPendingUpload` also rejects a `pending_upload` row whose `upload_id` is null (defensive: it cannot be signed or listed), with `INVALID_UPLOAD_STATE`.
  - `expires_at` is computed before signing, so it never runs later than the actual URL expiry.
  - Added response DTOs (`SignPartUrlsResponseDto`, `UploadedPartsResponseDto`) and a private `partCount()` helper, now also used by `initiateUpload`.
  - Per user instruction (2026-10-09), spec-derived E2E files carry no comments at all, including no group-heading comments. The user removed the group comments from `test/videos-create.e2e-spec.ts` themselves.
  - Per user request, moved the `/** … */` JSDoc blocks of `src/videos/dto/create-video.dto.ts` (SI-03.5) into `@ApiProperty({ description, example })`, following `api-error-envelope.dto.ts`. It was the only new DTO with JSDoc. Verified by exporting OpenAPI from the compiled `dist/` (the swagger CLI plugin runs only in `nest build`) before and after: the documents are deep-equal (only key order changed), and all four field descriptions and examples are kept. `swagger` + `videos-create` e2e: 11/11.

### SI-03.11 — Consulta do vídeo: GET /videos/:publicId
- **Status:** completed
- **Tests:** 32 passing — set A 23 (`video.presenter.spec.ts` 6 new; `videos.service.spec.ts` 17 regression); set B 9 (spec-derived `test/videos-get.e2e-spec.ts` 4 plus `videos-create` regression 5)
- **Observations:**
  - **Order swap (user decision, 2026-10-09):** ran before SI-03.7 because the SI-03.7 E2E spec calls `GET /videos/:publicId` in scenarios 2.1 and 3.1. Without this route those calls would get Nest's generic 404 (`error: "Not Found"`) instead of `VIDEO_NOT_FOUND`. Both SIs depend only on SI-03.6, so the Dependency Map still holds.
  - Presenter split: the pure `toVideoResponse(video, thumbnailUrl)` plus `presentVideo(video, storageService, ttl)`, which signs the thumbnail with the public audience. `VideosService.present` delegates to it, so the presenter spec covers the signing rules (host and TTL) with a real local-signing `StorageService` and no network.
  - `toVideoResponse` now exposes `processing_error` only when `processing_status = failed`, otherwise `null`, per the plan's presenter test row.
  - The `ready` E2E uploads a 16×16 JPEG generated by ffmpeg to `thumbnails/{id}/auto.jpg` and fetches the signed URL from inside the container (`STORAGE_PUBLIC_ENDPOINT = STORAGE_ENDPOINT` in tests) → `200 image/jpeg`.

### SI-03.7 — Conclusão e cancelamento do upload
- **Status:** completed
- **Tests:** 43 passing — set A 36 (`videos.service.spec.ts` incl. 11 new `completeUpload` cases; `videos.service.integration-spec.ts` incl. 2 new complete/abort flows on real DB, MinIO and Redis; `complete-upload.dto.spec.ts` 4); set B 7 (spec-derived `test/videos-upload-complete.e2e-spec.ts`)
- **Observations:**
  - Unique `part_number` is enforced with class-validator's `@ArrayUnique(part => part.part_number)` selector, a built-in identifier-based check, rather than a hand-written custom validator class. The plan asked only for uniqueness checked in the DTO.
  - The S3 error names mapped to `INVALID_UPLOAD_PARTS` (`InvalidPart`, `InvalidPartOrder`, `EntityTooSmall`) live in `INVALID_PARTS_STORAGE_ERRORS` in `videos.constants.ts`. Other storage errors are rethrown unchanged. Verified against MinIO in the E2E: a part number never uploaded and a wrong ETag both return 422.
  - Order on success: `save(uploaded)` → `enqueueProcessing(video.id)`. If the enqueue fails, the error reaches the client (500) while the video stays `uploaded`, recoverable by repeating the complete (re-enqueue branch) or by `cleanup-stale-uploads` (SI-03.10), per TD-06. A unit test covers this.
  - Over 10 GiB after `HeadObject`: `deleteObject` and row delete, then `UPLOAD_SIZE_EXCEEDED`. This is unit-tested only (generating >10 GiB in an integration test is impractical).
  - The `complete` and E2E suites `obliterate` the `bull-test` queue in `beforeEach`/`afterAll`.

### SI-03.9 — Video worker: entrypoint, processor e ciclo de status
- **Status:** completed
- **Tests:** 14 passing (9 processor unit, 4 service integration on real DB, MinIO and ffmpeg, 1 `WorkerModule` compilation), no open handles, ~12 s
- **Observations:**
  - **Fix attempt 1 (runtime, worker boot):** the `video-worker` container first failed with `Entity metadata for Video#channel was not found`, because `autoLoadEntities` only knew `Video` and its `ManyToOne(() => Channel)` needs `Channel` (and `Channel → User`). The worker now registers `TypeOrmModule.forFeature([Video, Channel, User])`. Boot then succeeds, and `Queue.getWorkers()` on the dev `bull` prefix reports 1 worker.
  - **Concurrency:** the `@Processor` decorator options are static, so `VIDEO_WORKER_CONCURRENCY` is applied in `onApplicationBootstrap` via `this.worker.concurrency = …` (the BullMQ `Worker` setter). The effect is the same as the plan's `@Processor(…, { concurrency })`.
  - `VideoProcessingService.process` skips missing videos and any status other than `uploaded`/`processing` (so `ready`, `failed`, `pending_upload` are no-ops). It writes `processing` before signing and probing, and metadata right after `assertPlayable`. It writes `thumbnail_key` + `ready` (and clears `processing_error`) after `PutObject`. The source URL is signed with `audience: 'internal'` and `WORKER_SOURCE_URL_TTL_SECONDS = 3600` (a new constant, not in the plan).
  - Failure handling: `MediaRejectedError` → `markFailed(reasonCode)` + `UnrecoverableError`. Other errors are rethrown. `@OnWorkerEvent('failed')` writes `PROCESSING_ERROR` only when `attemptsMade >= opts.attempts` and the row is not already `failed`, so the media reason code is kept.
  - The integration spec observes `processing` while the thumbnail is extracted (spy on `extractFrame` reads the row). For the media-failure cases it drives the real processor with a stub `Job`, so the test proves `failed` + reason code after one attempt with the original object preserved. The transient retry/exhaustion path is unit-tested; it is not exercised end-to-end with a live BullMQ worker.
  - Not verified here: running `nestjs-api` `start:dev` side by side with the worker. `nestjs-project/CLAUDE.md` forbids starting the API server unless the user explicitly asks. Verified instead: `start:worker:dev` writes `dist-worker/worker.js` while `dist/main.js` (from `npm run build`) stays intact, so separate outDirs are in place.
  - `tsconfig.worker.json` re-declares `exclude` (adding `dist-worker`), because `exclude` in an extending tsconfig replaces the parent's list rather than merging with it.

### SI-03.10 — Job agendado cleanup-stale-uploads: rascunhos abandonados e uploads parados
- **Status:** completed
- **Tests:** 20 passing, no open handles, ~10 s (`stale-uploads.service.integration-spec.ts` 5 new on real DB, MinIO and Redis; `video-processing.processor.spec.ts` 10 incl. 2 new dispatch cases; SI-03.9 service integration 4 and `WorkerModule` compilation 1 as regression)
- **Observations:**
  - The scheduler is registered by the worker in `VideoProcessingProcessor.onApplicationBootstrap` through a new producer method, `VideoProcessingProducer.scheduleStaleUploadsCleanup()` (`upsertJobScheduler('cleanup-stale-uploads', { every: 300000 }, …)`), so all queue writes stay in the producer. Verified on the live dev worker: `getJobSchedulers()` (prefix `bull`) lists exactly one `cleanup-stale-uploads` every 300000 ms, both before and after `docker compose restart video-worker`.
  - `WorkerModule` now imports `VideoProcessingQueueModule` (queue registration + producer) and no longer calls `BullModule.registerQueue` itself.
  - Unknown job names now throw `Unknown job "<name>"` instead of only logging a warning, per the SI's test row. This replaced the SI-03.9 unit case, and the job fails visibly in BullMQ.
  - `cleanupStaleDrafts` ignores `NoSuchUpload` silently. Other abort errors are logged as warnings and the row is deleted anyway (best-effort). The integration spec covers a draft whose multipart was already gone.
  - The integration spec ages rows with `UPDATE … SET created_at/updated_at = now() - interval`. AC #4 ("ends processed") relies on the SI-03.9 worker flow already verified; the cleanup→worker path was not run end-to-end on the live dev worker.

### SI-03.12 — Streaming e download: URLs pré-assinadas de playback e download
- **Status:** completed
- **Tests:** 49 passing — set A 46 (`content-disposition.util.spec.ts` 6; `videos.service.spec.ts` incl. 6 new playback/download cases; `videos.service.integration-spec.ts` incl. 2 new Range/attachment checks on real MinIO); set B 3 (spec-derived `test/videos-playback-download.e2e-spec.ts`, incl. the full upload → complete → `VideoProcessingService.process` → playback 206 → download attachment flow, ~9.6 s)
- **Observations:**
  - `buildAttachmentDisposition`: the ASCII fallback strips accents via NFKD and replaces non-printable-ASCII, `"` and `\` with `_` (`video` if nothing is left). `filename*` is RFC 5987 (`encodeURIComponent` plus `'()*`). MinIO honors `response-content-disposition` on the presigned GET, verified in integration and E2E.
  - Added `PresignedUrlResponseDto` (`url`, `expires_at`). `expires_at` is computed before signing, and both URLs are signed with the public client.
  - Full-flow fixture: `createMultipartMp4Fixture()` in `src/test/media-fixtures.ts` generates a 4 s 1280×720 H.264 clip with a `noise` filter at 16 Mb/s (~7 MiB, so exactly 2 parts of 5 MiB). A 3 s clip came out only ~5.2 MiB.
  - The E2E compiles `WorkerModule` without `init()`, so no BullMQ `Worker` starts and no scheduler is registered under `bull-test`. It calls `VideoProcessingService.process` directly, as the spec says.
  - `--detectOpenHandles` reports a `CustomGC` handle from the native `@css-inline/css-inline` addon (loaded by `MailModule`'s `HandlebarsAdapter`). This predates Phase 03: it also appears on the untouched baseline `test/app.e2e-spec.ts`, and Jest still exits normally. Out of scope here (follow-up if it ever blocks Jest exit).

### SI-03.13 — Documentação: openapi.json exportado e CLAUDE.md do backend
- **Status:** pending
- **Tests:** —
- **Observations:** none
