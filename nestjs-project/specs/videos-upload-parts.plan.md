---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.6
target_file: test/videos-upload-parts.e2e-spec.ts
---

# POST /videos/:publicId/upload/part-urls + GET /videos/:publicId/upload/parts — Test Plan

## Application Overview

Estes dois endpoints sustentam a retomada do upload. `POST …/upload/part-urls` assina URLs `UploadPart` (cliente público, TTL 1h) para um lote de até 100 números de parte; `GET …/upload/parts` lista as partes já gravadas no storage via `ListParts` — o storage é a fonte da verdade. Ambos exigem dono e `processing_status = pending_upload`. Vídeo inexistente, de outro usuário ou `publicId` malformado respondem o mesmo `404 VIDEO_NOT_FOUND`; parte acima de `part_count` → `422 INVALID_UPLOAD_PARTS`; estado errado → `409 INVALID_UPLOAD_STATE`.

## Test Scenarios

### 1. Assinar partes e retomar upload

**Setup:** `beforeEach` limpa `videos` no DB de teste; bootstrap de `AppModule` com os pipes/filters globais do `main.ts`; dois usuários confirmados (dono e outro) com `access_token` via `POST /auth/login`; rascunho criado via `POST /videos` com `size_bytes = 3 × 5242880` (3 partes). Ambiente do `test/setup-env.ts` (`STORAGE_PUBLIC_ENDPOINT = STORAGE_ENDPOINT`, partes de 5 MiB). Objetos do prefixo do teste removidos no `afterAll`.

#### 1.1. assina-lote-de-partes

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-10-09T13:41:14Z

**Steps:**
  1. POST /videos/:publicId/upload/part-urls como dono com body `{ part_numbers: [1, 2] }`
    - expect: status `200`
    - expect: `parts` tem 2 itens com `part_number` 1 e 2, cada um com `url` não vazia
    - expect: `expires_at` está a ≈ 3600s de agora (tolerância de alguns segundos)

#### 1.2. lista-partes-enviadas-para-retomada

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-09T13:41:14Z

**Steps:**
  1. POST …/upload/part-urls com `{ part_numbers: [1, 2, 3] }` e fazer `PUT` de 5 MiB nas URLs das partes 1 e 2 (guardar os headers `ETag`)
    - expect: cada `PUT` responde `200` com header `ETag`
  2. GET /videos/:publicId/upload/parts como dono
    - expect: status `200` com `part_count` = `3` e `part_size` = `5242880`
    - expect: `parts` contém exatamente as partes 1 e 2, em ordem ascendente, com `etag` iguais aos recebidos nos `PUT`

### 2. Recusas e isolamento

**Setup:** mesmo do grupo 1.

#### 2.1. parte-acima-de-part-count-422

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-09T13:41:14Z

**Steps:**
  1. POST …/upload/part-urls como dono com `{ part_numbers: [4] }` (upload de 3 partes)
    - expect: status `422` com `error` = `"INVALID_UPLOAD_PARTS"`

#### 2.2. validation-pipe-lista-vazia-ou-duplicada

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-09T13:41:14Z

**Steps:**
  1. POST …/upload/part-urls como dono com `{ part_numbers: [] }`
    - expect: status `400` com `error` = `"VALIDATION_ERROR"`
  2. POST …/upload/part-urls como dono com `{ part_numbers: [1, 1] }`
    - expect: status `400` com `error` = `"VALIDATION_ERROR"`

#### 2.3. outro-usuario-e-inexistente-404-identicos

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-09T13:41:14Z

**Steps:**
  1. GET …/upload/parts do vídeo do dono usando o token do outro usuário
    - expect: status `404` com `error` = `"VIDEO_NOT_FOUND"`
  2. GET /videos/AAAAAAAAAAA/upload/parts (publicId válido inexistente) como dono
    - expect: status `404` com corpo idêntico ao do passo 1
  3. POST …/upload/part-urls do vídeo do dono usando o token do outro usuário
    - expect: status `404` com `error` = `"VIDEO_NOT_FOUND"`

#### 2.4. estado-uploaded-409

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-10-09T13:41:14Z

**Steps:**
  1. Colocar o vídeo em `processing_status = uploaded` direto no DB de teste
  2. POST …/upload/part-urls como dono com `{ part_numbers: [1] }`
    - expect: status `409` com `error` = `"INVALID_UPLOAD_STATE"`
  3. GET …/upload/parts como dono
    - expect: status `409` com `error` = `"INVALID_UPLOAD_STATE"`

#### 2.5. sem-token-401-nas-duas-rotas

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-09T13:41:14Z

**Steps:**
  1. POST …/upload/part-urls sem `Authorization`
    - expect: status `401`
  2. GET …/upload/parts sem `Authorization`
    - expect: status `401`
