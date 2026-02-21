# Implementation Plan: DataSync Event Ingestion System

**Branch**: `001-datasync-ingestion` | **Date**: 2026-02-21 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/001-datasync-ingestion/spec.md`

## Summary

Build a TypeScript ingestion pipeline that extracts 3M events from the DataSync Analytics API via its undocumented stream endpoint (no rate limits, 5K events/page) and stores them in PostgreSQL. The pipeline uses a producer-consumer architecture: a single stream fetcher feeds a bounded buffer, drained by concurrent DB writers. Checkpoints persist after each batch for crash recovery. The entire system runs in Docker via `sh run-ingestion.sh`.

## Technical Context

**Language/Version**: TypeScript 5.3+ on Node.js 20 (Alpine)
**Primary Dependencies**: `pg` (PostgreSQL client), Node.js built-in `fetch` (undici under the hood)
**Storage**: PostgreSQL 16 (provided via docker-compose)
**Testing**: Manual end-to-end via `run-ingestion.sh`; `SELECT COUNT(*)` verification
**Target Platform**: Linux Docker container (multi-stage build)
**Project Type**: Single service (`packages/ingestion`)
**Performance Goals**: 3M events in <30 min (~100K events/min). Stream path estimate: ~8-12 min.
**Constraints**: 3-hour API key window, stream token 300s TTL, cursor ~120s TTL, 5K events max per page
**Scale/Scope**: 3M events, 60K sessions, single ingestion run

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Evidence |
|-----------|--------|----------|
| I. Throughput-First | PASS | Stream endpoint (no rate limit) as primary path; batch inserts; fetch/insert overlap via producer-consumer |
| II. Resilience by Default | PASS | PostgreSQL checkpoints after each batch; `ON CONFLICT (id) DO NOTHING` for idempotency; retry logic on all I/O |
| III. API Discovery First | PASS | Stream endpoint fully discovered and documented in `docs/api-discovery.md` |
| IV. Containerized Autonomy | PASS | Docker multi-stage build; `assignment-ingestion` container name; logs "ingestion complete"; `run-ingestion.sh` entry point |
| V. Work → Right → Fast | PASS | Phase progression: basic pipeline → resumability → throughput optimization |
| VI. Clean Pipeline Architecture | PASS | Separate modules: API client, transformer, DB writer, checkpoint manager, logger. Producer-consumer pattern with error isolation. |

No gate violations. No complexity tracking needed.

## Architecture

### Pipeline Design

```text
┌──────────────┐     ┌──────────────┐     ┌──────────────────┐
│ Stream       │     │ Bounded      │     │ Batch Writer     │
│ Fetcher      │────▶│ Buffer Queue │────▶│ (concurrent x2)  │
│ (single)     │     │ (3 pages)    │     │                  │
└──────┬───────┘     └──────────────┘     └────────┬─────────┘
       │                                           │
       │                                           ▼
┌──────▼───────┐                          ┌──────────────────┐
│ Token        │                          │ Checkpoint       │
│ Manager      │                          │ Manager          │
│ (auto-refresh│                          │ (per-batch save) │
│  at 240s)    │                          │                  │
└──────────────┘                          └──────────────────┘
                                                   │
                                          ┌────────▼─────────┐
                                          │ Progress Logger  │
                                          │ (every 10s)      │
                                          └──────────────────┘
```

**Why single fetcher?** The stream endpoint is cursor-based — each page returns `nextCursor` for the next request. True parallel fetching would require time-range splitting via `since`/`until`, which adds complexity for marginal gain when sequential fetch already completes in ~5 min. The producer-consumer overlap between fetch and DB writes is where throughput is gained.

**Why 2 concurrent writers?** Overlaps DB I/O with fetch I/O. While one writer inserts a batch, the fetcher and another writer can proceed independently. Diminishing returns beyond 2 writers for a single PostgreSQL instance.

### Data Flow

```text
API Response (JSON, 5K events)
  │
  ▼
Parse + Validate (skip events missing `id`, warn on missing fields)
  │
  ▼
Normalize (timestamps to epoch ms, nullify missing optional fields)
  │
  ▼
Buffer Queue (backpressure: pause fetch if queue full)
  │
  ▼
Multi-row INSERT ... ON CONFLICT (id) DO NOTHING
  │
  ▼
Update checkpoint (cursor, count, timestamp)
  │
  ▼
Write /tmp/healthcheck (touch file for Docker HEALTHCHECK)
```

### Fallback Strategy

```text
1. Obtain stream token → success? → use stream endpoint
                       → fail (3 retries)? → fall back to standard pagination

2. During stream fetch → 403/5xx? → retry 3x → still failing? → fall back
                       → token near expiry (240s)? → proactive refresh

3. During standard pagination → respect 10 req/30s via X-RateLimit-* headers
                              → every 60s: attempt stream re-acquisition

4. API key expired (3h)? → log clear error, exit gracefully
```

## Project Structure

### Documentation (this feature)

```text
specs/001-datasync-ingestion/
├── spec.md
├── plan.md              # This file
├── research.md          # Phase 0: decisions and rationale
├── data-model.md        # Phase 1: PostgreSQL schema + TypeScript types
├── quickstart.md        # Phase 1: how to run
├── contracts/
│   └── types.ts         # Phase 1: shared TypeScript interfaces
└── tasks.md             # Phase 2: generated by /speckit.tasks
```

### Source Code (repository root)

```text
packages/ingestion/
├── Dockerfile           # Multi-stage: builder (tsc) → runtime (node:20-alpine)
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts         # Entry point: orchestrates startup, pipeline, shutdown
    ├── config.ts        # Environment config with defaults
    ├── logger.ts        # Structured JSON logging with progress tracking
    ├── health.ts        # Writes /tmp/healthcheck for Docker HEALTHCHECK
    ├── db/
    │   ├── client.ts    # PostgreSQL pool management, connection retry
    │   ├── schema.ts    # Table creation (ingested_events, ingestion_checkpoints)
    │   └── writer.ts    # Batch INSERT ON CONFLICT, checkpoint CRUD
    ├── api/
    │   ├── stream.ts    # Stream token manager + stream page fetcher
    │   ├── standard.ts  # Standard paginated endpoint + rate limit handling
    │   └── client.ts    # Shared HTTP utilities, retry logic, error classification
    └── pipeline/
        ├── fetcher.ts   # Producer: fetches pages, pushes to buffer
        ├── buffer.ts    # Bounded async queue with backpressure
        └── orchestrator.ts  # Coordinates fetcher + writers, handles lifecycle
```

**Structure Decision**: Single service in `packages/ingestion/`. Follows the existing repo convention (`packages/` directory referenced in docker-compose.yml comments). Internal module split by concern: `api/` for HTTP, `db/` for persistence, `pipeline/` for orchestration.

## Key Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| HTTP client | Node.js built-in `fetch` | Zero dependencies; undici under the hood in Node 20; sufficient for sequential requests |
| DB client | `pg` | Standard PostgreSQL client for Node.js; supports connection pooling; no ORM overhead |
| Batch size | 5,000 (one API page = one DB batch) | Matches API page size; avoids buffering/splitting; multi-row INSERT is fast at this size |
| Checkpoint frequency | Every batch (5K events) | SC-002 requires resume within one batch; checkpointing per page gives fine-grained recovery |
| Token refresh | Proactive at 240s (60s before 300s expiry) | Avoids mid-request expiry; single refresh point |
| Buffer capacity | 3 pages (15K events) | Enough to decouple fetch from insert without excessive memory (~5MB) |
| Idempotency | `INSERT ON CONFLICT (id) DO NOTHING` | Zero-cost dedup; handles restart overlap cleanly |
| Health check | File-based (`/tmp/healthcheck` mtime) | Docker HEALTHCHECK reads file age; no HTTP server needed |
| Logging | Structured JSON to stdout | Docker captures stdout; evaluator can `docker logs -f`; machine-parseable |

## Complexity Tracking

No constitution violations to justify.
