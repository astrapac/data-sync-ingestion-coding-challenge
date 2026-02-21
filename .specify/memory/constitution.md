<!--
Sync Impact Report
- Version change: 1.0.0 → 1.1.0
- Modified principles:
  - III. API Discovery Mindset → III. API Discovery First (strengthened;
    paginated endpoint flagged as likely decoy, bulk path emphasis)
- Added principles:
  - VI. Clean Pipeline Architecture (new — covers 40% Job Processing score)
- Modified sections:
  - Technical Constraints: added 3-hour time budget as hard constraint
- Templates requiring updates:
  - .specify/templates/plan-template.md ✅ consistent
  - .specify/templates/spec-template.md ✅ consistent
  - .specify/templates/tasks-template.md ✅ consistent
- Deferred items: None
-->

# DataSync Ingestion System Constitution

## Core Principles

### I. Throughput-First Design

Every architectural decision MUST prioritize ingestion throughput. The system
is scored 60% on events-per-minute. This means:
- Concurrent workers MUST be used to maximize parallel API consumption
- Database writes MUST use batch inserts, not row-by-row operations
- Network I/O MUST NOT block other workers unnecessarily
- Cursor lifecycle MUST be managed to prevent staleness and re-fetching

**Rationale**: The evaluation criteria weight API Discovery & Throughput at 60%.
A correct but slow solution scores significantly worse than an optimized one.

### II. Resilience by Default

The ingestion pipeline MUST survive crashes and resume without data loss or
duplication. This means:
- Progress checkpoints MUST be persisted to PostgreSQL, not held in memory
- On restart, the system MUST detect prior progress and resume from the last
  successful checkpoint
- Duplicate event detection MUST be handled (idempotent inserts)
- Rate limit responses (HTTP 429) MUST trigger backoff, not failure

**Rationale**: The challenge explicitly requires resumable ingestion. A crash
mid-way through 3M events must not require starting over.

### III. API Discovery First

The API documentation is intentionally minimal — this is the challenge. The
paginated `/api/v1/events` endpoint is almost certainly NOT the fastest path.
Top candidates ingest all 3M events in under 30 minutes, which is impossible
with naive pagination. Engineers MUST:
- Probe the API for undocumented bulk/batch/export endpoints before writing
  any ingestion logic
- Inspect ALL response headers on every request for hints (compression,
  alternate content types, streaming, download URLs)
- Explore the dashboard UI thoroughly — it may reveal hidden endpoints,
  data export features, or alternate access patterns
- Test different HTTP methods (POST, OPTIONS) on known endpoints
- Check for undocumented query parameters beyond `limit` and `cursor`
- Look for sitemap, OpenAPI/Swagger, or other discovery endpoints
- Only fall back to cursor-based pagination if no faster path is found
- Normalize timestamp formats — they vary across responses

**Rationale**: The hints are explicit: "The documented API may not be the
fastest way", "Good engineers explore every corner of an application", and top
candidates finish in under 30 minutes. Discovery IS the challenge.

### IV. Containerized Autonomy

The solution MUST run on a clean Linux machine with only Docker installed.
This means:
- All code, dependencies, and configuration MUST be captured in Docker images
- No external API keys or third-party services beyond the DataSync API
- `sh run-ingestion.sh` MUST be the single entry point — no manual steps
- The ingestion container MUST log `"ingestion complete"` when finished
- Container name MUST be `assignment-ingestion` (monitored by the runner script)

**Rationale**: The submission is verified by running `sh run-ingestion.sh` on a
fresh environment. Any solution requiring manual intervention is disqualified.

### V. Make It Work, Make It Right, Make It Fast

Development MUST follow this progression strictly:
1. **Work**: Get end-to-end ingestion running (API → PostgreSQL) with basic
   pagination and error handling
2. **Right**: Add resumability, proper schema design, idempotent writes, and
   structured logging
3. **Fast**: Optimize concurrency, batch sizes, connection pooling, and exploit
   any discovered bulk/fast API paths

**Rationale**: Premature optimization before correctness leads to bugs that are
hard to diagnose under concurrency. Correctness before speed.

### VI. Clean Pipeline Architecture

Job Processing Architecture accounts for 40% of the score. The system MUST
demonstrate clear, well-structured pipeline design:
- **Separation of concerns**: API client, data transformation, and persistence
  MUST be distinct modules — not tangled in a single loop
- **Worker orchestration**: Workers MUST be coordinated through a clear pattern
  (worker pool, job queue, or pipeline stages) — not ad-hoc spawning
- **Error isolation**: A failure in one worker MUST NOT cascade to others;
  each worker MUST handle its own errors and report status
- **Observable pipeline**: Each stage MUST emit structured logs showing
  progress, throughput metrics, and error counts
- **Connection management**: Database and HTTP connections MUST be pooled and
  lifecycle-managed — no leaked connections under load

**Rationale**: 40% of the evaluation is Job Processing Architecture. Clean
separation, proper orchestration, and observable pipeline stages demonstrate
engineering maturity beyond just getting the data in.

## Technical Constraints

- **Language**: TypeScript on Node.js 20+
- **Database**: PostgreSQL 16 (provided via `docker-compose.yml`)
- **Source location**: All solution code in `packages/` directory
- **Database credentials**: user=`postgres`, password=`postgres`, db=`ingestion`
- **Internal DB host**: `postgres:5432` (Docker network); external `localhost:5434`
- **API auth**: `X-API-Key` header (preferred over query param for better rate limits)
- **API key lifetime**: 3 hours from first use — this is a hard time budget;
  all development exploration AND the final ingestion run MUST complete within
  this window. Plan API exploration carefully to avoid wasting time.
- **Target**: 3,000,000 events total
- **SOLID principles** apply to all code organization

## Development Workflow

- **Infrastructure**: `docker compose up -d` starts PostgreSQL
- **Full run**: `sh run-ingestion.sh` builds, starts, and monitors all services
- **Progress check**: Query `SELECT COUNT(*) FROM ingested_events;` on the DB
- **Log monitoring**: `docker logs -f assignment-ingestion`
- **Commit discipline**: Commit after each meaningful milestone (working
  pagination, resumability, throughput optimization)
- Follow the engineering philosophy in `CLAUDE.md` — challenge conventions,
  be direct, strive for excellence

## Governance

This constitution governs all implementation decisions for the DataSync
ingestion system. Amendments require:
1. Documented rationale for the change
2. Verification that the change does not violate challenge requirements
3. Updated version number following semver (MAJOR for principle removals,
   MINOR for additions, PATCH for clarifications)

Compliance is verified by ensuring:
- Every PR/change aligns with the six core principles
- Throughput benchmarks are maintained or improved
- Resumability is preserved across changes
- Pipeline architecture remains cleanly separated
- The solution remains fully Dockerized and autonomous

Use `CLAUDE.md` for runtime development guidance.

**Version**: 1.1.0 | **Ratified**: 2026-02-21 | **Last Amended**: 2026-02-21
