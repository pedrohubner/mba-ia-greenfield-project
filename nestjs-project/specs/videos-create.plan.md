---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.5
target_file: test/videos-create.e2e-spec.ts
---

# POST /videos — Test Plan

## Application Overview

`POST /videos` inicia o upload de um vídeo: cria o rascunho (`processing_status = pending_upload`, `publication_status = draft`) já com `public_id` de 11 caracteres no canal do usuário autenticado, abre o multipart upload no storage e devolve `{ video, upload: { part_size, part_count } }`. Os bytes nunca passam pela API. Formatos fora de `video/mp4`/`video/webm` são recusados com `415`; violações de schema caem no `ValidationPipe` global (`400 VALIDATION_ERROR`); sem token o `JwtAuthGuard` global responde `401`. A resposta nunca expõe campos internos (`id`, `channel_id`, `object_key`, `upload_id`, `thumbnail_key`).

## Test Scenarios

### 1. Iniciar upload com pré-cadastro do rascunho

**Setup:** `beforeEach` limpa `videos` (e dependências) no DB de teste; bootstrap de `AppModule` via `Test.createTestingModule(...).compile()` aplicando os mesmos pipes/filters globais do `main.ts`; usuário confirmado criado no DB e `access_token` obtido via `POST /auth/login`. Ambiente de teste do `test/setup-env.ts` (`STORAGE_PART_SIZE_BYTES=5242880`, `QUEUE_PREFIX=bull-test`).

#### 1.1. cria-rascunho-com-titulo-derivado-do-arquivo

**Covers AC:** #1, #6
**Source:** auto
**Last sync:** 2026-10-09T13:41:14Z

**Steps:**
  1. POST /videos com `Authorization: Bearer <token>` e body `{ filename: "aula.mp4", size_bytes: 10485760, content_type: "video/mp4" }`
    - expect: status `201`
    - expect: `video.processing_status` = `"pending_upload"` e `video.publication_status` = `"draft"`
    - expect: `video.title` = `"aula"` e `video.public_id` casa `^[A-Za-z0-9_-]{11}$`
    - expect: `upload.part_size` = `5242880` e `upload.part_count` = `ceil(10485760 / 5242880)` = `2`
    - expect: o corpo não contém as chaves `id`, `channel_id`, `object_key`, `upload_id` nem `thumbnail_key` (nem em `video`)
  2. Consultar a tabela `videos`
    - expect: existe exatamente 1 linha com esse `public_id`, `channel_id` do usuário autenticado e `upload_id` preenchido

#### 1.2. titulo-informado-e-aparado

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-09T13:41:14Z

**Steps:**
  1. POST /videos com body `{ filename: "aula.mp4", size_bytes: 10485760, content_type: "video/mp4", title: "  Minha aula  " }`
    - expect: status `201`
    - expect: `video.title` = `"Minha aula"`

### 2. Recusas de entrada

**Setup:** mesmo do grupo 1.

#### 2.1. formato-nao-suportado-415

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-09T13:41:14Z

**Steps:**
  1. POST /videos com body `{ filename: "aula.mkv", size_bytes: 10485760, content_type: "video/x-matroska" }`
    - expect: status `415` com corpo `{ statusCode: 415, error: "UNSUPPORTED_MEDIA_TYPE", message: <string> }`
  2. Consultar a tabela `videos`
    - expect: nenhuma linha foi criada

#### 2.2. validation-pipe-tamanho-acima-de-10-gib

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-09T13:41:14Z

**Steps:**
  1. POST /videos com body `{ filename: "grande.mp4", size_bytes: 10737418241, content_type: "video/mp4" }`
    - expect: status `400` com `error` = `"VALIDATION_ERROR"` e `message` como array de erros de campo citando `size_bytes`

#### 2.3. sem-token-401

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-09T13:41:14Z

**Steps:**
  1. POST /videos sem header `Authorization` e com body válido
    - expect: status `401`
    - expect: nenhuma linha criada em `videos`
