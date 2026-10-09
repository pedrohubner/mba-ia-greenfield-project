---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-10-08T09:27:18-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-10-08T09:27:12-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-08T09:21:11-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-07-05T13:16:39-03:00"
  docs/decisions/technical-decisions-next-frontend-config-base.md: "2026-07-05T13:16:39-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver video upload up to 10GB directly to object storage with resume support, automatic draft pre-registration at upload start, background processing (queue + FFmpeg worker) that extracts duration and metadata and generates a thumbnail from a video frame, a unique short URL per video, and streaming (Range/206) plus download of the processed video — backend only (`nestjs-project/` API + video worker + Docker infra).

---

## Step Implementations

### SI-03.1 — Infra: dependências, namespaces de config e serviços Docker

**Description:** Instala as bibliotecas da fase, cria os namespaces de configuração `storage`, `queue` e `video` no padrão `registerAs` herdado, e adiciona MinIO, o bucket init, Redis e ffmpeg ao ambiente Docker — a fundação que todos os SIs seguintes consomem.

**Technical actions:**

1. Instalar em `nestjs-project`: `@nestjs/bullmq@^12.0.0`, `bullmq@^6.3.11`, `ioredis` (peer opcional do `bullmq` 6 — precisa ser instalado explicitamente; library-refs → `bullmq`), `@aws-sdk/client-s3@^3.1147.0`, `@aws-sdk/s3-request-presigner@^3.1147.0` (per `phase-03-videos/TD-01`, `TD-02`)
2. Criar `src/config/storage.config.ts` — `registerAs('storage', …)` lendo `STORAGE_ENDPOINT` (default `'http://minio:9000'`), `STORAGE_PUBLIC_ENDPOINT` (default `'http://localhost:9000'`), `STORAGE_REGION` (default `'us-east-1'`), `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY` (obrigatórios), `STORAGE_BUCKET` (default `'streamtube-media'`), `STORAGE_PART_SIZE_BYTES` (default `67108864`), `STORAGE_PART_URL_TTL_SECONDS` (`3600`), `PLAYBACK_URL_TTL_SECONDS` (`21600`), `DOWNLOAD_URL_TTL_SECONDS` (`900`), `THUMBNAIL_URL_TTL_SECONDS` (`3600`); criar `src/config/queue.config.ts` — `registerAs('queue', …)` com `REDIS_HOST` (default `'redis'`), `REDIS_PORT` (`6379`), `QUEUE_PREFIX` (default `'bull'` — usado como `prefix` do BullMQ na API e no worker, isola as chaves Redis por ambiente); criar `src/config/video.config.ts` — `registerAs('video', …)` com `VIDEO_WORKER_CONCURRENCY` (`1`), `STALE_UPLOAD_TTL_HOURS` (`24`), `STALE_UPLOADED_REQUEUE_MINUTES` (`15`) (per `phase-03-videos/TD-03`, `TD-05`, `TD-07`, `TD-11`; inherited `phase-01-configuracao-base/TD-03`)
3. Atualizar `src/config/env.validation.ts` com todas as chaves acima — `STORAGE_PART_SIZE_BYTES` com `Joi.number().integer().min(5242880)` (mínimo de parte do S3), TTLs como inteiros positivos — e `.env.example` com valores compatíveis com Compose (hosts = nomes de serviço; `STORAGE_PUBLIC_ENDPOINT=http://localhost:9000` é a única exceção deliberada à regra de service-name, per `phase-03-videos/TD-05` refinement); registrar os três namespaces no `ConfigModule.forRoot({ load })`
4. Docker: adicionar a `nestjs-project/compose.yaml` `minio` (imagem oficial fixada em uma tag publicada — MinIO CE está em EOL upstream, confirmar que a tag ainda faz pull; `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`, portas `9000`/`9001`, volume nomeado, healthcheck), `minio-init` (`minio/mc`, one-shot: cria `STORAGE_BUCKET` se ausente; `depends_on: minio: service_healthy`), `redis` (imagem `redis` fixada em major, `command: redis-server --maxmemory-policy noeviction`, healthcheck `redis-cli ping`); `nestjs-api` passa a depender de `redis` (healthy) e `minio-init` (`service_completed_successfully`); e instalar `ffmpeg` (inclui `ffprobe`) via `apt` no `nestjs-project/Dockerfile.dev` — a mesma imagem de dev serve `nestjs-api` e o futuro `video-worker`, e os testes de processamento rodam com os binários reais no container `nestjs-api` (per `phase-03-videos/TD-01`, `TD-04`, `TD-07` refinement; library-refs → `bullmq`)
5. Criar `test/setup-env.ts` e registrá-lo depois de `dotenv/config` em `setupFiles` do Jest — `package.json` (`<rootDir>/../test/setup-env.ts`, pois `rootDir` é `src`) e `test/jest-e2e.json` (`<rootDir>/test/setup-env.ts`) — definindo `STORAGE_PUBLIC_ENDPOINT = STORAGE_ENDPOINT` (os testes buscam URLs assinadas de dentro do container, per `phase-03-videos/TD-05` refinement), `STORAGE_PART_SIZE_BYTES=5242880` (multipart real com fixtures pequenas) e `QUEUE_PREFIX='bull-test'` — assim o container `video-worker` (prefixo de dev `bull`) nunca consome jobs criados pelos testes

**Tests:** _(empty — Infra)_

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d` deixa `db`, `mailpit`, `minio` e `redis` healthy e `minio-init` encerrado com exit code 0; o bucket `streamtube-media` existe (`mc ls`)
- `docker compose exec nestjs-api ffprobe -version` e `ffmpeg -version` retornam com sucesso
- `docker compose exec redis redis-cli CONFIG GET maxmemory-policy` retorna `noeviction`
- Subir a aplicação sem `STORAGE_ACCESS_KEY` falha na validação Joi no bootstrap; com `STORAGE_PART_SIZE_BYTES=1048576` também falha (abaixo de 5 MiB)
- Dentro de qualquer suíte Jest (unit, integration ou e2e), `process.env.QUEUE_PREFIX` é `bull-test`, `STORAGE_PART_SIZE_BYTES` é `5242880` e `STORAGE_PUBLIC_ENDPOINT` é igual a `STORAGE_ENDPOINT`
- A suíte existente (`npm test`, `npm run test:e2e`) continua verde

---

### SI-03.2 — StorageModule: clientes S3 interno/público, multipart e pré-assinatura

**Description:** Encapsula todo o acesso ao object storage em um `StorageService` que só fala a API S3 — operações reais pelo cliente interno e assinatura pelo cliente público —, mantendo o restante do código agnóstico ao servidor (MinIO hoje, qualquer S3-compatível depois).

**Technical actions:**

1. Criar `src/storage/storage.service.ts` — `StorageService` injetando `storageConfig.KEY`; construir dois `S3Client` com as mesmas credenciais/região e `forcePathStyle: true`: `internalClient` (`endpoint = STORAGE_ENDPOINT`) para chamadas reais e `publicClient` (`endpoint = STORAGE_PUBLIC_ENDPOINT`) usado **somente** em `getSignedUrl` (per `phase-03-videos/TD-05`; library-refs → `@aws-sdk/client-s3`)
2. Implementar operações multipart no `internalClient`: `createMultipartUpload(key, contentType): Promise<string>` (retorna `UploadId`), `listParts(key, uploadId)` (pagina via `PartNumberMarker` até `IsTruncated = false`; retorna `{ partNumber, etag, size }[]` ascendente), `completeMultipartUpload(key, uploadId, parts)` (ordena por `PartNumber`), `abortMultipartUpload(key, uploadId)` (per `phase-03-videos/TD-02`, `TD-03`)
3. Implementar operações de objeto no `internalClient`: `headObject(key): Promise<{ contentLength: number; contentType?: string }>`, `putObject(key, body: Buffer, contentType)`, `deleteObject(key)` (per `phase-03-videos/TD-03`, `TD-08`)
4. Implementar assinatura via `@aws-sdk/s3-request-presigner`: `signUploadPartUrl(key, uploadId, partNumber, ttlSeconds)` e `signGetObjectUrl(key, { audience: 'public' | 'internal', ttlSeconds, contentDisposition? })` — `audience` escolhe o cliente (o worker assina com `internal` porque ffprobe/ffmpeg rodam no container; o browser recebe URLs `public`); `contentDisposition` vira `ResponseContentDisposition` (per `phase-03-videos/TD-05` refinement, `TD-11`; library-refs → `@aws-sdk/s3-request-presigner`)
5. Criar `src/storage/storage.module.ts` exportando `StorageService`; criar `src/test/storage.ts` com helpers de teste (gerar prefixo de chave único por suite, limpar objetos do prefixo no `afterAll`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` (assinatura) | Unit: URL de parte e de GET assinadas com o host de `STORAGE_PUBLIC_ENDPOINT` para `audience: 'public'` e de `STORAGE_ENDPOINT` para `'internal'`; `response-content-disposition` presente quando informado (assinatura é local, sem rede) | `src/storage/storage.service.spec.ts` |
| `StorageService` (multipart + objetos) | Integration (MinIO real): create → `PUT` de 2 partes de 5 MiB nas URLs assinadas → `listParts` devolve ambas com ETag → complete → `headObject` com `contentLength` = soma; abort descarta as partes; `GET` assinado com `Range: bytes=0-99` responde `206` | `src/storage/storage.service.integration-spec.ts` |
| `StorageModule` | Unit: compilation | `src/storage/storage.module.spec.ts` |

**Dependencies:** SI-03.1 — config `storage` e serviços `minio`/`minio-init`

**Acceptance criteria:**

- Uma URL de parte assinada para `audience: 'public'` tem host/porta de `STORAGE_PUBLIC_ENDPOINT`; um `PUT` nela (no ambiente de teste, onde o endpoint público aponta para o interno) responde `200` com header `ETag`
- `listParts` de um upload com 3 partes enviadas devolve exatamente as 3, em ordem ascendente, com os ETags retornados pelo storage
- `completeMultipartUpload` com as partes fora de ordem conclui com sucesso (o service ordena) e o objeto resultante tem o tamanho somado das partes
- `abortMultipartUpload` faz um `listParts` subsequente falhar com `NoSuchUpload`
- Um `GET` na URL de `signGetObjectUrl` com header `Range: bytes=0-99` retorna `206` com `Content-Range: bytes 0-99/{size}`

---

### SI-03.3 — Entidade Video, migration e gerador de public_id

**Description:** Cria o modelo persistente do vídeo — status técnico e editorial separados, metadados tipados e o identificador público curto — e o `VideosModule` que passa a ser dono dessa entidade.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` — `Video` com todas as colunas de `### Data Model → Video` (nomes verbatim), enums `VideoProcessingStatus` (`pending_upload`, `uploaded`, `processing`, `ready`, `failed`) e `VideoPublicationStatus` (`draft`), relação `@ManyToOne(() => Channel)` via `channel_id`, e um `ValueTransformer` numérico para as colunas `bigint` (`size_bytes`, `bitrate`) (per `phase-03-videos/TD-08` revision, `TD-12`)
2. Gerar a migration `CreateVideos` (`npm run migration:generate`) — tipos enum `video_processing_status` e `video_publication_status`, FK `channel_id → channels.id ON DELETE CASCADE`, índices únicos/compostos de `### Data Model → Video` (`(public_id)` unique, `(channel_id)`, `(processing_status, created_at)`); revisar o SQL gerado antes de commitar (per `phase-03-videos/TD-10`, `TD-12`)
3. Criar `src/videos/public-id.util.ts` — `generatePublicId(): string` = `crypto.randomBytes(8).toString('base64url')` (11 caracteres `[A-Za-z0-9_-]`) e `isValidPublicId(value: string): boolean` (regex `^[A-Za-z0-9_-]{11}$`) (per `phase-03-videos/TD-10`)
4. Criar `src/videos/videos.module.ts` com `TypeOrmModule.forFeature([Video])` e registrá-lo em `AppModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: defaults (`processing_status = pending_upload`, `publication_status = draft`, metadados null), unique em `public_id`, FK + cascade ao remover o canal, transformer devolve `size_bytes` como `number` para 10 GiB | `src/videos/entities/video.entity.integration-spec.ts` |
| `public-id.util` | Unit: tamanho 11, charset base64url, `isValidPublicId` rejeita tamanhos/caracteres inválidos | `src/videos/public-id.util.spec.ts` |
| `VideosModule` | Unit: compilation | `src/videos/videos.module.spec.ts` |

**Dependencies:** SI-03.1 — dependências instaladas e app configurado

**Acceptance criteria:**

- `npm run migration:run` cria a tabela `videos` com os dois tipos enum e os três índices; `migration:revert` remove tabela e tipos sem deixar resíduos
- Inserir um `Video` sem informar status persiste `processing_status = pending_upload` e `publication_status = draft`
- Inserir dois vídeos com o mesmo `public_id` viola a constraint única
- Remover um `Channel` remove em cascata os vídeos dele
- Um vídeo salvo com `size_bytes = 10737418240` é lido de volta como o número `10737418240`

---

### SI-03.4 — Fila de processamento: conexão BullMQ e producer idempotente

**Description:** Conecta a API ao Redis via `@nestjs/bullmq`, registra a fila `video-processing` e expõe um producer que enfileira `process-video` com `jobId = videoId`, de modo que reenfileirar o mesmo vídeo nunca duplica trabalho.

**Technical actions:**

1. Criar `src/video-processing/video-processing.constants.ts` — `VIDEO_PROCESSING_QUEUE = 'video-processing'`, nomes de job `PROCESS_VIDEO_JOB = 'process-video'` e `CLEANUP_STALE_UPLOADS_JOB = 'cleanup-stale-uploads'`, tipo `ProcessVideoJobData { videoId: string }` e as job options default de `### Events/Messages` (`attempts: 3`, `backoff: { type: 'exponential', delay: 5000 }`, `removeOnComplete: { age: 86400 }`, `removeOnFail: { age: 604800 }`) (per `phase-03-videos/TD-01`, `TD-13`)
2. Registrar `BullModule.forRootAsync` em `AppModule` com `inject: [queueConfig.KEY]` → `connection: { host, port }` e `prefix: QUEUE_PREFIX` — producer da API mantém `maxRetriesPerRequest` default para falhar rápido dentro de requisições HTTP (library-refs → `@nestjs/bullmq`, `bullmq`)
3. Criar `src/video-processing/video-processing-queue.module.ts` — `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE, defaultJobOptions })` + provider `VideoProcessingProducer`, exportando o producer (a API importa só o producer, nunca o processor) (per `phase-03-videos/TD-07`)
4. Criar `src/video-processing/video-processing.producer.ts` — `VideoProcessingProducer` com `@InjectQueue(VIDEO_PROCESSING_QUEUE)`; `enqueueProcessing(videoId: string): Promise<void>` → `queue.add(PROCESS_VIDEO_JOB, { videoId }, { jobId: videoId })` (per `phase-03-videos/TD-06`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingProducer` | Integration (Redis real): `enqueueProcessing` duas vezes com o mesmo `videoId` resulta em um único job com `id = videoId` e as job options default; as chaves do job ficam sob o prefixo de teste `bull-test` | `src/video-processing/video-processing.producer.integration-spec.ts` |
| `VideoProcessingQueueModule` | Unit: compilation (com `BullModule.forRoot` de teste apontando para o Redis do Compose) | `src/video-processing/video-processing-queue.module.spec.ts` |

**Dependencies:** SI-03.1 — config `queue` e serviço `redis`

**Acceptance criteria:**

- Enfileirar o mesmo `videoId` duas vezes deixa exatamente um job `process-video` na fila, com `jobId` igual ao `videoId`
- O job criado carrega `attempts = 3` e backoff exponencial com `delay = 5000`
- A aplicação sobe conectada ao Redis do Compose (`redis:6379`) e encerra sem handles pendurados (`app.close()` fecha as conexões da fila)

---

### SI-03.5 — Início do upload: POST /videos com pré-cadastro do rascunho

**Route:** POST /videos
**Test Specs:** see `nestjs-project/specs/videos-create.plan.md`
**Authorization:** Authenticated (vídeo criado no canal do chamador)

**Description:** Ao iniciar o upload, cria o vídeo como rascunho (`pending_upload` + `draft`) já com `public_id`, abre o multipart upload no storage e devolve o tamanho/quantidade de partes — o cliente nunca envia bytes para a API.

**Technical actions:**

1. Criar `src/videos/dto/create-video.dto.ts` — `CreateVideoDto` (`filename`, `size_bytes`, `content_type`, `title?`) com as regras de `### API Contracts → Validation Rules — videos`; criar `src/videos/video-title.util.ts` — `deriveVideoTitle(filename, title?)`: usa `title` aparado se presente, senão o nome do arquivo sem extensão, sanitizado (remove caracteres de controle) e truncado a 100 (per `phase-03-videos/TD-03` revision)
2. Criar `src/videos/exceptions/video.exceptions.ts` — subclasses de `DomainException` com código/HTTP/mensagem verbatim de `### Error Catalog`: `VideoNotFoundException`, `UnsupportedMediaTypeException`, `InvalidUploadStateException`, `InvalidUploadPartsException`, `UploadSizeExceededException`, `VideoNotReadyException` (inherited `phase-02-auth/TD-07`)
3. Adicionar `findByUserId(userId): Promise<Channel | null>` ao `ChannelsService` (o lookup de canal pertence ao `ChannelsModule`); importar `ChannelsModule`, `StorageModule` e `VideoProcessingQueueModule` no `VideosModule`
4. Criar `src/videos/videos.service.ts` — `initiateUpload(userId, dto)`: valida whitelist `video/mp4`/`video/webm` (→ `UnsupportedMediaTypeException`), resolve o canal, gera `id` (`crypto.randomUUID()`) para montar `object_key = videos/{id}/original.{ext}`, chama `storage.createMultipartUpload`, persiste o `Video` com `public_id` (retry em violação de unicidade), aborta o multipart best-effort se o insert falhar; retorna `{ video, upload: { part_size, part_count } }` com `part_size = STORAGE_PART_SIZE_BYTES` (per `phase-03-videos/TD-02`, `TD-03`, `TD-04`, `TD-09`, `TD-10`); criar `src/videos/video.presenter.ts` — `toVideoResponse(video)` no shape `Video` de `### API Contracts` (nunca serializa `id`, `channel_id`, `object_key`, `upload_id`, `thumbnail_key`; `thumbnail_url` assinado com `audience: 'public'` e `THUMBNAIL_URL_TTL_SECONDS` quando `thumbnail_key` existe)
5. Criar `src/videos/videos.controller.ts` — `@Controller('videos')` com `@Post()` → `201`, usuário via `@CurrentUser()`; decorators OpenAPI explícitos (`@ApiOperation`, `@ApiResponse` por status com `ApiErrorEnvelopeDto`, `@ApiBearerAuth`) (inherited `openapi-docs-nestjs/TD-01` revision)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `deriveVideoTitle` | Unit: `title` aparado tem precedência; fallback remove extensão; trunca em 100; nome sem extensão útil | `src/videos/video-title.util.spec.ts` |
| `VideosService.initiateUpload` | Unit (storage/repo mockados): whitelist → 415; retry de `public_id` em colisão; abort best-effort quando o insert falha; `part_count = ceil(size_bytes / part_size)` | `src/videos/videos.service.spec.ts` |
| `VideosService.initiateUpload` | Integration (DB + MinIO reais): persiste o rascunho no canal do usuário e o `upload_id` corresponde a um multipart aberto (`listParts` vazio) | `src/videos/videos.service.integration-spec.ts` |
| `ChannelsService.findByUserId` | Integration: encontra o canal do usuário; null para usuário sem canal | `src/channels/channels.service.integration-spec.ts` |
| `VideosController` — `POST /videos` | E2E (app com os mesmos pipes/filters globais do `main.ts`): `201` com shape `Video` sem campos internos; `415 UNSUPPORTED_MEDIA_TYPE`; wiring do `ValidationPipe` (`size_bytes` acima de 10 GiB → `400 VALIDATION_ERROR`); `401` sem token | `test/videos-create.e2e-spec.ts` |

_O teste unitário do presenter (`toVideoResponse`) está consolidado na linha do SI-03.11 (mesmo arquivo), para manter este SI dentro do limite de 5 arquivos de teste._

**Dependencies:** SI-03.2 — `StorageService`; SI-03.3 — entidade `Video`; SI-03.4 — `VideoProcessingQueueModule` importado pelo `VideosModule`

**Acceptance criteria:**

- `POST /videos` com `{ filename: "aula.mp4", size_bytes: 10485760, content_type: "video/mp4" }` retorna `201` com `video.processing_status = "pending_upload"`, `video.publication_status = "draft"`, `video.title = "aula"`, `video.public_id` de 11 caracteres e `upload.part_count` coerente com `upload.part_size`
- `POST /videos` com `title: "  Minha aula  "` retorna `video.title = "Minha aula"`
- `POST /videos` com `content_type: "video/x-matroska"` retorna `415` com `error: "UNSUPPORTED_MEDIA_TYPE"` e nenhuma linha é criada
- `POST /videos` com `size_bytes: 10737418241` retorna `400` com `error: "VALIDATION_ERROR"`
- `POST /videos` sem `Authorization` retorna `401`
- A resposta nunca contém `id`, `channel_id`, `object_key` nem `upload_id`

---

### SI-03.6 — Retomada do upload: assinar URLs de partes e listar partes enviadas

**Route:** POST /videos/:publicId/upload/part-urls, GET /videos/:publicId/upload/parts
**Test Specs:** see `nestjs-project/specs/videos-upload-parts.plan.md`
**Authorization:** Authenticated + Owner (não-dono → 404)

**Description:** Entrega ao cliente URLs pré-assinadas por lote de partes e a lista das partes já gravadas no storage, que é a fonte da verdade para retomar um upload interrompido sem reenviar o que já chegou.

**Technical actions:**

1. Criar `src/videos/dto/sign-part-urls.dto.ts` — `SignPartUrlsDto.part_numbers` (`@IsArray`, `@ArrayMinSize(1)`, `@ArrayMaxSize(100)`, `@ArrayUnique`, `@IsInt({ each: true })`, `@Min(1, { each: true })`) (per `### API Contracts → Validation Rules — videos`)
2. Adicionar a `VideosService` o helper `findOwnedOrFail(userId, publicId)` — `isValidPublicId` falso, vídeo inexistente ou de outro canal → `VideoNotFoundException` (mesma resposta nos três casos), e o guard de estado `assertPendingUpload(video)` → `InvalidUploadStateException` (per `phase-03-videos/TD-10`, `TD-11`)
3. Implementar `VideosService.signPartUrls(userId, publicId, partNumbers)` — calcula `part_count` a partir de `size_bytes` e `STORAGE_PART_SIZE_BYTES`, rejeita número > `part_count` com `InvalidUploadPartsException`, assina cada parte com `storage.signUploadPartUrl` (`audience` público, TTL `STORAGE_PART_URL_TTL_SECONDS`) e devolve `{ parts, expires_at }` (per `phase-03-videos/TD-02`, `TD-03`, `TD-05`)
4. Implementar `VideosService.listUploadedParts(userId, publicId)` — `storage.listParts(object_key, upload_id)` mapeado para `{ part_size, part_count, parts: { part_number, etag, size }[] }` (per `phase-03-videos/TD-03`)
5. Adicionar ao `VideosController` `@Post(':publicId/upload/part-urls')` (`200`) e `@Get(':publicId/upload/parts')` com decorators OpenAPI explícitos (inherited `openapi-docs-nestjs/TD-01` revision)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.findOwnedOrFail` / `assertPendingUpload` | Unit: id malformado, inexistente e de outro dono → mesma `VideoNotFoundException`; estados ≠ `pending_upload` → `InvalidUploadStateException` | `src/videos/videos.service.spec.ts` |
| `VideosService.signPartUrls` | Unit: parte > `part_count` → `InvalidUploadPartsException`; `expires_at` = agora + TTL | `src/videos/videos.service.spec.ts` |
| `VideosService` (retomada) | Integration (DB + MinIO reais, `STORAGE_PART_SIZE_BYTES=5242880`): assina 3 partes, envia 2 via `PUT`, `listUploadedParts` devolve exatamente as 2 com ETag; assinar de novo só a parte faltante funciona | `src/videos/videos.service.integration-spec.ts` |
| `VideosController` — `POST …/upload/part-urls`, `GET …/upload/parts` | E2E: `200` com URLs/partes; `422 INVALID_UPLOAD_PARTS` para parte > `part_count`; `404 VIDEO_NOT_FOUND` para vídeo de outro usuário; wiring do `ValidationPipe` (`part_numbers: []` → `400 VALIDATION_ERROR`); `401` sem token em ambas as rotas | `test/videos-upload-parts.e2e-spec.ts` |

**Dependencies:** SI-03.5 — `VideosService`, `VideosController` e exceções de vídeo

**Acceptance criteria:**

- `POST /videos/:publicId/upload/part-urls` com `{ part_numbers: [1, 2] }` do dono retorna `200` com 2 URLs e `expires_at` ≈ agora + 1h
- `POST …/upload/part-urls` com um número maior que `part_count` retorna `422` com `error: "INVALID_UPLOAD_PARTS"`
- `POST …/upload/part-urls` com `part_numbers: []` ou com duplicatas retorna `400` com `error: "VALIDATION_ERROR"`
- Depois de enviar as partes 1 e 2 de um upload de 3 partes, `GET /videos/:publicId/upload/parts` retorna exatamente as partes 1 e 2, com os ETags devolvidos pelo storage
- `GET …/upload/parts` de um vídeo de outro usuário, ou com `publicId` inexistente, retorna `404` com `error: "VIDEO_NOT_FOUND"` (respostas idênticas)
- `POST …/upload/part-urls` para um vídeo já `uploaded` retorna `409` com `error: "INVALID_UPLOAD_STATE"`

---

### SI-03.7 — Conclusão e cancelamento do upload

**Route:** POST /videos/:publicId/upload/complete, DELETE /videos/:publicId/upload
**Test Specs:** see `nestjs-project/specs/videos-upload-complete.plan.md`
**Authorization:** Authenticated + Owner (não-dono → 404)

**Description:** Fecha o multipart, valida o objeto final, move o vídeo para `uploaded` e dispara o processamento de forma idempotente; ou cancela o upload descartando partes e rascunho.

**Technical actions:**

1. Criar `src/videos/dto/complete-upload.dto.ts` — `CompleteUploadDto.parts` (`@IsArray`, `@ArrayMinSize(1)`, `@ArrayMaxSize(10000)`, `@ValidateNested({ each: true })`, `@Type(() => UploadedPartDto)`), com `UploadedPartDto { part_number: @IsInt @Min(1); etag: @IsString @IsNotEmpty }`; unicidade de `part_number` verificada no DTO (validator customizado) (per `### API Contracts → Validation Rules — videos`)
2. Implementar `VideosService.completeUpload(userId, publicId, parts)` — se `processing_status = uploaded`: só reenfileira (`enqueueProcessing`, deduplicado por `jobId`) e retorna; se `processing | ready | failed`: `InvalidUploadStateException`; se `pending_upload`: `storage.completeMultipartUpload` com partes ordenadas, mapeando `S3ServiceException` de nome `InvalidPart`/`InvalidPartOrder`/`EntityTooSmall` para `InvalidUploadPartsException` (per `phase-03-videos/TD-03`, `TD-06`)
3. Após o complete: `storage.headObject` — `contentLength > 10737418240` → `deleteObject` + remove a linha + `UploadSizeExceededException`; caso contrário atualiza `size_bytes = contentLength`, `upload_id = null`, `processing_status = uploaded`, salva e **só então** chama `enqueueProcessing(video.id)` (falha de enqueue deixa o vídeo em `uploaded`, recuperado pelo retry do complete ou pelo `cleanup-stale-uploads` — per `phase-03-videos/TD-06`)
4. Implementar `VideosService.abortUpload(userId, publicId)` — exige `pending_upload`, chama `storage.abortMultipartUpload` e remove a linha (per `phase-03-videos/TD-02`)
5. Adicionar ao `VideosController` `@Post(':publicId/upload/complete')` (`200`, presenter `Video`) e `@Delete(':publicId/upload')` (`204`) com decorators OpenAPI explícitos (inherited `openapi-docs-nestjs/TD-01` revision)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Unit (storage/producer mockados): ramo `uploaded` só reenfileira sem tocar o storage; estados terminais → 409; `InvalidPart` → `InvalidUploadPartsException`; tamanho > 10 GiB apaga objeto + linha; enqueue chamado depois do save | `src/videos/videos.service.spec.ts` |
| `VideosService.completeUpload` / `abortUpload` | Integration (DB + MinIO + Redis reais, partes de 5 MiB): 2 partes → complete → `uploaded`, `size_bytes` real, `upload_id` null, job `process-video` com `id = video.id`; complete repetido mantém 1 job; abort remove a linha e o upload | `src/videos/videos.service.integration-spec.ts` |
| `CompleteUploadDto` | Unit: `part_number` duplicado e `etag` vazio rejeitados pelo `ValidationPipe` | `src/videos/dto/complete-upload.dto.spec.ts` |
| `VideosController` — `POST …/upload/complete`, `DELETE …/upload` | E2E: complete `200` com `uploaded` e complete repetido idempotente; `422 INVALID_UPLOAD_PARTS`; `409 INVALID_UPLOAD_STATE`; abort `204` seguido de `404`; wiring do `ValidationPipe` (`parts` ausente → `400 VALIDATION_ERROR`); `401` sem token em ambas as rotas | `test/videos-upload-complete.e2e-spec.ts` |

**Dependencies:** SI-03.6 — helpers de ownership/estado e upload retomável; SI-03.4 — `VideoProcessingProducer`

**Acceptance criteria:**

- `POST /videos/:publicId/upload/complete` com as partes enviadas retorna `200` com `processing_status: "uploaded"` e `size_bytes` igual ao tamanho real do objeto
- Após o complete existe exatamente um job `process-video` com `jobId` igual ao id interno do vídeo; repetir o complete retorna `200` e continua havendo um único job
- `POST …/upload/complete` referenciando uma parte nunca enviada ou com ETag errado retorna `422` com `error: "INVALID_UPLOAD_PARTS"` e o vídeo permanece `pending_upload` (completar com um subconjunto das partes enviadas é válido no S3 — as demais são descartadas)
- `POST …/upload/complete` para um vídeo `ready` retorna `409` com `error: "INVALID_UPLOAD_STATE"`
- `DELETE /videos/:publicId/upload` do dono retorna `204`; um `GET /videos/:publicId` em seguida retorna `404`
- `DELETE …/upload` de um vídeo já `uploaded` retorna `409` com `error: "INVALID_UPLOAD_STATE"`

---

### SI-03.8 — MediaModule: ffprobe, validação de formato e extração de thumbnail

**Description:** Isola a invocação de `ffprobe`/`ffmpeg` em serviços pequenos e testáveis — extração de metadados tipados, validação do whitelist de formatos e geração do frame da thumbnail — lendo a fonte por URL HTTP (Range) sem baixar o arquivo inteiro.

**Technical actions:**

1. Criar `src/media/media-probe.service.ts` — `MediaProbeService.probe(source: string): Promise<ProbeResult>` via `execFile('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', source])` (argumentos em array, nunca string de shell; timeout configurado) e parser puro `parseProbeOutput(json)` → `{ durationSeconds, width, height, videoCodec, audioCodec, containerFormat, bitrate }` (nomes mapeados para as colunas de `### Data Model → Video`) (per `phase-03-videos/TD-08`, `TD-08` revision)
2. Criar `src/media/media-validation.ts` — `assertPlayable(probe)`: sem stream de vídeo ou JSON inválido → `InvalidMediaError`; container/codec fora do whitelist (MP4 + `h264`; WebM + `vp8`/`vp9`/`av1`) → `UnsupportedCodecError`; os dois erros carregam o reason code de `### Error Catalog → Processing reason codes` (per `phase-03-videos/TD-09`, `TD-13`)
3. Criar `src/media/thumbnail.service.ts` — `ThumbnailService.extractFrame(source, atSeconds): Promise<Buffer>` via `execFile('ffmpeg', ['-ss', String(atSeconds), '-i', source, '-frames:v', '1', '-vf', "scale='min(1280,iw)':-2", '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'])` com `encoding: 'buffer'`; e `thumbnailTimestamp(durationSeconds)` = 10% da duração, limitado a `[0, duration - 0.1]` (per `phase-03-videos/TD-08`)
4. Criar `src/media/media.module.ts` exportando os dois serviços; criar `src/test/media-fixtures.ts` — gera vídeos de teste em diretório temporário com `ffmpeg -f lavfi -i testsrc=duration=3:size=1920x1080:rate=25` (MP4/H.264 e WebM/VP9) e um arquivo de bytes aleatórios — nenhum binário commitado (per `phase-03-videos/TD-07` refinement)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `parseProbeOutput` | Unit: JSON do ffprobe (inline no teste) mapeado para colunas; arquivo sem áudio → `audioCodec` null; números em string convertidos | `src/media/media-probe.service.spec.ts` |
| `assertPlayable` | Unit: MP4+h264 e WebM+vp9 aceitos; sem stream de vídeo → `INVALID_MEDIA`; MP4+mpeg4 → `UNSUPPORTED_CODEC` | `src/media/media-validation.spec.ts` |
| `thumbnailTimestamp` | Unit: 10% da duração; clamp para vídeos curtíssimos | `src/media/thumbnail.service.spec.ts` |
| `MediaProbeService` / `ThumbnailService` | Integration (ffmpeg real, fixtures `lavfi`): probe do MP4 devolve duração ≈ 3s e 1920×1080; frame extraído começa com bytes JPEG `FF D8` e tem largura ≤ 1280; probe de bytes aleatórios falha | `src/media/media.integration-spec.ts` |

**Dependencies:** SI-03.1 — `ffmpeg`/`ffprobe` instalados na imagem de dev

**Acceptance criteria:**

- O probe de um MP4 H.264 de 3s em 1920×1080 retorna `durationSeconds ≈ 3`, `width = 1920`, `height = 1080`, `videoCodec = "h264"`
- A thumbnail extraída desse vídeo é um JPEG de largura 1280 com proporção preservada (altura 720)
- Um arquivo de bytes aleatórios é classificado como `INVALID_MEDIA`; um MP4 com codec de vídeo fora do whitelist é classificado como `UNSUPPORTED_CODEC`
- Um nome de arquivo/URL contendo `; rm -rf` é tratado como argumento literal (nenhum comando extra é executado)

---

### SI-03.9 — Video worker: entrypoint, processor e ciclo de status

**Description:** Sobe o worker como processo/container separado a partir do mesmo código, consumindo `process-video`: transiciona o status, extrai e grava metadados, gera e envia a thumbnail, e trata falhas transitórias (retry) e permanentes (falha imediata com reason code).

**Technical actions:**

1. Criar `src/video-processing/video-processing.service.ts` — `VideoProcessingService.process(videoId)` (lado worker, `Repository<Video>`): carrega o vídeo; `ready` → no-op; `uploaded`/`processing` → marca `processing`; assina URL `GET` com `audience: 'internal'`; `probe` → `assertPlayable` → grava as colunas de metadados; `thumbnailTimestamp` → `extractFrame` → `putObject('thumbnails/{id}/auto.jpg', jpeg, 'image/jpeg')` → grava `thumbnail_key` e `processing_status = ready` (per `phase-03-videos/TD-04`, `TD-05` refinement, `TD-08`, `TD-12`); `markFailed(videoId, reasonCode)` grava `failed` + `processing_error` mantendo o objeto original (per `phase-03-videos/TD-13`)
2. Criar `src/video-processing/video-processing.processor.ts` — `@Processor(VIDEO_PROCESSING_QUEUE, { concurrency })` estendendo `WorkerHost`; `process(job)` despacha por `job.name`; em `process-video`, `InvalidMediaError`/`UnsupportedCodecError` → `markFailed` com o reason code + `throw new UnrecoverableError(...)`; demais erros são relançados para retry; `@OnWorkerEvent('failed')` chama `markFailed(videoId, 'PROCESSING_ERROR')` só quando `job.attemptsMade >= job.opts.attempts` e o vídeo ainda não está `failed` (per `phase-03-videos/TD-13`; library-refs → `@nestjs/bullmq`, `bullmq`)
3. Criar `src/video-processing/worker.module.ts` — `ConfigModule` (mesmos namespaces + schema Joi), `TypeOrmModule.forRootAsync` (convenção herdada da fase 01) + `forFeature([Video])`, `BullModule.forRootAsync` com `prefix: QUEUE_PREFIX` (mesmo da API) e `maxRetriesPerRequest: null` (perfil worker), `registerQueue(VIDEO_PROCESSING_QUEUE)`, `StorageModule`, `MediaModule`, processor e service — sem módulos HTTP (per `phase-03-videos/TD-07`; library-refs → `bullmq`)
4. Criar `src/worker.ts` — `NestFactory.createApplicationContext(WorkerModule)` + `enableShutdownHooks()`; criar `tsconfig.worker.json` estendendo `tsconfig.build.json` com `outDir: ./dist-worker` e adicionar ao `package.json` `start:worker:dev` (`nest start --watch --entryFile worker -p tsconfig.worker.json`) e `start:worker` (`node dist/worker` sobre o build de produção). Saída separada é obrigatória: `nest-cli.json` tem `deleteOutDir: true`, então dois watchers no mesmo `dist/` apagariam o build um do outro; adicionar `dist-worker/` ao `.gitignore` e aos ignores do ESLint (per `phase-03-videos/TD-07`)
5. Adicionar o serviço `video-worker` a `nestjs-project/compose.yaml` — mesma imagem/`Dockerfile.dev` e bind mount do `nestjs-api`, `command: npm run start:worker:dev`, `depends_on` `db` (healthy), `redis` (healthy) e `minio-init` (completed) (per `phase-03-videos/TD-07` refinement)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingProcessor` | Unit (service mockado): `ready` não reprocessa; erro de mídia → `markFailed` + `UnrecoverableError`; erro transitório relançado; handler `failed` só marca na última tentativa | `src/video-processing/video-processing.processor.spec.ts` |
| `VideoProcessingService` | Integration (DB + MinIO + ffmpeg reais): MP4 `lavfi` enviado ao `object_key` → `ready`, metadados gravados, objeto `thumbnails/{id}/auto.jpg` existe; bytes aleatórios → `failed` + `INVALID_MEDIA` e original preservado; rodar duas vezes é idempotente | `src/video-processing/video-processing.service.integration-spec.ts` |
| `WorkerModule` | Unit: compilation (resolve processor, service, storage e media sem módulos HTTP) | `src/video-processing/worker.module.spec.ts` |

**Dependencies:** SI-03.2 — `StorageService`; SI-03.3 — entidade `Video`; SI-03.4 — constantes e fila; SI-03.8 — `MediaModule`

**Acceptance criteria:**

- Com `docker compose up`, o container `video-worker` fica em execução e conectado à fila `video-processing`; `nestjs-api` não registra nenhum processor
- Com `nestjs-api` em `start:dev` e `video-worker` em `start:worker:dev` simultaneamente, ambos permanecem no ar após recompilações (`dist/main.js` e `dist-worker/worker.js` coexistem)
- Um vídeo `uploaded` com MP4 válido termina `ready` com `duration_seconds`, `width`, `height`, `video_codec`, `container_format` e `bitrate` preenchidos e `thumbnail_key = thumbnails/{id}/auto.jpg` presente no bucket
- Um vídeo `uploaded` cujo objeto não é mídia válida termina `failed` com `processing_error = "INVALID_MEDIA"` após uma única tentativa, e o objeto original continua no bucket
- Uma falha transitória (storage indisponível durante o processamento) é retentada até 3 vezes; esgotadas as tentativas, o vídeo fica `failed` com `processing_error = "PROCESSING_ERROR"`
- Durante o processamento o vídeo é observado como `processing`; reprocessar um vídeo já `ready` não altera nada

---

### SI-03.10 — Job agendado cleanup-stale-uploads: rascunhos abandonados e uploads parados

**Description:** Registra no worker um job agendado a cada 5 min que remove rascunhos `pending_upload` abandonados e reenfileira vídeos presos em `uploaded`, cobrindo a falha de enqueue do dual-write previsto no TD-06.

**Technical actions:**

1. Criar `src/video-processing/stale-uploads.service.ts` — `StaleUploadsService.cleanupStaleDrafts()`: vídeos `pending_upload` com `created_at < now - STALE_UPLOAD_TTL_HOURS` → `abortMultipartUpload` best-effort (erro `NoSuchUpload` ignorado) e remoção da linha (per `phase-03-videos/TD-03`)
2. Implementar `StaleUploadsService.requeueStuckUploads()`: vídeos `uploaded` com `updated_at < now - STALE_UPLOADED_REQUEUE_MINUTES` → `enqueueProcessing(video.id)` (no-op quando ainda existe job com esse `jobId`) (per `phase-03-videos/TD-06`)
3. Registrar o scheduler no bootstrap do worker (`onApplicationBootstrap`): `queue.upsertJobScheduler(CLEANUP_STALE_UPLOADS_JOB, { every: 300000 }, { name: CLEANUP_STALE_UPLOADS_JOB })` — API de Job Schedulers do v6, idempotente por id (library-refs → `bullmq`); importar `VideoProcessingQueueModule` no `WorkerModule` para reutilizar o producer
4. Despachar `cleanup-stale-uploads` no `VideoProcessingProcessor` (por `job.name`) chamando os dois passes em sequência

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StaleUploadsService` | Integration (DB + MinIO + Redis reais): rascunho velho com multipart aberto é removido e o upload abortado; rascunho recente permanece; `uploaded` velho gera job `process-video` com `id = video.id`; `uploaded` recente não gera; rodar duas vezes não falha nem duplica jobs | `src/video-processing/stale-uploads.service.integration-spec.ts` |
| `VideoProcessingProcessor` (dispatch) | Unit: `cleanup-stale-uploads` chama os dois passes; nome desconhecido falha explicitamente | `src/video-processing/video-processing.processor.spec.ts` |

**Dependencies:** SI-03.9 — worker, processor e `WorkerModule`

**Acceptance criteria:**

- Após o boot do worker, `getJobSchedulers()` lista `cleanup-stale-uploads` com intervalo de 300000 ms, e reiniciar o worker não cria um segundo scheduler
- Um vídeo `pending_upload` criado há mais de 24h é removido do banco na próxima execução, e seu multipart deixa de existir no storage
- Um vídeo `pending_upload` criado há 1h não é tocado
- Um vídeo em `uploaded` há mais de 15 min sem job na fila recebe um job `process-video` e termina processado

---

### SI-03.11 — Consulta do vídeo: GET /videos/:publicId

**Route:** GET /videos/:publicId
**Test Specs:** see `nestjs-project/specs/videos-get.plan.md`
**Authorization:** Authenticated + Owner (não-dono → 404)

**Description:** Expõe o vídeo com status de processamento, metadados e thumbnail assinada, para o cliente acompanhar o ciclo rascunho → processando → pronto/erro.

**Technical actions:**

1. Implementar `VideosService.getOwnedVideo(userId, publicId)` reutilizando `findOwnedOrFail` (per `phase-03-videos/TD-11` refinement)
2. Adicionar ao `VideosController` `@Get(':publicId')` → `200` com `toVideoResponse` (thumbnail assinada com `THUMBNAIL_URL_TTL_SECONDS`) e decorators OpenAPI explícitos (per `phase-03-videos/TD-04`, `TD-12`; inherited `openapi-docs-nestjs/TD-01` revision)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `toVideoResponse` | Unit: shape exato de `Video`; `id`, `channel_id`, `object_key`, `upload_id`, `thumbnail_key` ausentes; `thumbnail_url` null sem `thumbnail_key` e, com ele, assinado no host público expirando em `THUMBNAIL_URL_TTL_SECONDS`; `processing_error` exposto apenas quando `failed` | `src/videos/video.presenter.spec.ts` |
| `VideosController` — `GET /videos/:publicId` | E2E: `200` com o shape `Video` para o dono; `404 VIDEO_NOT_FOUND` para outro usuário e para `publicId` malformado (wiring do path param); `401` sem token | `test/videos-get.e2e-spec.ts` |

**Dependencies:** SI-03.6 — `findOwnedOrFail`; SI-03.5 — presenter e controller

**Acceptance criteria:**

- `GET /videos/:publicId` do dono retorna `200` com `processing_status` corrente e os campos de metadados (`null` antes de `ready`)
- Para um vídeo `ready`, `thumbnail_url` é uma URL assinada cujo `GET` retorna `200` com `Content-Type: image/jpeg`
- Para um vídeo `failed`, a resposta traz `processing_error` com o reason code (`INVALID_MEDIA`, `UNSUPPORTED_CODEC` ou `PROCESSING_ERROR`)
- `GET /videos/:publicId` de outro usuário retorna `404` com `error: "VIDEO_NOT_FOUND"`

---

### SI-03.12 — Streaming e download: URLs pré-assinadas de playback e download

**Route:** GET /videos/:publicId/playback, GET /videos/:publicId/download
**Test Specs:** see `nestjs-project/specs/videos-playback-download.plan.md`
**Authorization:** Authenticated + Owner (não-dono → 404; Fases 04/05 ampliam o acesso nos mesmos endpoints)

**Description:** Emite URLs pré-assinadas para reproduzir o vídeo via streaming (o storage responde `Range` com `206`) e para baixá-lo como anexo com nome amigável — nenhum byte de vídeo passa pela API.

**Technical actions:**

1. Criar `src/videos/content-disposition.util.ts` — `buildAttachmentDisposition(title, ext)`: `attachment; filename="{fallback ASCII sem aspas/controle}.{ext}"; filename*=UTF-8''{percent-encoded}.{ext}` (per `phase-03-videos/TD-11`, `TD-03` revision)
2. Implementar `VideosService.getPlaybackUrl(userId, publicId)` — `findOwnedOrFail`; `processing_status ≠ ready` → `VideoNotReadyException`; `signGetObjectUrl(object_key, { audience: 'public', ttlSeconds: PLAYBACK_URL_TTL_SECONDS })` → `{ url, expires_at }` (per `phase-03-videos/TD-05`, `TD-11`)
3. Implementar `VideosService.getDownloadUrl(userId, publicId)` — mesmas guardas; assina com `DOWNLOAD_URL_TTL_SECONDS` e `contentDisposition = buildAttachmentDisposition(video.title, ext de original_filename)` (per `phase-03-videos/TD-11`; library-refs → `@aws-sdk/s3-request-presigner`)
4. Adicionar ao `VideosController` `@Get(':publicId/playback')` e `@Get(':publicId/download')` → `200` com decorators OpenAPI explícitos (inherited `openapi-docs-nestjs/TD-01` revision)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `buildAttachmentDisposition` | Unit: título com acentos/aspas/emoji gera fallback ASCII seguro e `filename*` correto; extensão preservada | `src/videos/content-disposition.util.spec.ts` |
| `VideosService.getPlaybackUrl` / `getDownloadUrl` | Unit: estados ≠ `ready` → `VideoNotReadyException`; TTLs corretos por tipo de URL | `src/videos/videos.service.spec.ts` |
| `VideosService` (streaming/download) | Integration (DB + MinIO reais, objeto `ready` gerado por fixture `lavfi`): URL de playback com `Range: bytes=0-1023` → `206` + `Content-Range`; URL de download → `200` com `Content-Disposition: attachment` contendo o título | `src/videos/videos.service.integration-spec.ts` |
| `VideosController` — `GET …/playback`, `GET …/download` + fluxo completo | E2E: `409 VIDEO_NOT_READY` antes de `ready`; `404` para outro usuário; `401` sem token. **Fluxo completo:** `POST /videos` (MP4 `lavfi` de ~6 MiB → 2 partes de 5 MiB) → `PUT` das partes nas URLs assinadas → `POST …/upload/complete` → processa chamando `VideoProcessingService.process(videoId)` no próprio teste (instanciado via `Test.createTestingModule({ imports: [WorkerModule] })` — não depende do container `video-worker`, que usa outro `QUEUE_PREFIX`) → `GET …/playback` + `GET` da URL com `Range: bytes=0-1023` → `206` → `GET …/download` + `GET` da URL → `200` com `Content-Disposition: attachment` | `test/videos-playback-download.e2e-spec.ts` |

**Dependencies:** SI-03.6 — `findOwnedOrFail`; SI-03.7 — complete usado no E2E de fluxo completo; SI-03.9 — vídeos chegam a `ready` (`WorkerModule` usado no E2E)

**Acceptance criteria:**

- `GET /videos/:publicId/playback` de um vídeo `ready` retorna `200` com `url` e `expires_at` ≈ agora + 6h
- Um `GET` nessa `url` com `Range: bytes=0-1023` retorna `206 Partial Content` com `Content-Range: bytes 0-1023/{size_bytes}`
- `GET /videos/:publicId/download` retorna `200` com `expires_at` ≈ agora + 15 min; a `url` responde com `Content-Disposition: attachment` e nome derivado do título com a extensão original
- `GET …/playback` ou `…/download` de um vídeo `processing` retorna `409` com `error: "VIDEO_NOT_READY"`
- `GET …/playback` de outro usuário retorna `404` com `error: "VIDEO_NOT_FOUND"`

---

### SI-03.13 — Documentação: openapi.json exportado e CLAUDE.md do backend

**Description:** Mantém os artefatos de documentação em dia com a fase — o `openapi.json` versionado passa a conter os endpoints de vídeo, os `CLAUDE.md` (raiz e `nestjs-project`) documentam vídeos, fila, storage e worker, e o diagrama de arquitetura deixa de ter a fila como TBD.

**Technical actions:**

1. Rodar `npm run openapi:export` e commitar o `nestjs-project/openapi.json` regenerado com os 8 endpoints de `### API Contracts` (inherited `openapi-docs-nestjs/TD-02`)
2. Estender `test/swagger.e2e-spec.ts` para afirmar que o documento gerado contém os paths `/videos`, `/videos/{publicId}/upload/part-urls`, `/videos/{publicId}/upload/parts`, `/videos/{publicId}/upload/complete`, `/videos/{publicId}/upload`, `/videos/{publicId}`, `/videos/{publicId}/playback`, `/videos/{publicId}/download`, com respostas de erro referenciando o envelope de erro
3. Atualizar `nestjs-project/CLAUDE.md` — serviços `minio`, `minio-init`, `redis`, `video-worker` com portas; verificações de prontidão (`docker compose exec redis redis-cli ping`, bucket via `mc ls`, `ffprobe -version`); comandos `start:worker`/`start:worker:dev`; nota de que `STORAGE_PUBLIC_ENDPOINT` é a única exceção à regra de service-name; `QUEUE_PREFIX` de teste e o `setup-env.ts` do Jest (per `phase-03-videos/TD-05` refinement, `TD-07`)
4. Atualizar o `CLAUDE.md` da raiz — Message Queue deixa de ser TBD → BullMQ + Redis; Object Storage → MinIO (S3-compatível, acessado só pela API S3); container `video-worker` (mesmo código do `nestjs-project`, FFmpeg); seção de vídeos com o fluxo upload multipart pré-assinado → processamento → streaming/download (per `phase-03-videos/TD-01`, `TD-02`, `TD-07`, `TD-11`)
5. Atualizar `docs/diagrams/software-arch.mermaid` — `ContainerQueue(queue, "Message Queue", "TBD", …)` passa a `"BullMQ + Redis"`; o container de storage passa a indicar MinIO (S3-compatível) (per `phase-03-videos/TD-01`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Documento OpenAPI | E2E: paths de vídeo presentes com respostas de erro documentadas | `test/swagger.e2e-spec.ts` |

**Dependencies:** SI-03.5, SI-03.6, SI-03.7, SI-03.11, SI-03.12 — todos os endpoints existem; SI-03.9 — worker documentado

**Acceptance criteria:**

- `nestjs-project/openapi.json` commitado contém os 8 endpoints de vídeo, cada um com `bearer` security e respostas de erro documentadas
- Rodar `npm run openapi:export` de novo não produz diff no `openapi.json`
- `nestjs-project/CLAUDE.md` lista `minio`, `redis` e `video-worker` com seus comandos de verificação de prontidão
- O `CLAUDE.md` da raiz e `docs/diagrams/software-arch.mermaid` não mencionam mais a fila como `TBD` e identificam BullMQ + Redis e MinIO

---

## Technical Specifications

### Data Model

#### Video

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, generated | Internal id; used in storage keys (per `phase-03-videos/TD-04`). Never exposed in the API. |
| public_id | varchar(11) | unique, not null | Random 11-char base64url (`crypto.randomBytes(8).toString('base64url')`); retry insert on unique violation (per `phase-03-videos/TD-10`) |
| channel_id | uuid | FK → `channels.id`, not null, `ON DELETE CASCADE` | Owner channel of the authenticated uploader |
| title | varchar(100) | not null | Optional `title` at initiate; when absent, the original filename without its extension, sanitized and truncated to 100 chars (per `phase-03-videos/TD-03` revision 2026-10-08) |
| original_filename | varchar(255) | not null | As declared at initiate; used for title fallback and download extension |
| content_type | varchar(100) | not null | Declared MIME; must be in the TD-09 whitelist |
| size_bytes | bigint | not null | Declared size at initiate; overwritten with `HeadObject.ContentLength` at complete. Map with a numeric transformer (TypeORM returns `bigint` as string; 10 GiB < 2^53). |
| object_key | varchar(255) | not null | `videos/{id}/original.{ext}` (per `phase-03-videos/TD-04`) |
| upload_id | varchar(255) | nullable | S3 multipart `UploadId`; set at initiate, cleared after complete or abort (per `phase-03-videos/TD-03`) |
| thumbnail_key | varchar(255) | nullable | `thumbnails/{id}/auto.jpg`, set by the worker on success (per `phase-03-videos/TD-04`, `TD-08`) |
| processing_status | enum `video_processing_status` (`pending_upload`, `uploaded`, `processing`, `ready`, `failed`) | not null, default `pending_upload` | Technical lifecycle (per `phase-03-videos/TD-12`) |
| publication_status | enum `video_publication_status` (`draft`) | not null, default `draft` | Editorial lifecycle; Phase 04 extends the enum (per `phase-03-videos/TD-12`) |
| processing_error | varchar(50) | nullable | Reason code when `processing_status = failed`: `INVALID_MEDIA`, `UNSUPPORTED_CODEC`, `PROCESSING_ERROR` (per `phase-03-videos/TD-13`) |
| duration_seconds | double precision | nullable | From ffprobe `format.duration` (per `phase-03-videos/TD-08` revision 2026-10-08) |
| width | integer | nullable | First video stream |
| height | integer | nullable | First video stream |
| video_codec | varchar(50) | nullable | First video stream `codec_name` |
| audio_codec | varchar(50) | nullable | First audio stream `codec_name`; stays null when the file has no audio |
| container_format | varchar(100) | nullable | ffprobe `format.format_name` |
| bitrate | bigint | nullable | ffprobe `format.bit_rate` (bits/s); numeric transformer |
| created_at | timestamp | not null, auto-generated | `@CreateDateColumn` |
| updated_at | timestamp | not null, auto-generated | `@UpdateDateColumn` |

**Relations:** Video → Channel (many-to-one, `channel_id`). The relation lives on `Video` only; `Channel` gains no new column.
**Indexes:** `(public_id)` — unique; `(channel_id)`; `(processing_status, created_at)` — used by the `cleanup-stale-uploads` scans (stale `pending_upload` by `created_at`; stuck `uploaded` by `updated_at`, filtered on the same leading `processing_status` column) (per `phase-03-videos/TD-03`, `TD-06`).
**Metadata columns:** all ffprobe-derived columns (`duration_seconds` … `bitrate`) are null until `processing_status = ready`.

#### Storage layout (object storage — not a DB table)

| Item | Value | Source |
|------|-------|--------|
| Bucket | single private bucket, name from `STORAGE_BUCKET` (default `streamtube-media`) | `phase-03-videos/TD-04` |
| Original video key | `videos/{video.id}/original.{ext}` (`ext` from `original_filename`, lowercased) | `phase-03-videos/TD-04` |
| Auto thumbnail key | `thumbnails/{video.id}/auto.jpg` (`custom.jpg` reserved for Phase 04) | `phase-03-videos/TD-04` |
| Access | no anonymous read; every read is a presigned URL issued by the API | `phase-03-videos/TD-04`, `TD-11` |
| Bucket bootstrap | idempotent, one-shot `mc` init service in Compose (creates the bucket if absent) | `phase-03-videos/TD-04` |
| CORS | browser part `PUT`s need the storage to allow the frontend origin and expose the `ETag` response header (configured at the storage-server level; verify the mechanism for the pinned MinIO image at implementation) | `phase-03-videos/TD-02`; library-refs → `@aws-sdk/s3-request-presigner` |

### API Contracts

All endpoints below require `Authorization: Bearer <access_token>` (global JWT guard from `phase-02-auth/TD-02`) and are owner-scoped: a `public_id` that does not exist **or** belongs to another user's channel returns `404 VIDEO_NOT_FOUND`, so existence is never revealed (per `phase-03-videos/TD-10`, `TD-11`). Errors use the inherited `{ statusCode, error, message }` envelope (`phase-02-auth/TD-07`).

**Shared response shape — `Video`** (returned by `POST /videos`, `POST …/upload/complete`, `GET /videos/:publicId`):
- public_id: string (11 chars)
- title: string
- original_filename: string
- content_type: string
- size_bytes: number
- processing_status: `pending_upload` | `uploaded` | `processing` | `ready` | `failed`
- publication_status: `draft`
- processing_error: string | null
- duration_seconds: number | null
- width: number | null
- height: number | null
- video_codec: string | null
- audio_codec: string | null
- container_format: string | null
- bitrate: number | null
- thumbnail_url: string | null — presigned GET (public client) for `thumbnail_key`, TTL `THUMBNAIL_URL_TTL_SECONDS` (default 3600); null until ready
- created_at: string (ISO-8601)
- updated_at: string (ISO-8601)

The internal `id`, `channel_id`, `object_key`, `upload_id` and `thumbnail_key` are never serialized.

---

#### POST /videos (SI-03.5)

Initiates an upload: creates the draft `Video` (`processing_status = pending_upload`, `publication_status = draft`) and the S3 multipart upload in one call (per `phase-03-videos/TD-02`, `TD-03`, `TD-12`).

**Request headers:**
- Content-Type: application/json

**Request body:**
- filename: string, required — 1..255 chars; must have an extension
- size_bytes: integer, required — 1..10737418240 (10 GiB)
- content_type: string, required — `video/mp4` | `video/webm` (per `phase-03-videos/TD-09`)
- title: string, optional — trimmed, 1..100 chars; when absent the filename without extension is used (per `phase-03-videos/TD-03` revision)

**Response 201:**
- video: `Video`
- upload: object
  - part_size: number — `STORAGE_PART_SIZE_BYTES` (default 67108864 = 64 MiB; Joi minimum 5242880 = 5 MiB, the S3 non-last-part minimum) (per `phase-03-videos/TD-03`). Tests set 5 MiB to exercise real multi-part uploads with small fixtures.
  - part_count: number — `ceil(size_bytes / part_size)`

**Error responses:**
- 415 UNSUPPORTED_MEDIA_TYPE: when `content_type` is not in the whitelist
- 400 validation error: when the body fails schema validation (missing fields, `size_bytes` out of range, title too long)
- 401 (framework `UnauthorizedException` from the global `JwtAuthGuard`, default Nest body — no domain code): when the access token is missing or invalid; applies to every endpoint in this section

---

#### POST /videos/:publicId/upload/part-urls (SI-03.6)

Signs presigned `UploadPart` URLs for a batch of part numbers with the **public** client (per `phase-03-videos/TD-02`, `TD-05`).

**Request headers:**
- Content-Type: application/json

**Request body:**
- part_numbers: integer[], required — 1..100 distinct items, each within `1..part_count`

**Response 200:**
- parts: `{ part_number: number, url: string }[]`
- expires_at: string (ISO-8601) — now + `STORAGE_PART_URL_TTL_SECONDS` (default 3600, per `phase-03-videos/TD-03`)

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown `public_id` or not owned by the caller
- 409 INVALID_UPLOAD_STATE: when `processing_status != pending_upload`
- 422 INVALID_UPLOAD_PARTS: a part number outside `1..part_count` (checked in the service — needs the stored `size_bytes`)
- 400 validation error: empty/oversized array, duplicates, or non-integer / < 1 values

---

#### GET /videos/:publicId/upload/parts (SI-03.6)

Resume support: returns the parts already stored, read from S3 `ListParts` (paginated until `IsTruncated = false`) — storage is the source of truth (per `phase-03-videos/TD-03`).

**Response 200:**
- part_size: number
- part_count: number
- parts: `{ part_number: number, etag: string, size: number }[]` — ascending by `part_number`

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown `public_id` or not owned by the caller
- 409 INVALID_UPLOAD_STATE: when `processing_status != pending_upload`

---

#### POST /videos/:publicId/upload/complete (SI-03.7)

Completes the multipart upload, validates the stored object, moves the video to `uploaded` and enqueues processing with `jobId = video.id` (per `phase-03-videos/TD-03`, `TD-06`). Idempotent: when the video is already `uploaded`, it re-enqueues (deduplicated by `jobId`) and returns 200 without calling storage again.

**Request headers:**
- Content-Type: application/json

**Request body:**
- parts: `{ part_number: integer, etag: string }[]`, required — 1..10000 items, distinct `part_number`; sent to S3 sorted ascending

**Response 200:**
- `Video` with `processing_status: uploaded`

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown `public_id` or not owned by the caller
- 409 INVALID_UPLOAD_STATE: when `processing_status` is `processing`, `ready` or `failed`
- 422 INVALID_UPLOAD_PARTS: S3 rejects the part list (missing part, ETag mismatch, part too small)
- 422 UPLOAD_SIZE_EXCEEDED: `HeadObject.ContentLength` > 10 GiB (object is deleted; video row deleted)
- 400 validation error: body fails schema validation

---

#### DELETE /videos/:publicId/upload (SI-03.7)

Aborts an in-progress upload: `AbortMultipartUpload`, then deletes the draft row (it never had content).

**Response 204:** No content.

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown `public_id` or not owned by the caller
- 409 INVALID_UPLOAD_STATE: when `processing_status != pending_upload`

---

#### GET /videos/:publicId (SI-03.11)

Returns the video with its current processing status and metadata (the client polls this while processing).

**Response 200:**
- `Video`

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown `public_id` or not owned by the caller

---

#### GET /videos/:publicId/playback (SI-03.12)

Issues a long-lived presigned GET URL (public client) for the original object; the storage serves `Range` requests with `206 Partial Content` (per `phase-03-videos/TD-11`).

**Response 200:**
- url: string
- expires_at: string (ISO-8601) — now + `PLAYBACK_URL_TTL_SECONDS` (default 21600 = 6h)

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown `public_id` or not owned by the caller
- 409 VIDEO_NOT_READY: when `processing_status != ready`

---

#### GET /videos/:publicId/download (SI-03.12)

Issues a short-lived presigned GET URL with `ResponseContentDisposition: attachment; filename="{ascii-safe title}.{ext}"; filename*=UTF-8''{percent-encoded title}.{ext}` (per `phase-03-videos/TD-11`, `TD-03` revision).

**Response 200:**
- url: string
- expires_at: string (ISO-8601) — now + `DOWNLOAD_URL_TTL_SECONDS` (default 900 = 15min)

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown `public_id` or not owned by the caller
- 409 VIDEO_NOT_READY: when `processing_status != ready`

---

#### Validation Rules — videos

- `filename`: required, string, 1..255 chars, must contain an extension
- `size_bytes`: required, integer, 1..10737418240
- `content_type`: required, string (whitelist enforced as a domain rule → 415, not as DTO validation)
- `title`: optional, string, trimmed, 1..100 chars
- `part_numbers`: required, array of integers ≥ 1, 1..100 items, unique (upper bound `part_count` checked in the service → 422 INVALID_UPLOAD_PARTS)
- `parts`: required, array 1..10000 of `{ part_number: integer ≥ 1, etag: non-empty string }`, unique `part_number`
- `publicId` path param: 11 chars, `[A-Za-z0-9_-]`; anything else → 404 VIDEO_NOT_FOUND

### Authorization Matrix

| Endpoint | Public | Authenticated | Owner only | Notes |
|----------|--------|---------------|------------|-------|
| POST /videos | | ✓ | | Video is created in the caller's channel |
| POST /videos/:publicId/upload/part-urls | | ✓ | ✓ | Non-owner → 404 |
| GET /videos/:publicId/upload/parts | | ✓ | ✓ | Non-owner → 404 |
| POST /videos/:publicId/upload/complete | | ✓ | ✓ | Non-owner → 404 |
| DELETE /videos/:publicId/upload | | ✓ | ✓ | Non-owner → 404 |
| GET /videos/:publicId | | ✓ | ✓ | Non-owner → 404 |
| GET /videos/:publicId/playback | | ✓ | ✓ | Owner-only in Phase 03; Phases 04/05 widen access on the same endpoint (per `phase-03-videos/TD-11` refinement) |
| GET /videos/:publicId/download | | ✓ | ✓ | Same as playback |

### Error Catalog

Error response format is inherited from Phase 02 (`{ statusCode, error, message }`, `error` = domain code). New codes for this phase:

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| VIDEO_NOT_FOUND | 404 | Video not found | Any `/videos/:publicId…` endpoint with an unknown `public_id` or one owned by another user's channel |
| UNSUPPORTED_MEDIA_TYPE | 415 | Unsupported video format | POST /videos with `content_type` outside `video/mp4`, `video/webm` (per `phase-03-videos/TD-09`) |
| INVALID_UPLOAD_STATE | 409 | Upload is not in a valid state for this operation | part-urls / parts / abort when not `pending_upload`; complete when `processing`, `ready` or `failed` |
| INVALID_UPLOAD_PARTS | 422 | Uploaded parts are invalid or incomplete | POST …/upload/part-urls with a part number > `part_count`; POST …/upload/complete when S3 rejects `CompleteMultipartUpload` (`InvalidPart`, `InvalidPartOrder`, `EntityTooSmall`) |
| UPLOAD_SIZE_EXCEEDED | 422 | Uploaded file exceeds the maximum size | POST …/upload/complete when `HeadObject.ContentLength` > 10 GiB (per `phase-03-videos/TD-03`) |
| VIDEO_NOT_READY | 409 | Video is not ready yet | GET …/playback or …/download when `processing_status != ready` (per `phase-03-videos/TD-11`) |

**Processing reason codes** (persisted in `videos.processing_error`, exposed in `Video.processing_error`; not HTTP errors — per `phase-03-videos/TD-13`):

| Code | Retry? | Trigger |
|------|--------|---------|
| INVALID_MEDIA | no (`UnrecoverableError`) | ffprobe cannot parse the file, or it has no video stream |
| UNSUPPORTED_CODEC | no (`UnrecoverableError`) | Container/video codec outside the browser-playable whitelist: MP4 (`format_name` contains `mp4`) with `h264` video, or WebM (`format_name` contains `webm`) with `vp8` / `vp9` / `av1` video (per `phase-03-videos/TD-09` — "MP4 (H.264/AAC) and WebM (VP8/VP9/AV1/Opus)") |
| PROCESSING_ERROR | yes (attempts exhausted) | Transient failure (storage, DB, ffmpeg crash) that still fails after the last attempt |

### Events/Messages

#### Queue `video-processing` — job `process-video`

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** `VideosService.completeUpload` in the API (per `phase-03-videos/TD-06`) — `queue.add('process-video', { videoId }, { jobId: videoId })`
**Consumer:** `VideoProcessingProcessor` in the `video-worker` process (per `phase-03-videos/TD-07`), concurrency from `VIDEO_WORKER_CONCURRENCY` (default 1)
**Trigger:** successful `POST /videos/:publicId/upload/complete`; re-enqueue on a retried complete is a no-op thanks to `jobId`. Also re-enqueued by `cleanup-stale-uploads` for videos stuck in `uploaded` (covers the enqueue-after-status-update dual-write failure from `phase-03-videos/TD-06`).
**Delivery semantics:** at-least-once (per `phase-03-videos/TD-01`); the processor is idempotent — it re-reads the row, skips if already `ready`, and overwrites metadata/thumbnail on re-run
**Job options:** `attempts: 3`, `backoff: { type: 'exponential', delay: 5000 }`, `removeOnComplete: { age: 86400 }`, `removeOnFail: { age: 604800 }` (per `phase-03-videos/TD-13`; retention per library-refs → `bullmq`)
**Processor steps:** `uploaded → processing` · sign source URL with the **internal** client (per `phase-03-videos/TD-05` refinement) · ffprobe (JSON) → validate whitelist → persist metadata · ffmpeg frame at ~10% of duration (clamped) → JPEG max width 1280 → `PutObject` `thumbnails/{id}/auto.jpg` · `processing → ready` (per `phase-03-videos/TD-08`, `TD-09`, `TD-12`)
**Failure:** invalid/unsupported media → `UnrecoverableError` → `failed` + reason code; otherwise rethrow for retry; `@OnWorkerEvent('failed')` sets `failed` + `PROCESSING_ERROR` only when `attemptsMade >= attempts`. The original object is kept (per `phase-03-videos/TD-13`).

#### Queue `video-processing` — job `cleanup-stale-uploads` (scheduled)

**Payload:**

```json
{}
```

**Producer:** job scheduler registered by the worker on boot via `queue.upsertJobScheduler('cleanup-stale-uploads', { every: 300000 }, { name: 'cleanup-stale-uploads' })` — every 5 min, so the `uploaded` requeue honors its minutes-scale threshold; v6 API, repeatable jobs were removed (per `phase-03-videos/TD-03`; library-refs → `bullmq`)
**Consumer:** `VideoProcessingProcessor` (dispatch on `job.name`)
**Trigger:** every 5 min; two passes:
1. **Stale drafts** — deletes videos with `processing_status = pending_upload` and `created_at` older than `STALE_UPLOAD_TTL_HOURS` (default 24, matching the storage stale-upload expiry), calling `AbortMultipartUpload` best-effort first (per `phase-03-videos/TD-03`).
2. **Stuck uploads** — re-enqueues `process-video` (`jobId = video.id`) for videos with `processing_status = uploaded` and `updated_at` older than `STALE_UPLOADED_REQUEUE_MINUTES` (default 15). When a job for that id is still waiting/active, the `add` is a no-op (deduplicated by `jobId`); a lost enqueue gets a fresh job (per `phase-03-videos/TD-06`).
**Delivery semantics:** at-least-once; idempotent (re-running finds nothing left to delete)

---

## Dependency Map

```
SI-03.1 (root — deps, config, Docker: minio, redis, ffmpeg)
├── SI-03.2 — StorageModule (needs storage config + minio)
├── SI-03.3 — Video entity + migration
├── SI-03.4 — BullMQ connection + producer (needs queue config + redis)
└── SI-03.8 — MediaModule (needs ffmpeg/ffprobe in the image)

SI-03.2 + SI-03.3 + SI-03.4
└── SI-03.5 — POST /videos (draft + multipart)
    └── SI-03.6 — part URLs + list parts (ownership/state helpers)
        ├── SI-03.7 — complete + abort (+ SI-03.4 producer)
        └── SI-03.11 — GET /videos/:publicId (+ SI-03.5 presenter)

SI-03.2 + SI-03.3 + SI-03.4 + SI-03.8
└── SI-03.9 — video worker (entrypoint, processor, status lifecycle)
    └── SI-03.10 — cleanup-stale-uploads scheduler

SI-03.6 + SI-03.9
└── SI-03.12 — playback + download URLs

SI-03.5 + SI-03.6 + SI-03.7 + SI-03.9 + SI-03.11 + SI-03.12
└── SI-03.13 — openapi.json + backend CLAUDE.md
```

Linearized implementation order: SI-03.1 → SI-03.2, SI-03.3, SI-03.4, SI-03.8 (parallel) → SI-03.5 → SI-03.6 → SI-03.7, SI-03.11 (parallel) → SI-03.9 → SI-03.10, SI-03.12 (parallel) → SI-03.13

---

## Deliverables

- [ ] SI-03.1 — Infra: dependências, namespaces de config e serviços Docker
- [ ] SI-03.2 — StorageModule: clientes S3 interno/público, multipart e pré-assinatura
- [ ] SI-03.3 — Entidade Video, migration e gerador de public_id
- [ ] SI-03.4 — Fila de processamento: conexão BullMQ e producer idempotente
- [ ] SI-03.5 — Início do upload: POST /videos com pré-cadastro do rascunho
- [ ] SI-03.6 — Retomada do upload: assinar URLs de partes e listar partes enviadas
- [ ] SI-03.7 — Conclusão e cancelamento do upload
- [ ] SI-03.8 — MediaModule: ffprobe, validação de formato e extração de thumbnail
- [ ] SI-03.9 — Video worker: entrypoint, processor e ciclo de status
- [ ] SI-03.10 — Job agendado cleanup-stale-uploads: rascunhos abandonados e uploads parados
- [ ] SI-03.11 — Consulta do vídeo: GET /videos/:publicId
- [ ] SI-03.12 — Streaming e download: URLs pré-assinadas de playback e download
- [ ] SI-03.13 — Documentação: openapi.json exportado e CLAUDE.md do backend

**Full test suites:**

- [ ] Backend tests pass (`docker compose exec nestjs-api npm test`)
- [ ] E2E tests pass (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation checks pass (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`docker compose exec nestjs-api npm run lint`)
- [ ] Project builds successfully (`docker compose exec nestjs-api npm run build`)
