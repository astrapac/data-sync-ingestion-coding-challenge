# Feature Specification: DataSync Event Ingestion System

**Feature Branch**: `001-datasync-ingestion`
**Created**: 2026-02-21
**Status**: Draft
**Input**: User description: "Build a production-ready TypeScript data ingestion system that extracts 3,000,000 events from the DataSync Analytics API and stores them in PostgreSQL. The system must run entirely in Docker via `sh run-ingestion.sh` on a clean Linux machine with no manual intervention."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Full Automated Ingestion (Priority: P1)

An evaluator clones the repository onto a clean Linux machine with only Docker installed, runs `sh run-ingestion.sh`, and walks away. The system automatically connects to the DataSync API, discovers the fastest data access path, fetches all 3,000,000 events, stores them in PostgreSQL, and logs "ingestion complete" when finished. No manual steps, no config changes, no restarts.

**Why this priority**: This is the core deliverable. Without a fully automated end-to-end pipeline, the submission is disqualified.

**Independent Test**: Run `sh run-ingestion.sh` on a fresh environment. Verify `SELECT COUNT(*) FROM ingested_events;` returns 3,000,000 and container logs contain "ingestion complete".

**Acceptance Scenarios**:

1. **Given** a clean Linux machine with Docker installed, **When** the evaluator runs `sh run-ingestion.sh`, **Then** the system builds, starts, ingests all 3M events, and logs "ingestion complete" without any manual intervention.
2. **Given** a valid API key configured in the environment, **When** ingestion starts, **Then** the system obtains a high-throughput stream token and uses the fastest available API path.
3. **Given** events are being fetched, **When** timestamps arrive in mixed formats (epoch ms and ISO strings), **Then** all timestamps are normalized to a consistent format before storage.
4. **Given** the API occasionally injects chaos (missing fields), **When** a malformed event is received, **Then** the system handles it gracefully without crashing.

---

### User Story 2 - Crash Recovery and Resumability (Priority: P2)

The ingestion process crashes or is killed mid-way through the 3M events. On restart, the system detects prior progress and resumes from where it left off, without re-ingesting already stored events or losing data.

**Why this priority**: Explicitly required as a "Must Have". A 3M event ingestion that must restart from zero on failure is not production-ready.

**Independent Test**: Start ingestion, let it store ~500K events, kill the container with `docker kill`, then run `sh run-ingestion.sh` again. Verify it resumes from ~500K and reaches 3M without duplicates.

**Acceptance Scenarios**:

1. **Given** the system has ingested 500,000 events and is killed, **When** the system restarts, **Then** it detects the checkpoint and resumes from approximately event 500,000.
2. **Given** a restart occurs at a checkpoint boundary, **When** there is overlap between the last checkpoint and new data, **Then** duplicate events are detected and skipped (idempotent writes).
3. **Given** the system has fully completed ingestion, **When** it is restarted, **Then** it detects completion and logs "ingestion complete" immediately without re-fetching.

---

### User Story 3 - Progress Visibility and Health Monitoring (Priority: P3)

While ingestion is running, the evaluator can observe progress through container logs and verify the system is healthy. Structured log output shows events ingested, throughput rate, and estimated time to completion.

**Why this priority**: Listed as "Should Have". Demonstrates operational maturity and makes the evaluation experience smooth.

**Independent Test**: Run `docker logs -f assignment-ingestion` during ingestion and verify structured progress lines appear at regular intervals.

**Acceptance Scenarios**:

1. **Given** ingestion is running, **When** an evaluator views container logs, **Then** they see periodic progress updates including total events stored, events per second, and percentage complete.
2. **Given** the ingestion container is running, **When** the container health is checked, **Then** it reports healthy if it has fetched data recently, or unhealthy if stalled.
3. **Given** ingestion encounters rate limiting on fallback endpoints, **When** backoff is triggered, **Then** the logs indicate the rate limit event and the backoff duration.

---

### User Story 4 - Rate Limit Compliance (Priority: P4)

The system respects all API rate limits across all endpoints. When rate-limited, it backs off appropriately and retries. It never hammers the API beyond documented or observed limits.

**Why this priority**: Explicitly required as a "Must Have". Violating rate limits could result in API key revocation.

**Independent Test**: Monitor API response headers during ingestion and verify no 429 responses occur under normal operation. If 429s do occur, verify the system backs off and recovers.

**Acceptance Scenarios**:

1. **Given** the stream endpoint is available (no rate limits), **When** the system uses the stream path, **Then** it fetches data as fast as network and processing allow.
2. **Given** the stream endpoint is unavailable, **When** the system falls back to the standard paginated endpoint, **Then** it respects the 10 req/30s rate limit by reading response headers.
3. **Given** an API response returns HTTP 429, **When** the system processes the response, **Then** it waits for the duration specified in the `Retry-After` header before retrying.

---

### Edge Cases

- What happens when the stream token expires mid-ingestion? The system must detect the 403 response and refresh the token automatically without losing the current cursor position.
- What happens when the API returns an event with missing required fields (chaos injection)? The system must store what it can and log a warning, not crash.
- What happens when the database connection is temporarily lost? The system must retry with backoff, not exit.
- What happens when a cursor becomes stale (TTL ~120s)? The system must detect the error and either refresh the cursor or restart pagination from the last checkpoint.
- What happens when the API key expires (3-hour window)? The system must log a clear error indicating key expiration, not retry indefinitely.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST extract all 3,000,000 events from the DataSync Analytics API and store them in PostgreSQL.
- **FR-002**: System MUST use the high-throughput stream endpoint as the primary data access path. On transient stream errors (network, single 5xx), retry up to 3 times before falling back to standard pagination. On persistent failure (repeated token acquisition failure, repeated 403), fall back to standard pagination and periodically re-attempt stream acquisition.
- **FR-003**: System MUST obtain and auto-refresh stream access tokens before expiry (300-second TTL).
- **FR-004**: System MUST normalize all event timestamps to a consistent format (epoch milliseconds) regardless of source format (epoch ms or ISO string).
- **FR-005**: System MUST persist ingestion progress (cursor position, event count) to the database at regular intervals for crash recovery.
- **FR-006**: System MUST resume from the last checkpoint on restart, skipping already-ingested events via idempotent writes.
- **FR-007**: System MUST respect API rate limits by reading `X-RateLimit-*` response headers and backing off on HTTP 429.
- **FR-008**: System MUST log "ingestion complete" to stdout when all 3,000,000 events are stored.
- **FR-009**: System MUST run entirely within Docker containers orchestrated by `docker-compose.yml`.
- **FR-010**: System MUST start via `sh run-ingestion.sh` with no manual intervention or configuration changes.
- **FR-011**: System MUST use batch database writes (multi-row inserts) for throughput optimization.
- **FR-012**: System MUST handle API chaos injection (missing fields, malformed data) without crashing. Events with missing non-critical fields are stored with nulls. Events missing `id` are skipped and logged as errors.
- **FR-013**: System MUST provide structured log output showing ingestion progress at regular intervals.
- **FR-014**: System MUST implement a container health check that reports liveness based on recent successful activity.
- **FR-015**: System MUST handle database connection failures with retry logic.

### Key Entities

- **Event**: A user interaction record with id (UUID), sessionId, userId, type (8 categories), name, properties (key-value), timestamp (epoch ms), and embedded session metadata (deviceType, browser). The primary unit of ingestion.
- **Ingestion Checkpoint**: A progress marker with cursor position, total events ingested, timestamp of last successful write, and stream token state. Used for crash recovery.
- **Stream Token**: A time-limited credential (300s TTL) for accessing the high-throughput endpoint. Must be refreshed proactively before expiry.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: System ingests all 3,000,000 events in under 30 minutes from a cold start on a clean machine.
- **SC-002**: After a mid-ingestion crash, the system resumes and completes ingestion without re-processing more than one batch of events.
- **SC-003**: Zero duplicate events in the database after full ingestion (verified by unique event ID count matching total count).
- **SC-004**: Progress logs appear at least every 30 seconds during active ingestion, showing current count and throughput.
- **SC-005**: No API rate limit violations (zero HTTP 429 responses) under normal operation with the stream endpoint.
- **SC-006**: System completes end-to-end ingestion via `sh run-ingestion.sh` with zero manual intervention on a clean Linux machine.

## Clarifications

### Session 2026-02-21

- Q: How should chaos-injected events with missing fields affect the 3M target? → A: Store all events (ID is expected to always be present per observed API behavior). If an event lacks an `id`, skip it, log the error, and continue. The 3M target assumes all events have IDs; final count may be slightly less only if truly malformed records are encountered.
- Q: What triggers stream-to-standard fallback and does the system recover? → A: Smart fallback — retry stream on transient errors (3 attempts), fall back to standard pagination on persistent failure (repeated token/403), and periodically re-attempt stream acquisition.

## Assumptions

- The API key is provided via environment variable and is valid for 3 hours from first use.
- The DataSync API is reachable from the Docker container's network.
- PostgreSQL 16 is provided via the existing `docker-compose.yml` and is healthy before ingestion starts.
- The stream endpoint path and token header remain stable across API key sessions.
- The `run-ingestion.sh` script (provided) monitors for "ingestion complete" in container logs and polls the `ingested_events` table.
- Container name must be `assignment-ingestion` as expected by the monitoring script.
