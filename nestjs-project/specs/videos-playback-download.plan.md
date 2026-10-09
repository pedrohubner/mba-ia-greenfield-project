---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.12
target_file: test/videos-playback-download.e2e-spec.ts
---

# GET /videos/:publicId/playback + GET /videos/:publicId/download — Test Plan

## Application Overview

Para um vídeo `ready`, `GET …/playback` devolve `{ url, expires_at }` com URL pré-assinada de longa duração (6h) — o storage atende `Range` com `206 Partial Content`, então nenhum byte passa pela API; `GET …/download` devolve URL de curta duração (15 min) que responde com `Content-Disposition: attachment` e nome derivado do título com a extensão original. Antes de `ready` → `409 VIDEO_NOT_READY`; outro usuário → `404 VIDEO_NOT_FOUND`; sem token → `401`. Este spec inclui o fluxo completo da fase, do início do upload ao download.

## Test Scenarios

### 1. Fluxo completo: upload → processamento → streaming → download

**Setup:** `beforeEach` limpa `videos` no DB de teste; bootstrap de `AppModule` com pipes/filters globais do `main.ts`; usuário confirmado com `access_token`; um contexto separado `Test.createTestingModule({ imports: [WorkerModule] })` para obter `VideoProcessingService` (o container `video-worker` usa outro `QUEUE_PREFIX` e não consome o job); fixture MP4/H.264 de ~6 MiB gerada com `ffmpeg -f lavfi` em diretório temporário. Ambiente do `test/setup-env.ts` (partes de 5 MiB, `STORAGE_PUBLIC_ENDPOINT = STORAGE_ENDPOINT`).

#### 1.1. fluxo-completo-upload-processamento-streaming-download

**Covers AC:** #1, #2, #3
**Source:** auto
**Last sync:** 2026-10-09T13:41:14Z

**Steps:**
  1. POST /videos com `{ filename: "fluxo.mp4", size_bytes: <tamanho da fixture>, content_type: "video/mp4", title: "Fluxo completo" }`
    - expect: status `201` com `upload.part_count` = `2`
  2. POST …/upload/part-urls com `{ part_numbers: [1, 2] }` e `PUT` dos dois pedaços da fixture nas URLs
    - expect: cada `PUT` responde `200` com `ETag`
  3. POST …/upload/complete com as partes e ETags
    - expect: status `200` com `processing_status` = `"uploaded"`
  4. Chamar `VideoProcessingService.process(videoId)` no próprio teste e depois GET /videos/:publicId
    - expect: `processing_status` = `"ready"` com `duration_seconds`, `width`, `height` e `video_codec` = `"h264"` preenchidos
  5. GET /videos/:publicId/playback
    - expect: status `200` com `url` não vazia e `expires_at` a ≈ 21600s de agora
  6. GET na `url` de playback com header `Range: bytes=0-1023`
    - expect: status `206` com `Content-Range: bytes 0-1023/<size_bytes>` e corpo de 1024 bytes
  7. GET /videos/:publicId/download
    - expect: status `200` com `expires_at` a ≈ 900s de agora
  8. GET na `url` de download
    - expect: status `200` com `Content-Disposition` começando por `attachment` e contendo `Fluxo completo.mp4` (via `filename*` ou fallback ASCII)

### 2. Recusas

**Setup:** mesmo do grupo 1, com vídeos semeados direto no DB de teste quando o estado não precisa de processamento real.

#### 2.1. antes-de-ready-409

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-09T13:41:14Z

**Steps:**
  1. Semear um vídeo do dono com `processing_status = processing`
  2. GET /videos/:publicId/playback como dono
    - expect: status `409` com `error` = `"VIDEO_NOT_READY"`
  3. GET /videos/:publicId/download como dono
    - expect: status `409` com `error` = `"VIDEO_NOT_READY"`

#### 2.2. outro-usuario-404-e-sem-token-401

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-09T13:41:14Z

**Steps:**
  1. GET …/playback de um vídeo `ready` do dono usando o token de outro usuário
    - expect: status `404` com `error` = `"VIDEO_NOT_FOUND"`
  2. GET …/playback sem `Authorization`
    - expect: status `401`
  3. GET …/download sem `Authorization`
    - expect: status `401`
