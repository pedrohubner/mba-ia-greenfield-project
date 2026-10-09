# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 3/13 completed

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
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.8 — MediaModule: ffprobe, validação de formato e extração de thumbnail
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.5 — Início do upload: POST /videos com pré-cadastro do rascunho
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.6 — Retomada do upload: assinar URLs de partes e listar partes enviadas
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.7 — Conclusão e cancelamento do upload
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.11 — Consulta do vídeo: GET /videos/:publicId
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.9 — Video worker: entrypoint, processor e ciclo de status
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.10 — Job agendado cleanup-stale-uploads: rascunhos abandonados e uploads parados
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.12 — Streaming e download: URLs pré-assinadas de playback e download
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.13 — Documentação: openapi.json exportado e CLAUDE.md do backend
- **Status:** pending
- **Tests:** —
- **Observations:** none
