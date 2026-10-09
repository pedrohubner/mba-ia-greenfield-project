---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.11
target_file: test/videos-get.e2e-spec.ts
---

# GET /videos/:publicId — Test Plan

## Application Overview

`GET /videos/:publicId` devolve o vídeo do dono no shape `Video`: status de processamento corrente, metadados (nulos até `ready`), `processing_error` com o reason code quando `failed`, e `thumbnail_url` pré-assinada (TTL `THUMBNAIL_URL_TTL_SECONDS`) quando a thumbnail existe. É o endpoint que o cliente consulta para acompanhar rascunho → processando → pronto/erro. Outro usuário, `publicId` inexistente ou malformado → `404 VIDEO_NOT_FOUND`; sem token → `401`.

## Test Scenarios

### 1. Consultar vídeo do dono

**Setup:** `beforeEach` limpa `videos` no DB de teste; bootstrap de `AppModule` com pipes/filters globais do `main.ts`; dois usuários confirmados (dono e outro) com `access_token`; vídeos semeados no DB de teste no canal do dono em estados diferentes; para o caso `ready`, um JPEG pequeno enviado ao storage em `thumbnails/{id}/auto.jpg`. Ambiente do `test/setup-env.ts` (URLs assinadas buscáveis de dentro do container).

#### 1.1. rascunho-com-metadados-nulos

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-10-09T13:41:14Z

**Steps:**
  1. Criar rascunho via `POST /videos`; GET /videos/:publicId como dono
    - expect: status `200` com `processing_status` = `"pending_upload"`
    - expect: `duration_seconds`, `width`, `height`, `video_codec`, `audio_codec`, `container_format`, `bitrate`, `processing_error` e `thumbnail_url` são `null`
    - expect: o corpo não contém `id`, `channel_id`, `object_key`, `upload_id` nem `thumbnail_key`

#### 1.2. video-ready-com-thumbnail-assinada

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-09T13:41:14Z

**Steps:**
  1. GET /videos/:publicId do vídeo semeado como `ready` (metadados preenchidos + `thumbnail_key`)
    - expect: status `200` com `processing_status` = `"ready"` e metadados preenchidos
    - expect: `thumbnail_url` é uma URL não vazia
  2. GET na `thumbnail_url`
    - expect: status `200` com header `Content-Type: image/jpeg`

#### 1.3. video-failed-expoe-reason-code

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-09T13:41:14Z

**Steps:**
  1. GET /videos/:publicId do vídeo semeado como `failed` com `processing_error = "INVALID_MEDIA"`
    - expect: status `200` com `processing_status` = `"failed"` e `processing_error` = `"INVALID_MEDIA"`

### 2. Isolamento e autenticação

**Setup:** mesmo do grupo 1.

#### 2.1. outro-usuario-malformado-e-sem-token

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-09T13:41:14Z

**Steps:**
  1. GET /videos/:publicId do vídeo do dono com o token do outro usuário
    - expect: status `404` com `error` = `"VIDEO_NOT_FOUND"`
  2. GET /videos/abc (publicId malformado) como dono
    - expect: status `404` com `error` = `"VIDEO_NOT_FOUND"`
  3. GET /videos/:publicId sem `Authorization`
    - expect: status `401`
