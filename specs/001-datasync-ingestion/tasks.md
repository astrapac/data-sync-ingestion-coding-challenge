# Tasks: DataSync Event Ingestion System

**Input**: Design documents from `/specs/001-datasync-ingestion/`
**Prerequisites**: plan.md, spec.md, data-model.md, contracts/types.ts, research.md

**Tests**: Not explicitly requested. Manual end-to-end validation via `run-ingestion.sh`.

**Organization**: Tasks grouped by user story (P1→P4) for incremental delivery.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3, US4)
- Include exact file paths in descriptions

## Path Conventions

All source code lives in `packages/ingestion/src/`. Flat module structure — no subdirectories.

```text
packages/ingestion/
├── Dockerfile
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts           # Entry point: startup, run pipeline, log completion
    ├── config.ts          # Environment config with defaults
    ├── types.ts           # Shared TypeScript interfaces
    ├── logger.ts          # Structured JSON logging + progress tracking
    ├── health.ts          # Health check file writer for Docker HEALTHCHECK
    ├── db.ts              # PostgreSQL: pool, schema, batch insert, checkpoint CRUD
    ├── stream-client.ts   # Stream token acquisition/refresh + page fetching
    ├── standard-client.ts # Standard pagination + rate limit handling
    └── pipeline.ts        # Producer-consumer: fetch → buffer → write → checkpoint
```

---

## Phase 1: Setup

**Purpose**: Project scaffolding and Docker configuration

- [ ] T001 Create `packages/ingestion/package.json` with `pg` dependency, `typescript` devDep, build/start scripts, `"type": "module"`
- [ ] T002 [P] Create `packages/ingestion/tsconfig.json` targeting ES2022, Node16 module resolution, strict mode
- [ ] T003 [P] Create `packages/ingestion/Dockerfile` with multi-stage build (node:20-alpine builder → runtime) and HEALTHCHECK instruction
- [ ] T004 Add ingestion service to `docker-compose.yml`: container name `assignment-ingestion`, depends_on postgres healthy, environment vars (DATABASE_URL, API_BASE_URL, API_KEY), network `assignment-network`
- [ ] T005 Create `packages/ingestion/src/types.ts` with shared interfaces: `RawApiEvent`, `NormalizedEvent`, `ApiPageResponse`, `StreamAccessResponse`, `IngestionCheckpoint`, `EventBatch`, `PipelineConfig`
- [ ] T006 [P] Create `packages/ingestion/src/config.ts` reading env vars with sensible defaults (API_BASE_URL, API_KEY, DATABASE_URL, BATCH_SIZE=5000, LOG_INTERVAL_MS=10000)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that all user stories depend on

- [ ] T007 Create `packages/ingestion/src/db.ts`: PostgreSQL pool (min 2, max 5 connections), `initSchema()` to CREATE TABLE `ingested_events` and `ingestion_checkpoints`, `batchInsertEvents(events)` with multi-row INSERT ON CONFLICT (id) DO NOTHING returning inserted count, connection retry with exponential backoff, pool shutdown
- [ ] T008 [P] Create `packages/ingestion/src/logger.ts`: structured JSON logging to stdout with `info()`, `warn()`, `error()` methods, each log line includes ISO timestamp + level + message + optional metadata object
- [ ] T009 Create `packages/ingestion/src/stream-client.ts`: `acquireToken()` POSTing to `/internal/dashboard/stream-access` with required Origin + User-Agent headers, `fetchPage(cursor?)` calling stream endpoint with X-API-Key + X-Stream-Token, auto-refresh token when age exceeds 240s, classify errors as transient vs persistent

**Checkpoint**: Foundation ready — DB schema, logging, and stream client available for pipeline

---

## Phase 3: User Story 1 — Full Automated Ingestion (Priority: P1) MVP

**Goal**: Run `sh run-ingestion.sh` on a clean machine → system fetches all 3M events via stream → stores in PostgreSQL → logs "ingestion complete". Zero manual intervention.

**Independent Test**: `sh run-ingestion.sh` on fresh environment. Verify `SELECT COUNT(*) FROM ingested_events;` returns 3,000,000 and logs contain "ingestion complete".

### Implementation for User Story 1

- [ ] T010 [US1] Create `packages/ingestion/src/pipeline.ts`: producer-consumer loop — single async fetcher calls `streamClient.fetchPage()` in sequence pushing `EventBatch` into bounded in-memory buffer (capacity 3), two concurrent writer tasks drain buffer calling `db.batchInsertEvents()`, normalize events inline (timestamps to epoch ms, flatten session metadata, nullify missing optional fields, skip events missing `id`), track running count, signal completion when API returns `hasMore: false`
- [ ] T011 [US1] Create `packages/ingestion/src/index.ts`: main entry point — initialize config, connect to DB, init schema, acquire stream token, run pipeline, on completion log `"ingestion complete"` to stdout, handle top-level errors with graceful shutdown (close DB pool), exit 0 on success / exit 1 on fatal error
- [ ] T012 [US1] Build and run end-to-end: `sh run-ingestion.sh` — verify Docker build succeeds, postgres starts, ingestion service connects, events flow into DB, "ingestion complete" appears in logs

**Checkpoint**: MVP complete — full ingestion works end-to-end. Validate before proceeding.

---

## Phase 4: User Story 2 — Crash Recovery and Resumability (Priority: P2)

**Goal**: Kill container mid-ingestion, re-run `sh run-ingestion.sh`, system resumes from last checkpoint without duplicates.

**Independent Test**: Start ingestion, let it store ~500K events, `docker kill assignment-ingestion`, re-run `sh run-ingestion.sh`. Verify it resumes from ~500K and reaches 3M. `SELECT COUNT(*) = COUNT(DISTINCT id)`.

### Implementation for User Story 2

- [ ] T013 [US2] Add checkpoint persistence to `packages/ingestion/src/db.ts`: `saveCheckpoint(cursor, totalEvents, lastTimestamp)` inserting row into `ingestion_checkpoints` with status `in_progress`, `getLatestCheckpoint()` returning most recent row, `markComplete()` updating status to `completed`
- [ ] T014 [US2] Update `packages/ingestion/src/pipeline.ts`: after each successful batch write call `saveCheckpoint()`, on pipeline completion call `markComplete()`
- [ ] T015 [US2] Update `packages/ingestion/src/index.ts`: on startup call `getLatestCheckpoint()` — if status is `completed` log "ingestion complete" and exit immediately, if status is `in_progress` resume pipeline using `lastEventTimestamp` as `since` param on stream endpoint (cursor will be stale), if no checkpoint start fresh
- [ ] T016 [US2] Verify crash recovery: start ingestion, wait for ~500K events, `docker kill`, re-run, confirm resume and no duplicates

**Checkpoint**: Crash recovery works — system is production-resilient

---

## Phase 5: User Story 3 — Progress Visibility and Health Monitoring (Priority: P3)

**Goal**: Evaluator sees structured progress logs every ~10s and container health check passes.

**Independent Test**: `docker logs -f assignment-ingestion` shows periodic progress lines with count, EPS, percentage. `docker inspect --format='{{.State.Health.Status}}' assignment-ingestion` returns "healthy".

### Implementation for User Story 3

- [ ] T017 [P] [US3] Add progress tracking to `packages/ingestion/src/logger.ts`: `logProgress(totalEvents, elapsedMs, source)` computing events/sec, percentage (of 3M), estimated remaining time, emitting structured JSON log line. Call from pipeline on configurable interval (LOG_INTERVAL_MS)
- [ ] T018 [P] [US3] Create `packages/ingestion/src/health.ts`: `touchHealthcheck()` writing current epoch seconds to `/tmp/healthcheck`. Call from pipeline after each successful batch write. Dockerfile HEALTHCHECK tests file exists and age < 60s
- [ ] T019 [US3] Wire progress and health into `packages/ingestion/src/pipeline.ts`: call `logProgress()` on interval timer, call `touchHealthcheck()` after each batch write

**Checkpoint**: Progress and health monitoring operational

---

## Phase 6: User Story 4 — Rate Limit Compliance (Priority: P4)

**Goal**: System respects rate limits on fallback endpoints, backs off on 429, smart fallback from stream to standard and back.

**Independent Test**: If stream is available, zero 429 responses. If stream fails, system falls back to standard pagination respecting 10 req/30s, and periodically re-attempts stream.

### Implementation for User Story 4

- [ ] T020 [US4] Create `packages/ingestion/src/standard-client.ts`: `fetchPage(cursor?)` calling `/api/v1/events` with X-API-Key, parse `X-RateLimit-Remaining` and `X-RateLimit-Reset` headers to self-throttle, on HTTP 429 read `Retry-After` header and wait, normalize mixed timestamps (epoch ms + ISO strings) to epoch ms
- [ ] T021 [US4] Add smart fallback to `packages/ingestion/src/pipeline.ts`: on stream transient error retry 3 times, on persistent failure switch to `standardClient.fetchPage()`, while on standard path attempt `streamClient.acquireToken()` every 60s, if re-acquired switch back to stream, log all fallback/recovery events
- [ ] T022 [US4] Update `packages/ingestion/src/stream-client.ts`: classify stream errors — transient (network timeout, single 5xx) vs persistent (repeated 403, repeated token failure), expose error type to pipeline for fallback decision

**Checkpoint**: Full rate limit compliance — system handles all API paths gracefully

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Edge cases, hardening, final validation

- [ ] T023 [P] Handle edge case in `packages/ingestion/src/stream-client.ts`: proactive token refresh at 240s mark (60s before 300s expiry), if refresh fails mid-ingestion retain current cursor position and retry
- [ ] T024 [P] Handle edge case in `packages/ingestion/src/pipeline.ts`: detect stale cursor errors from API, on stale cursor restart pagination from last checkpoint's `lastEventTimestamp` using `since` param
- [ ] T025 [P] Handle edge case in `packages/ingestion/src/db.ts`: on database connection loss, retry with exponential backoff (max 5 retries, 1s → 16s), log each retry attempt
- [ ] T026 Handle edge case in `packages/ingestion/src/index.ts`: detect API key expiration (repeated 401/403 across all endpoints), log clear error message "API key expired" and exit gracefully instead of retrying indefinitely
- [ ] T027 Run full end-to-end validation via `sh run-ingestion.sh` on clean state: verify 3M events, zero duplicates, completion in <30 min, structured logs present, health check passes

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 (T001-T006)
- **US1 (Phase 3)**: Depends on Phase 2 (T007-T009) — this is the MVP
- **US2 (Phase 4)**: Depends on US1 (Phase 3) — adds checkpointing to working pipeline
- **US3 (Phase 5)**: Depends on US1 (Phase 3) — adds logging/health to working pipeline
- **US4 (Phase 6)**: Depends on US1 (Phase 3) — adds fallback to working pipeline
- **Polish (Phase 7)**: Depends on US1-US4

### User Story Dependencies

- **US1 (P1)**: Blocks US2, US3, US4 — core pipeline must work first
- **US2 (P2)**: Can start after US1. Independent of US3/US4.
- **US3 (P3)**: Can start after US1. Independent of US2/US4. **Can parallel with US2.**
- **US4 (P4)**: Can start after US1. Independent of US2/US3. **Can parallel with US2/US3.**

### Within Each Phase

- Tasks without [P] must run sequentially in order
- Tasks with [P] can run in parallel with other [P] tasks in same phase

### Parallel Opportunities

**After US1 completes**, US2 + US3 + US4 can all proceed in parallel:

```text
Phase 1 → Phase 2 → Phase 3 (US1 MVP)
                          ├──→ Phase 4 (US2 Crash Recovery)
                          ├──→ Phase 5 (US3 Progress/Health)  [parallel]
                          └──→ Phase 6 (US4 Rate Limits)      [parallel]
                                    └──→ Phase 7 (Polish)
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001-T006)
2. Complete Phase 2: Foundational (T007-T009)
3. Complete Phase 3: User Story 1 (T010-T012)
4. **STOP and VALIDATE**: `sh run-ingestion.sh` → 3M events → "ingestion complete"
5. If MVP works, proceed to US2-US4

### Incremental Delivery

1. Setup + Foundational → Infrastructure ready
2. US1 → End-to-end ingestion works (MVP!)
3. US2 → Crash recovery added → Can survive kills
4. US3 → Progress logs + health → Evaluator experience
5. US4 → Fallback path → Full resilience
6. Polish → Edge cases hardened → Production-ready

---

## Summary

| Metric | Value |
|--------|-------|
| Total tasks | 27 |
| Phase 1 (Setup) | 6 tasks |
| Phase 2 (Foundational) | 3 tasks |
| Phase 3 (US1 - MVP) | 3 tasks |
| Phase 4 (US2 - Recovery) | 4 tasks |
| Phase 5 (US3 - Progress) | 3 tasks |
| Phase 6 (US4 - Rate Limits) | 3 tasks |
| Phase 7 (Polish) | 5 tasks |
| Parallel opportunities | 10 tasks marked [P] |
| MVP scope | Phases 1-3 (12 tasks) |

## Notes

- Keep code lean: 9 source files, flat structure, no unnecessary abstractions
- Each file does one thing well — no god modules
- Commit after each phase checkpoint
- The stream endpoint has no rate limits — US4 is only needed for the fallback path
- `ON CONFLICT (id) DO NOTHING` handles all dedup concerns across US1 and US2
