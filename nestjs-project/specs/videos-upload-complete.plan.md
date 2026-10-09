---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.7
target_file: test/videos-upload-complete.e2e-spec.ts
---

# POST /videos/:publicId/upload/complete + DELETE /videos/:publicId/upload — Test Plan

## Application Overview

`POST …/upload/complete` conclui o multipart (partes ordenadas), valida o objeto com `HeadObject`, grava o tamanho real, move o vídeo para `uploaded` e enfileira `process-video` com `jobId` = id interno do vídeo — repetir o complete é idempotente (reenfileira deduplicado, sem tocar o storage). Partes inválidas → `422 INVALID_UPLOAD_PARTS`; estados `processing`/`ready`/`failed` → `409 INVALID_UPLOAD_STATE`. `DELETE …/upload` aborta o multipart e remove o rascunho (`204`), apenas em `pending_upload`.

## Test Scenarios

### 1. Concluir upload e disparar processamento

**Setup:** `beforeEach` limpa `videos` no DB de teste e esvazia a fila `video-processing` sob o prefixo `bull-test`; bootstrap de `AppModule` com pipes/filters globais do `main.ts`; usuário confirmado com `access_token`; rascunho via `POST /videos` com `size_bytes = 2 × 5242880`, URLs assinadas e `PUT` das 2 partes (ETags guardados). Ambiente do `test/setup-env.ts`. O container `video-worker` (prefixo `bull`) não consome os jobs do teste.

#### 1.1. complete-move-para-uploaded

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-10-09T13:41:14Z

**Steps:**
  1. POST /videos/:publicId/upload/complete como dono com `{ parts: [{ part_number: 2, etag }, { part_number: 1, etag }] }` (fora de ordem de propósito)
    - expect: status `200` com `processing_status` = `"uploaded"`
    - expect: `size_bytes` = `10485760` (soma real das partes)
  2. Consultar a linha em `videos`
    - expect: `upload_id` é `null`

#### 1.2. job-unico-e-complete-idempotente

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-09T13:41:14Z

**Steps:**
  1. Após o complete do 1.1, inspecionar a fila `video-processing` (prefixo `bull-test`)
    - expect: existe exatamente 1 job `process-video` com `id` igual ao id interno do vídeo e `data.videoId` igual a ele
  2. Repetir POST …/upload/complete com o mesmo body
    - expect: status `200` com `processing_status` = `"uploaded"`
    - expect: a fila continua com exatamente 1 job para esse vídeo

### 2. Recusas do complete

**Setup:** mesmo do grupo 1.

#### 2.1. partes-invalidas-422

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-09T13:41:14Z

**Steps:**
  1. POST …/upload/complete referenciando uma parte nunca enviada (`{ parts: [{ part_number: 1, etag }, { part_number: 2, etag }, { part_number: 3, etag: "\"0123456789abcdef0123456789abcdef\"" }] }`)
    - expect: status `422` com `error` = `"INVALID_UPLOAD_PARTS"`
  2. POST …/upload/complete com as 2 partes, mas `etag` da parte 1 trocado por `"\"deadbeef\""`
    - expect: status `422` com `error` = `"INVALID_UPLOAD_PARTS"`
  3. GET /videos/:publicId
    - expect: `processing_status` continua `"pending_upload"`

#### 2.2. complete-de-video-ready-409

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-09T13:41:14Z

**Steps:**
  1. Colocar o vídeo em `processing_status = ready` direto no DB de teste
  2. POST …/upload/complete com as partes
    - expect: status `409` com `error` = `"INVALID_UPLOAD_STATE"`

#### 2.3. validation-pipe-parts-ausente-e-sem-token

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-09T13:41:14Z

**Steps:**
  1. POST …/upload/complete como dono com body `{}`
    - expect: status `400` com `error` = `"VALIDATION_ERROR"`
  2. POST …/upload/complete sem `Authorization`
    - expect: status `401`

### 3. Cancelar upload

**Setup:** mesmo do grupo 1, sem o `PUT` das partes no caso 3.1.

#### 3.1. abort-remove-rascunho

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-09T13:41:14Z

**Steps:**
  1. DELETE /videos/:publicId/upload como dono
    - expect: status `204` sem corpo
  2. GET /videos/:publicId como dono
    - expect: status `404` com `error` = `"VIDEO_NOT_FOUND"`

#### 3.2. abort-de-video-uploaded-409-e-sem-token

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-10-09T13:41:14Z

**Steps:**
  1. Concluir o upload (complete `200`, vídeo `uploaded`)
  2. DELETE …/upload como dono
    - expect: status `409` com `error` = `"INVALID_UPLOAD_STATE"`
  3. DELETE …/upload sem `Authorization`
    - expect: status `401`
