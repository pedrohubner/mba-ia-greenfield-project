---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-10-08
scope_description: "Backend side of Phase 03 — video upload up to 10GB direct to object storage with resume, draft pre-registration, background processing (queue + FFmpeg worker) for metadata and thumbnail, unique video URL, streaming (Range/206) and download. Object storage (MinIO, S3-compatible) is a given; only its usage is decided here."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — API (upload handshake endpoints, video draft registration, job publishing, playback/download URL issuance) **and** the video worker (new process/container built from the same codebase, see TD-07), plus the Docker Compose infra additions (object storage, queue broker, worker service).
- `next-frontend/` — No open decision in this document. Phase 03 has no screen bullet; upload UI and the player belong to later frontend work. The runtime contracts the frontend will consume (upload handshake — TD-02/TD-03; URL identifier — TD-10; playback/download — TD-11; status values — TD-12) are marked `Cross-layer` and decided once here.

_Research notes (flagged discrepancies):_

- **MinIO Community Edition is end-of-life upstream.** MinIO stopped publishing community Docker images/binaries in Oct 2025, put the repo in maintenance mode in Dec 2025 and archived it on 2026-02-12 (source-only distribution). The storage choice is **not** reopened here (it is a given for this phase), but implementation must pin an existing image tag and verify it still pulls. Because every TD below talks to storage exclusively through the S3 API (`@aws-sdk/client-s3`), swapping to another S3-compatible server (Garage, SeaweedFS, RustFS) later is a compose/env change, not a code change. Sources: [MinIO CE in 2026](https://dev.to/rosgluk/minio-ce-in-2026-retired-upstream-source-only-and-what-to-use-1k02), [MinIO Is Dead, Long Live MinIO](https://vonng.com/en/db/minio-resurrect/).
- **`fluent-ffmpeg` is deprecated on npm** ("Package no longer supported", latest 2.1.3). It is listed in TD-08 only to make that explicit.
- Versions checked against the npm registry on 2026-10-08: `@nestjs/bullmq` 12.0.0 (peer `@nestjs/core ^10 || ^11 || ^12`, `bullmq ^3..^6` — compatible with the installed NestJS 11), `bullmq` 6.3.11, `pg-boss` 12.37.0 (Node ≥ 22.12), `@aws-sdk/client-s3` / `@aws-sdk/s3-request-presigner` 3.1147.0. The API container runs `node:25.6.0-slim`.

---

## TD-01: Message Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The architecture diagram leaves the queue as "TBD". The API publishes a "process video" job after an upload completes; the worker consumes it, and needs retries with backoff, detection of jobs abandoned by a crashed worker, and a way to stop retrying on permanent errors (TD-13). The choice adds (or not) a new container to `compose.yaml` and a new set of env keys to the Joi schema.

**Options:**

### Option A: BullMQ on Redis (`@nestjs/bullmq` + `bullmq`)
- Redis-backed queue with the official NestJS integration (`BullModule.forRoot/registerQueue`, `@Processor` + `WorkerHost`, `@OnWorkerEvent`). Jobs support `attempts` + exponential `backoff`, `UnrecoverableError` to skip retries, `jobId` for deduplication, and automatic stalled-job recovery.
- **Pros:** Documented in the official NestJS "Queues" technique — matches the project's best-practices skills. Every failure semantic TD-13 needs is built in. Producer (API) and consumer (worker) are decoupled by queue name only. Mature (v6) and compatible with installed NestJS 11.
- **Cons:** New infrastructure: a Redis container (must run with `maxmemory-policy noeviction`, per BullMQ docs). Job state lives outside PostgreSQL, so DB update + enqueue is a dual write (mitigated in TD-06).

### Option B: pg-boss on the existing PostgreSQL
- Queue implemented as tables in PostgreSQL using `SKIP LOCKED`. Supports retries, retry delay/backoff, expiration, dead-letter queues and cron. No official NestJS module — wrapped in a custom provider.
- **Pros:** Zero new infrastructure — PostgreSQL is already in the stack. Enqueue can share the same transaction as the `videos` status update (no dual write).
- **Cons:** No official NestJS integration (custom module, lifecycle hooks and tests to write). Polling-based; adds write load to the main database. Less alignment with the NestJS docs the project follows; fewer community examples.

### Option C: RabbitMQ (AMQP broker)
- Dedicated message broker; NestJS microservices transport or `amqplib`. Retries via dead-letter exchanges + TTL queues.
- **Pros:** Full-featured broker, language-agnostic consumers, strong delivery guarantees.
- **Cons:** Heaviest option: new broker plus manual retry/backoff topology (DLX + TTL). The NestJS RMQ transport is message-oriented, not job-oriented (no attempts/backoff/stalled semantics out of the box). Overkill for one job type.

**Recommendation:** **Option A (BullMQ + Redis)** — it is the queue the NestJS docs describe, and it already has the retry/backoff, stalled-job recovery and non-retryable failure semantics that TD-13 needs. Writing those by hand is what makes B and C cost more. The cost is one Redis container. B is the honest alternative if avoiding new infrastructure matters more than framework alignment: it removes the dual write, but the NestJS integration has to be built by hand.

**Decision:** A (BullMQ on Redis)

**Libraries:** @nestjs/bullmq, bullmq

---

## TD-02: Large-File Upload Protocol (≤ 10GB, direct to storage, resumable)

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** Bytes must not pass through the API (performance), and an interrupted upload must resume without restarting (`project-plan.md` §4). A single presigned `PUT` is ruled out: S3 caps single-request uploads at 5GB and a failure restarts from zero. The protocol is a handshake that the backend implements now and the frontend consumes later, so it is decided once here.

**Options:**

### Option A: S3 multipart upload with presigned part URLs (API-orchestrated)
- API endpoints: **initiate** (creates the draft video + `CreateMultipartUpload`, returns `uploadId`, part size and part count), **sign parts** (presigned `UploadPart` URLs for a batch of part numbers), **list parts** (for resume), **complete** (`CompleteMultipartUpload` with the client's `{PartNumber, ETag}` list) and **abort**. The client `PUT`s each part straight to storage.
- **Pros:** Bytes never touch the API; parts upload in parallel; resume = ask which parts exist and upload only the missing ones. Uses only the S3 API (portable across S3-compatible servers). Standard pattern; Uppy's `@uppy/aws-s3` speaks it, so the future frontend has a ready client.
- **Cons:** Five endpoints to build and test. The client must read the `ETag` response header from storage (storage CORS must expose `ETag`). Incomplete uploads need cleanup (TD-03).

### Option B: tus protocol via a standalone `tusd` server with S3 backend
- A `tusd` container receives uploads using the tus resumable protocol and writes to S3 using multipart internally. Hooks (HTTP) notify the API on create/finish to authorize and register the video.
- **Pros:** Open resumable-upload standard; tus clients (`tus-js-client`, Uppy) handle resume automatically. The API never sees the bytes.
- **Cons:** Bytes still flow through a server we operate (tusd), so it is a new bandwidth/CPU hop and another container. Auth must be bridged through hooks. tusd writes its own `.info` objects to the bucket. The extra moving part buys little over A, since S3 multipart is already resumable.

**Recommendation:** **Option A (presigned S3 multipart)** — it is the only option where the bytes go from the client straight to storage with no server of ours in between, and resume comes from S3 itself (`ListParts`). That covers both "sem passar pela API" and "retomar em caso de falha" without a new container. The API keeps authorization and draft registration, because every step except the part `PUT`s goes through it.

**Decision:** A (S3 multipart upload with presigned part URLs, API-orchestrated)

**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

---

## TD-03: Upload Session State, Resume Source of Truth & Limits

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"

**Context:** Depends on TD-02 (A). Resuming needs to know which parts are already stored, and abandoned uploads must not pile up. The limits (max size, part size, URL TTL) are a contract between the API (validates, returns them) and the client (slices the file), and they also appear in env/config.

**Options:**

### Option A: Storage is the source of truth (`ListParts`); DB stores only the session handle
- The `videos` row keeps `upload_id`, `object_key`, declared `size_bytes` and status `pending_upload`. On resume, the API calls `ListParts` and returns the parts that already exist. Abandoned multipart uploads are cleaned up by the storage server's stale-upload expiry; abandoned draft rows are swept by a periodic job.
- **Pros:** No per-part writes in PostgreSQL. No drift between DB and storage, since the storage is what actually holds the parts. Simple schema.
- **Cons:** Each resume costs one `ListParts` call (≤ 1000 parts per page; paginate if needed). The cleanup window depends on server config (MinIO's default stale-upload expiry is 24h; confirm during implementation).

### Option B: Track every part in a DB table (`video_upload_parts`)
- Client reports each finished part (number + ETag) to the API, which persists it; resume reads from the DB.
- **Pros:** Upload progress can be queried without calling storage.
- **Cons:** One extra API round-trip and DB write per part (~160 for 10GB at 64MiB), which brings back the API load that TD-02 removed. The DB can drift from storage (part uploaded but the report was lost), so `ListParts` is needed anyway to be correct.

**Recommendation:** **Option A** with these limits: max size **10 GiB** (validated at initiate from the declared size and re-checked at complete with `HeadObject`). Part size **64 MiB** (→ ~160 parts for 10GB, well inside S3's 10,000-part and 5MiB-minimum limits). Part URLs signed in batches, with a short TTL (e.g., 1h) so a leaked URL expires soon. Accepted MIME types follow TD-09. Drafts stuck in `pending_upload` past the storage expiry window are deleted by a repeatable cleanup job on the same queue (TD-01). B adds per-part load on the API and still has to call `ListParts` to be correct, so A wins.

**Decision:** A (Storage is the source of truth via `ListParts`; 10 GiB max, 64 MiB parts)

**Revisions:**
- 2026-10-08 — Initiate contract: the request accepts an optional `title`; when absent, the draft title defaults to the original filename without its extension (sanitized, truncated to the column's max length). Title editing remains Phase 04. Rationale: resolves AMB-1 from `phase-03-videos` validation — the download `Content-Disposition` (TD-11) needs a title from draft creation.

---

## TD-04: Object Storage Layout — Buckets, Keys and Access Policy

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Storage server is a given; how it is organized is not. Bucket names and key patterns appear in env config, the API (upload/presign), the worker (read original, write thumbnail) and later phases (custom thumbnails, Phase 04). Access policy decides whether anything can be read without a presigned URL.

**Options:**

### Option A: Single private bucket, prefixes per asset type, keys by video UUID
- One bucket (e.g., `streamtube-media`), all private: `videos/{videoId}/original.{ext}` and `thumbnails/{videoId}/auto.jpg` (room for `custom.jpg` in Phase 04). Every read goes through a presigned URL.
- **Pros:** One bucket to provision, one CORS/lifecycle configuration. Keys never contain user-supplied names (no collisions, no path injection, no PII). All access controlled by the API.
- **Cons:** Thumbnails, which will be shown in listings, also need presigned URLs (one signing call each, done locally with no network round-trip, but the URLs can't be cached forever).

### Option B: Two buckets — private `videos`, public-read `thumbnails`
- Same key scheme, but thumbnails live in an anonymous-read bucket with stable URLs.
- **Pros:** Thumbnail URLs are stable and cacheable; no signing for listings.
- **Cons:** Thumbnails of drafts/unlisted videos become guessable-if-leaked public objects. Two buckets to provision and keep consistent. Public-read is a policy decision Phase 04 (visibility) may want to own.

**Recommendation:** **Option A** — everything stays behind the API's authorization while visibility rules (Phase 04) don't exist yet, and keying by `videoId` (not filename) avoids collisions by construction. If listing performance later needs stable thumbnail URLs, Phase 07 can add a public prefix/bucket without moving the originals. Buckets are created idempotently at startup by a one-shot `mc` init service in compose (or by the API on boot); either is an implementation detail.

**Decision:** A (Single private bucket, prefixes per asset type, keys by video UUID)

**Revisions:**
- 2026-10-09 — Storage container images: the official `minio/minio` and `minio/mc` images no longer pull (Docker Hub and quay.io deny access) after MinIO CE reached end-of-life upstream. Compose uses the maintained community fork `pgsty/minio:RELEASE.2026-08-04T00-00-00Z` and `pgsty/mc:RELEASE.2026-09-16T00-00-00Z`, a drop-in build of the same MinIO binary (same S3 API, CLI and healthcheck). Layout, bucket and access policy are unchanged. Rationale: found during `phase-03-videos` SI-03.1.

---

## TD-05: Presigned URL Host Under Docker Networking

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)", "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Per `CLAUDE.md`, containers reach storage by service name (e.g., `http://minio:9000`). But presigned URLs are used by the **browser**, which cannot resolve `minio`, and the host is part of the SigV4 signature, so a URL signed for `minio:9000` can't just be rewritten to `localhost:9000`. This decision fixes the canonical env keys (Joi schema + `compose.yaml` + `.env.example`) and how the S3 clients are built.

**Options:**

### Option A: Two endpoints — internal for operations, public for signing
- `STORAGE_ENDPOINT=http://minio:9000` builds the client used for real calls (`CreateMultipartUpload`, `ListParts`, `HeadObject`, worker reads/writes). `STORAGE_PUBLIC_ENDPOINT=http://localhost:9000` builds a second client used **only** by `getSignedUrl`. Signing is a local computation with no network call, so the container never has to reach the public host.
- **Pros:** Follows the Docker-networking rule for every real connection. No host-machine tweaks. In production the public endpoint becomes the CDN/storage domain with no code change.
- **Cons:** Two S3 client instances and one more env key. Tests must assert that signed URLs use the public host.

### Option B: Single hostname resolvable from both sides
- Use one endpoint everywhere (e.g., `http://minio:9000`) and make the host machine resolve it too (`/etc/hosts` entry), or route storage through a reverse proxy on a shared hostname.
- **Pros:** One client, one env key.
- **Cons:** Needs manual host configuration on every dev machine (`/etc/hosts`), or an extra proxy container. Easy to break silently; diverges from how production works.

**Recommendation:** **Option A** — it respects the project's service-name rule for every real connection and keeps the environment reproducible with `docker compose up` alone. It relies on SigV4 presigning being purely local, which makes the second "public" client free. **Decided refinement:** Two refinements so presigned URLs also work *inside* the Compose network. (1) URLs consumed by a container — the worker handing the source URL to ffprobe/ffmpeg (TD-08) — are signed with the **internal** client (`STORAGE_ENDPOINT`), never the public one. (2) In the test environment `STORAGE_PUBLIC_ENDPOINT` points to the internal endpoint, so integration/e2e suites running in the `nestjs-api` container can fetch signed URLs and assert real `206 Partial Content` responses. `STORAGE_PUBLIC_ENDPOINT=http://localhost:9000` is the single deliberate exception to the `CLAUDE.md` service-name rule: it is consumed by the browser on the host, never by a container.

**Decision:** A (Internal endpoint for operations, public endpoint for signing)

---

## TD-06: Processing Trigger (Who Enqueues the Job)

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** Depends on TD-01 and TD-02. Processing must start automatically once the original object is complete. Either the API (in the `complete` step) or the storage server (bucket event notification) can signal it.

**Options:**

### Option A: API enqueues after a successful `CompleteMultipartUpload`
- The `complete` endpoint completes the upload, checks the object with `HeadObject` (size ≤ 10GiB), moves status to `uploaded` and enqueues `process-video` with `jobId = videoId`.
- **Pros:** One explicit, testable code path. Validation happens before any work is queued. `jobId = videoId` makes a retried `complete` idempotent (BullMQ dedupes by id). No storage-specific configuration.
- **Cons:** DB update and enqueue are a dual write. If the enqueue fails after the status update, the video stays `uploaded`. Mitigation: `complete` is retryable (re-enqueues when status is `uploaded`), and the cleanup job (TD-03) can re-enqueue stale `uploaded` rows.

### Option B: Storage bucket notification → queue/webhook
- Configure the storage server to emit `s3:ObjectCreated:CompleteMultipartUpload` to a webhook (API) or directly to Redis/AMQP.
- **Pros:** Fires even if the client never calls the API after the upload.
- **Cons:** With TD-02 (A) the API already performs the completion, so the event adds no information. Notification config is server-specific (MinIO-only syntax), which breaks the S3-only portability noted above. Harder to test end-to-end; events can arrive before the DB row is updated.

**Recommendation:** **Option A** — the API already performs the completion, so enqueuing there gives validation, ordering and idempotency (`jobId = videoId`) in one place, without coupling to a storage-specific notification feature.

**Decision:** A (API enqueues after a successful `CompleteMultipartUpload`, `jobId = videoId`)

---

## TD-07: Video Worker Runtime & Deployment

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The diagram has a separate "Video Worker (FFmpeg)" container that updates the DB and storage. FFmpeg work is CPU-heavy and must not slow down API requests. The worker needs the `videos` entity, the storage client and the config validation the API already has.

**Options:**

### Option A: Separate process from the same `nestjs-project` codebase
- A second entrypoint (e.g., `src/worker.ts`) boots a Nest application context with only the worker module (queue consumer + videos persistence + storage). A `video-worker` compose service runs it from an image that has `ffmpeg`/`ffprobe` installed. The API registers the queue as producer only.
- **Pros:** Matches the diagram (separate container, independently scalable, restartable). Reuses entities, config namespaces (phase-01 TD-03/TD-04), DTOs and test infrastructure — no duplicated types. FFmpeg CPU load never touches the API process.
- **Cons:** Two entrypoints and a module split to maintain (worker module must not pull in HTTP-only modules). The API image does not need ffmpeg but the worker image does (two Dockerfile targets or one image with ffmpeg).

### Option B: Processor inside the API process
- `@Processor` registered in the API's `AppModule`; FFmpeg runs as child processes of the API container.
- **Pros:** Simplest setup: one container, one entrypoint.
- **Cons:** CPU-heavy work shares the API container's resources, which goes against "sem impacto na performance". Can't scale or restart processing separately. Diverges from the architecture diagram.

### Option C: Separate subproject (own package/language)
- A new top-level subproject (e.g., `video-worker/`, Node or another language) consuming the queue.
- **Pros:** Strong isolation; free choice of stack.
- **Cons:** Duplicates entity/schema knowledge and config validation, or needs a shared package (monorepo tooling not decided). More CI/lint/test surface for one job type.

**Recommendation:** **Option A** — it gives the separate container the diagram describes and keeps FFmpeg out of the API's resources, while reusing the existing TypeORM entities and config layer instead of duplicating them. Worker concurrency should start low (1–2 jobs), since each job runs FFmpeg. **Decided refinement:** One development image with `ffmpeg`/`ffprobe` installed is shared by the `nestjs-api` and `video-worker` services (instead of two Dockerfile targets). Tests run inside the `nestjs-api` container (`nestjs-project/CLAUDE.md`), so the processing integration tests must be able to execute the real binaries — the phase brief forbids mocking what the Compose infra can run. Test videos are generated at test time by ffmpeg itself (`-f lavfi -i testsrc`), so no binary fixtures are committed.

**Decision:** A (Separate process from the same `nestjs-project` codebase)

---

## TD-08: Media Tooling — FFmpeg/ffprobe Invocation and Source Access

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** Depends on TD-07. The worker must extract duration and metadata (ffprobe) and grab one frame (ffmpeg) from an original of up to 10GB. Two coupled choices: how the binaries are invoked, and whether the 10GB original is downloaded first.

**Options:**

### Option A: Direct `child_process.execFile`/`spawn` of system ffprobe/ffmpeg, reading the source over HTTP via a presigned GET URL
- `ffprobe -v error -print_format json -show_format -show_streams <url>` and `ffmpeg -ss <t> -i <url> -frames:v 1 ...`; binaries installed from the OS package manager in the worker image. FFmpeg's HTTP input does Range requests, so only the headers and the bytes around the chosen frame are fetched.
- **Pros:** No wrapper dependency; typed parsing of ffprobe's JSON is easy to unit test. No 10GB temp copy, so the worker doesn't need scratch disk sized for the largest upload. Thumbnail is written to stdout/temp (KBs) and uploaded with `PutObject`.
- **Cons:** MP4s with the `moov` atom at the end cost extra Range requests (still far less than a full download). Arguments must be passed as arrays (never a shell string) to avoid injection.

### Option B: Download the original to a temp volume, then run ffprobe/ffmpeg locally
- Stream `GetObject` to a scratch file, process it, delete it.
- **Pros:** Local-file seeking is fastest and most predictable for odd containers.
- **Cons:** Up to 10GB of disk I/O and scratch space per concurrent job, just to read headers and one frame. Slower start; disk must be sized and cleaned.

### Option C: `fluent-ffmpeg` wrapper
- Fluent JS API over the same binaries.
- **Pros:** Familiar API, many examples.
- **Cons:** **Deprecated on npm** ("Package no longer supported"). A maintenance risk for a new project, and it adds nothing the two required commands need.

**Recommendation:** **Option A** — two well-defined commands don't justify a wrapper (and the main one is deprecated), and reading over HTTP with Range requests avoids moving 10GB through the worker for an operation that needs only headers and one frame. Thumbnail policy: frame at ~10% of duration (clamped for very short videos), JPEG, max width 1280 px keeping aspect ratio, stored at the `auto.jpg` key from TD-04.

**Decision:** A (`execFile` of system ffprobe/ffmpeg, reading the source via presigned GET URL)

**Revisions:**
- 2026-10-08 — Persisted metadata is a fixed set of typed columns on the video: `duration_seconds`, `width`, `height`, `video_codec`, `audio_codec` (nullable), `container_format`, `bitrate`, `size_bytes`. Rationale: resolves AMB-2 from `phase-03-videos` validation — "metadados" in the capability was unspecified.

---

## TD-09: Accepted Input Formats & Transcoding Policy

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Reprodução via streaming (sem necessidade de download completo)"

**Context:** Streaming (TD-11) serves the stored file as-is unless it is transcoded. Browsers natively play MP4 (H.264/AAC) and WebM (VP8/VP9/AV1/Opus) reliably; other formats (e.g., MKV, AVI, HEVC in MOV) may not play. The phase bullets ask for metadata + thumbnail only, not transcoding.

**Options:**

### Option A: No transcoding; whitelist browser-playable containers, validated twice
- Initiate accepts only `video/mp4`, `video/webm` (optionally `video/quicktime`) by declared MIME. The worker then confirms with ffprobe (`format_name` + video codec) and marks the video `failed` if it is not playable.
- **Pros:** Fits the phase scope exactly. Worker jobs stay seconds-long (probe + one frame). Original quality is preserved; no storage doubling.
- **Cons:** Users with other formats must convert them before uploading. One rendition only (no adaptive bitrate).

### Option B: Transcode every upload to H.264/AAC MP4 (`+faststart`)
- Worker produces a normalized rendition; streaming serves that.
- **Pros:** Any input plays everywhere; `faststart` improves time-to-first-frame.
- **Cons:** Out of the phase's stated scope. Minutes to hours of CPU per 10GB file. Doubles storage, and status/failure handling get more complex.

### Option C: HLS/DASH adaptive ladder
- Segment into multiple renditions + manifest.
- **Pros:** Adaptive bitrate, the industry standard for large platforms.
- **Cons:** Much larger scope (packaging, manifests, a player that supports HLS/DASH). Not required by any phase bullet.

**Recommendation:** **Option A** — the plan defines processing as "extração de duração e metadados" + thumbnail, and progressive streaming of MP4/WebM over Range/206 already meets "reprodução sem download completo". B or C can be added later as a new job type without changing the upload contract.

**Decision:** A (No transcoding; MP4/WebM whitelist validated by ffprobe)

---

## TD-10: Unique Video URL Identifier

**Scope:** Cross-layer

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a short, unique, never-conflicting public identifier (`project-plan.md` §4: "URL curta e única"). It appears in API routes, in future frontend routes (`/watch/{id}`) and in shared links, so it can never change once issued. It is assigned at draft creation (initiate) so the URL exists from the start.

**Options:**

### Option A: Random 11-char base64url ID (64 bits) with a unique constraint
- Generated with `crypto.randomBytes(8).toString('base64url')` (YouTube-like length), stored in a `public_id` column with a unique index; on the (astronomically rare) collision, the insert is retried. The internal PK stays UUID.
- **Pros:** Short and non-sequential (doesn't reveal upload volume or allow enumeration). Uniqueness is guaranteed by the DB, not by probability alone. No dependency (`nanoid` ≥ 4 is ESM-only; the project is CommonJS).
- **Cons:** Needs a retry path on unique violation (trivial, but must be tested). One extra column/index.

### Option B: Use the existing UUID PK as the public identifier
- `/videos/3f2c…-…` with no extra column.
- **Pros:** Zero extra code; globally unique by design.
- **Cons:** 36 characters, so it doesn't meet the "URL curta" point of attention. Exposes the internal PK.

### Option C: Encode a sequential integer with Sqids/Hashids
- Short IDs derived from a serial column.
- **Pros:** Short, deterministic, no collision retry.
- **Cons:** Reversible with the alphabet, so enumeration and upload counts leak. Adds a dependency and a serial column next to the UUID PK. The encoding parameters become permanent (changing them breaks every URL).

**Recommendation:** **Option A** — it is the only option that is short, non-enumerable and DB-guaranteed unique without a dependency. 64 bits of randomness plus a unique index makes conflicts impossible in practice and impossible to persist in fact.

**Decision:** A (Random 11-char base64url ID with unique constraint)

---

## TD-11: Streaming (Range/206) and Download Delivery

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Depends on TD-04 (private bucket) and TD-05. Playback must start without downloading the full file (HTTP Range → `206 Partial Content`), and the user must be able to download the file. The diagram has the frontend streaming **from Object Storage**, not through the API. Inherited constraint: `next-frontend-config-base/TD-03` made the API URL server-only (strict BFF), so the browser never calls the API directly.

**Options:**

### Option A: API issues short-lived presigned GET URLs (JSON); storage serves Range/206
- `GET /videos/{publicId}/playback` returns `{ url, expiresAt }` (only for `ready` videos). `GET /videos/{publicId}/download` returns a presigned URL with `ResponseContentDisposition: attachment; filename*=…` (sanitized title + extension). The storage server answers Range requests with `206` natively.
- **Pros:** Zero video bytes through the API or the BFF. Range/206, seeking and resumable downloads come from S3 semantics. A JSON response fits the strict BFF: the Next server fetches the URL and puts it in the page. The API still decides who gets a URL.
- **Cons:** The URL must outlive the viewing session. The `<video>` element issues new Range requests while seeking, so the TTL must cover a long session (e.g., several hours), or the player re-fetches the URL on a `403`. A leaked URL works until it expires.

### Option B: API endpoint that 302-redirects to a presigned URL
- `GET /videos/{publicId}/stream` → `302 Location: <presigned>`; usable directly as `<video src>`.
- **Pros:** Stable URL for the player; a fresh presigned URL on every request.
- **Cons:** Under the strict BFF the browser can't reach the API, so the BFF would have to proxy or replicate the redirect. Every Range request re-hits the API (and the BFF).

### Option C: API proxies the object, implementing Range/206 itself
- API parses `Range`, calls `GetObject` with `Range`, pipes the body with `206`/`Content-Range`.
- **Pros:** Full control (access checks on every byte, view counting hooks).
- **Cons:** Every streamed and downloaded byte flows through the API (and, under the strict BFF, through Next as well). This is the bandwidth load the plan asks to avoid, and it duplicates HTTP Range handling S3 already does correctly.

**Recommendation:** **Option A** — storage handles Range/206 and Content-Disposition natively, so the API only authorizes and signs. A JSON response works with the strict-BFF decision already in place. Playback TTL should be long (hours) and the download TTL short (minutes). Access in this phase is limited to `ready` videos; visibility (public/unlisted) and anonymous viewing rules belong to Phases 04/05 and will plug into the same endpoints. **Decided refinement:** Authorization in this phase: `playback` and `download` are allowed **only to the authenticated owner of the video's channel**, and only when `processing_status = ready`. Every video in Phase 03 is a draft (TD-12), and visibility/anonymous viewing belong to Phases 04/05, which will widen access on these same endpoints.

**Decision:** A (Presigned GET URLs returned as JSON; storage serves Range/206)

---

## TD-12: Video Status Lifecycle

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** The video goes through two kinds of state: **technical** (upload/processing: uploading, queued, processing, ready, failed) and **editorial** (draft → published, which Phase 04 owns). The status values are exposed in API responses and will drive the future frontend and the Phase 04 channel panel ("status" column), so their shape is a cross-layer contract.

**Options:**

### Option A: Two orthogonal fields — `processing_status` + `publication_status`
- `processing_status`: `pending_upload → uploaded → processing → ready | failed`. `publication_status`: only `draft` in this phase (Phase 04 adds `published` and visibility). Publishing will require `processing_status = ready`.
- **Pros:** Each field has one owner (upload/worker vs editorial) and simple transitions. Phase 04 extends `publication_status` without touching worker logic. "Draft that is still processing" and "draft that failed" are representable without combined values.
- **Cons:** Two enums/columns; clients must read both.

### Option B: Single combined enum
- E.g., `uploading | processing | draft | published | failed`.
- **Pros:** One field; looks simple at first.
- **Cons:** Mixes concerns: "published" must imply "ready", and a reprocess or failure of a published video has no clean value. Phase 04 would have to change worker transitions. Combinations multiply as phases add states.

**Recommendation:** **Option A** — keeping technical and editorial state separate lets Phase 03 own `processing_status` completely and Phase 04 add publication rules without changing the worker's state machine. Transitions are enforced in the domain (only legal moves allowed; the worker only moves `uploaded → processing → ready | failed`). **Decided refinement:** Mapping to the phase brief's lifecycle "rascunho → processando → pronto/erro": *rascunho* = `publication_status = draft` (set at initiate, the whole of Phase 03); *processando* = `processing_status` in `uploaded`/`processing`; *pronto* = `ready`; *erro* = `failed`. `pending_upload` is the state while the multipart upload is still in progress.

**Decision:** A (Two orthogonal fields: `processing_status` + `publication_status`)

---

## TD-13: Processing Failure Handling & Retry Policy

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** Depends on TD-01, TD-07 and TD-12. Processing can fail **transiently** (storage/DB/network hiccup, worker crash mid-job) or **permanently** (corrupt file, no video stream, unsupported codec — TD-09). The user-visible outcome and what happens to the stored original must be defined.

**Options:**

### Option A: Retry only transient errors; permanent errors fail fast; terminal `failed` with a reason code; original kept
- Jobs use `attempts: 3` + exponential backoff. Media-validation errors throw `UnrecoverableError` (no retries). After the final failure, the worker sets `processing_status = failed` and a `processing_error` code (e.g., `INVALID_MEDIA`, `UNSUPPORTED_CODEC`, `PROCESSING_ERROR`). Stalled jobs (crashed worker) are re-queued by the queue. The original stays in storage until the owner deletes the video (deletion arrives with Phase 04 management) or re-uploads.
- **Pros:** No wasted retries on files that will never work. Recovers automatically from infra blips and worker crashes. Users get a machine-readable reason, consistent with the `{ statusCode, error, message }` domain-code style (phase-02 TD-07). Keeping the original allows support/debugging and a future reprocess.
- **Cons:** Failed originals use storage until deleted. No self-service "retry" in this phase.

### Option B: Same as A, plus an owner-triggered `POST /videos/{publicId}/reprocess`
- Allows the owner to re-enqueue a `failed` video.
- **Pros:** Self-service recovery when the cause was transient beyond the retry window.
- **Cons:** One more endpoint + state transition (`failed → uploaded`). Permanent failures will just fail again. No phase bullet asks for it.

### Option C: Delete the original on permanent failure
- On final failure, remove the object and mark the video `failed`.
- **Pros:** Frees storage immediately.
- **Cons:** Destroys evidence needed to diagnose. A misclassified "permanent" error loses the user's upload irreversibly.

**Recommendation:** **Option A** — the queue's attempts/backoff and `UnrecoverableError` separate transient from permanent failures with no custom code, and keeping the original makes every failure diagnosable and recoverable later. B can be added when a real need for self-service retry appears; C trades irreversible data loss for storage savings that don't matter at this stage.

**Decision:** A (Retry transient errors; `UnrecoverableError` for permanent ones; terminal `failed` with reason code; original kept)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|----------------|--------|
| TD-01 | Backend | Message queue technology | A — BullMQ + Redis (`@nestjs/bullmq`) | A (BullMQ on Redis) |
| TD-02 | Cross-layer | Large-file upload protocol | A — Presigned S3 multipart, API-orchestrated | A (S3 multipart upload with presigned part URLs, API-orchestrated) |
| TD-03 | Cross-layer | Upload session state, resume & limits | A — `ListParts` as source of truth; 10 GiB / 64 MiB parts | A (Storage is the source of truth via `ListParts`; 10 GiB max, 64 MiB parts) |
| TD-04 | Backend | Storage layout: buckets, keys, access | A — Single private bucket, prefixes, keys by video UUID | A (Single private bucket, prefixes per asset type, keys by video UUID) |
| TD-05 | Backend | Presigned URL host under Docker networking | A — Internal endpoint for ops + public endpoint for signing | A (Internal endpoint for operations, public endpoint for signing) |
| TD-06 | Backend | Processing trigger | A — API enqueues on complete (`jobId = videoId`) | A (API enqueues after a successful `CompleteMultipartUpload`, `jobId = videoId`) |
| TD-07 | Backend | Worker runtime & deployment | A — Separate process/container, same codebase | A (Separate process from the same `nestjs-project` codebase) |
| TD-08 | Backend | FFmpeg/ffprobe invocation & source access | A — `execFile` system binaries over presigned HTTP URL | A (`execFile` of system ffprobe/ffmpeg, reading the source via presigned GET URL) |
| TD-09 | Backend | Input formats & transcoding policy | A — No transcoding; MP4/WebM whitelist validated by ffprobe | A (No transcoding; MP4/WebM whitelist validated by ffprobe) |
| TD-10 | Cross-layer | Unique video URL identifier | A — Random 11-char base64url + unique index | A (Random 11-char base64url ID with unique constraint) |
| TD-11 | Cross-layer | Streaming (Range/206) & download delivery | A — Presigned GET URLs returned as JSON | A (Presigned GET URLs returned as JSON; storage serves Range/206) |
| TD-12 | Cross-layer | Video status lifecycle | A — `processing_status` + `publication_status` | A (Two orthogonal fields: `processing_status` + `publication_status`) |
| TD-13 | Backend | Processing failure handling & retry | A — Transient retry, `UnrecoverableError`, keep original | A (Retry transient errors; `UnrecoverableError` for permanent ones; terminal `failed` with reason code; original kept) |
