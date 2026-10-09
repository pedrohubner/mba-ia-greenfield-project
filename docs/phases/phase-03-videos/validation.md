---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-10-08T09:27:18-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-08T09:21:11-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-10-08T09:27:12-03:00"
issues:
  - id: AMB-1
    status: resolved
    summary: "Draft pre-registration: which fields does initiate require (title source)?"
    resolved_by: phase-03-videos/TD-03
  - id: AMB-2
    status: resolved
    summary: "'Metadados' unspecified: which ffprobe fields are persisted on the video?"
    resolved_by: phase-03-videos/TD-08
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._ Every capability in `## Capability Coverage` maps to ≥1 TD. The error response format for `nestjs-project` is already defined by the inherited `phase-02-auth/TD-07`. The shared-types contract-sync check (Decisão #29) does not apply, because the phase has no UI scope (`## UI Inventory` absent).

### Dependency Gaps

_None._ Owner-only access (`phase-03-videos/TD-11`) relies on the Phase 02 JWT guard and on the `channels` relation, both delivered (`phase-02-auth/TD-02`, `TD-10`). Config/env additions follow the inherited `registerAs` + Joi conventions from Phase 01.

### Inherited Constraint Conflicts

_None._ `phase-03-videos/TD-11` (JSON presigned URLs) is consistent with the inherited strict BFF (`next-frontend-config-base/TD-03`). Direct browser→storage part uploads (`phase-03-videos/TD-02`) do not call the NestJS API, so they do not bypass the BFF. The worker reusing TypeORM/config (`phase-03-videos/TD-07`) matches the inherited `forRootAsync` / `registerAs` conventions. The libraries decided in `phase-03-videos/TD-01` (`@nestjs/bullmq`, `bullmq`) and `TD-02` (`@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`) do not overlap or conflict with any inherited library choice.

### Unresolved Open Questions

_None._ All 13 TDs are `decided`. AMB-1 and AMB-2 are closed by the `**Revisions:**` entries on `phase-03-videos/TD-03` and `phase-03-videos/TD-08`.

### UI Coverage Gaps

_None._ (UI not in scope for this phase.)

## Resolved Issues

- **AMB-1** _(resolved_by phase-03-videos/TD-03)_ — Draft pre-registration: which fields does initiate require (title source)? User: optional `title` in the initiate request; when absent, default to the original filename without extension (sanitized, truncated to the column max length). Recorded as a `**Revisions:**` entry on TD-03.
- **AMB-2** _(resolved_by phase-03-videos/TD-08)_ — 'Metadados' unspecified: which ffprobe fields are persisted on the video? User: fixed typed columns — `duration_seconds`, `width`, `height`, `video_codec`, `audio_codec` (nullable), `container_format`, `bitrate`, `size_bytes`. Recorded as a `**Revisions:**` entry on TD-08.
