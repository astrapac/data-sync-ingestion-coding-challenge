# DataSync Ingestion Solution

## How to Run

```bash
# One command — builds, starts, and monitors until completion:
sh run-ingestion.sh
```

**Prerequisites:** Docker and Docker Compose installed. Nothing else.

The script:
1. Builds the TypeScript ingestion service in a multi-stage Docker image
2. Starts PostgreSQL 16 + the ingestion container
3. Polls `ingested_events` count every 5 seconds
4. Exits when container logs `"ingestion complete"`

### Manual Commands

```bash
# Start services manually
docker compose up -d --build

# Check progress
docker exec assignment-postgres psql -U postgres -d ingestion -t -c "SELECT COUNT(*) FROM ingested_events;"

# View logs
docker logs -f assignment-ingestion

# Export event IDs for submission
docker exec assignment-postgres psql -U postgres -d ingestion -t -A \
  -c "SELECT id FROM ingested_events ORDER BY id;" > event_ids.txt
```

### Configuration

Set environment variables in `docker-compose.yml` or `.env`:

| Variable | Default | Purpose |
|----------|---------|---------|
| `API_KEY` | — | **Required.** Your DataSync API key |
| `API_BASE_URL` | `http://datasync-dev-alb-...` | API root URL |
| `DATABASE_URL` | `postgresql://postgres:postgres@postgres:5432/ingestion` | PostgreSQL connection |
| `BATCH_SIZE` | `5000` | Events per API page (max supported by API) |

---

## Architecture Overview

### High-Level Flow

```
                    ┌──────────────────────────────┐
                    │         index.ts              │
                    │  Bootstrap, resume check,     │
                    │  orchestrate lifecycle        │
                    └──────────┬───────────────────┘
                               │
                    ┌──────────▼───────────────────┐
                    │       pipeline.ts             │
                    │  Dual-path fetch loop with    │
                    │  prefetch + in-flight inserts  │
                    └──┬────────────────────────┬──┘
                       │                        │
          ┌────────────▼──────┐    ┌────────────▼──────┐
          │  stream-client.ts │    │ standard-client.ts │
          │  Fast path (no    │    │ Fallback path      │
          │  rate limit)      │    │ (rate-limited)     │
          └───────────────────┘    └───────────────────┘
                       │                        │
                    ┌──▼────────────────────────▼──┐
                    │           db.ts               │
                    │  COPY streaming, checkpoints, │
                    │  dedup, finalization           │
                    └──────────────────────────────┘
```

### Key Design Decisions

**1. Dual-Path Resilience (stream + standard)**

The pipeline starts on the undocumented stream endpoint (no rate limit). If it fails (429, token expiry, network errors), it falls back to the standard `/api/v1/events` endpoint. While on standard, it periodically re-attempts stream token acquisition and switches back when available. This self-healing happens automatically with zero manual intervention.

**2. PostgreSQL COPY Protocol**

Bulk inserts use `pg-copy-streams` with tab-delimited COPY — 10x+ faster than individual INSERT statements. Events are written as raw COPY lines, avoiding ORM overhead entirely.

**3. UNLOGGED Table During Load**

The `ingested_events` table is created as UNLOGGED (no WAL overhead) during bulk ingestion. After all events are loaded, finalization converts it to LOGGED for durability. This significantly reduces I/O during the write-heavy phase.

**4. Checkpoint-Based Resumability**

After every batch drain (4 pages), the pipeline persists a checkpoint with cursor position, event count, and last event timestamp. On crash/restart, it resumes from the checkpoint using the `since` timestamp parameter (offset by -1ms to catch boundary events). Deduplication handles any overlap.

**5. Prefetch Pipelining**

While the database drains in-flight inserts, the next API page is fetched concurrently. This overlaps network I/O with database I/O, reducing idle time on both sides.

**6. Post-Load Deduplication**

Rather than checking for duplicates during ingestion (which would add per-row overhead), duplicates are resolved in a single pass after all events are loaded using PostgreSQL's `DISTINCT ON (id)` into a temp table, keeping the row with the latest timestamp.

### Source Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Entry point: bootstrap, resume detection, finalization |
| `src/pipeline.ts` | Main fetch-insert orchestrator with dual-path switching |
| `src/stream-client.ts` | Stream token management + fast-path fetcher |
| `src/standard-client.ts` | Rate-limit-aware standard API client |
| `src/db.ts` | COPY streaming, checkpoints, dedup, finalization |
| `src/config.ts` | Environment-based configuration |
| `src/health.ts` | Docker HEALTHCHECK liveness signal |
| `src/types.ts` | Shared TypeScript interfaces |

---

## API Discoveries

### Undocumented Stream Endpoint (The Fast Path)

The dashboard's JavaScript bundle revealed an undocumented high-throughput endpoint:

1. **Token acquisition:** `POST /internal/dashboard/stream-access` — requires `Origin` header matching the ALB URL and a browser-like `User-Agent`
2. **Stream endpoint:** `GET /api/v1/events/d4ta/x7k9/feed` — requires `X-API-Key` + `X-Stream-Token` headers
3. **No rate limit** on the stream endpoint (vs 10 req/30s on standard)
4. **Token expires in 300 seconds** — must refresh proactively

### Other Undocumented Endpoints

| Endpoint | Notes |
|----------|-------|
| `/api/v1/sessions` | 60,000 sessions, 40 req/60s rate limit |
| `/api/v1/events/bulk` | POST with `{ ids: [...] }`, max 100 IDs, 20 req/60s |
| `/internal/stats` | Returns counts: 3M events, 60K sessions, 3K users |
| `/internal/health` | DB + Redis status |

### Timestamp Format Inconsistency

The standard events endpoint returns **mixed formats** — some as epoch milliseconds (`1769541612369`), some as ISO strings (`"2026-01-27T19:19:13.629Z"`). The stream endpoint consistently returns epoch milliseconds. The pipeline normalizes all formats in `normalizeTimestamp()`.

### Chaos Headers

The stream endpoint returns `X-Chaos-Applied` and `X-Chaos-Description` headers, suggesting the API may inject chaos (missing fields, malformed data). The pipeline skips events with missing IDs or invalid timestamps.

### Rate Limits by Endpoint

| Endpoint | Limit | Window |
|----------|-------|--------|
| `/api/v1/events` | 10 requests | ~30s |
| `/api/v1/sessions` | 40 requests | ~60s |
| `/api/v1/events/bulk` | 20 requests | ~60s |
| Stream feed | **None observed** | — |

### Key Numbers

| Metric | Value |
|--------|-------|
| Total events | 3,000,000 |
| Total sessions | 60,000 |
| Total users | 3,000 |
| Max events per page | 5,000 (API caps at 5K regardless of request) |
| Cursor TTL | ~116-120 seconds |
| Stream token TTL | 300 seconds |

---

## What I Would Improve With More Time

### 1. Parallel Time-Range Partitioned Fetching (3-5x throughput)

The stream endpoint supports `since` and `until` timestamp filters. Instead of one serial cursor walking 3M events, partition the time range into N non-overlapping windows and run N concurrent workers, each with its own stream token and cursor chain. This is the single biggest performance multiplier available.

### 2. Producer-Consumer Decoupling (2-3x throughput)

Replace the current coupled fetch-then-insert loop with a bounded async queue. A producer fills the buffer with fetched pages; consumers drain it via parallel COPY streams. Network is never idle while DB writes, and vice versa.

### 3. Aggressive PostgreSQL Tuning

The current PG config is conservative. For a disposable container doing pure bulk load:
- `fsync=off` — no disk sync needed
- `full_page_writes=off` — skip full-page WAL images
- `autovacuum=off` — no background vacuum
- `wal_level=minimal` — minimal WAL detail
- `maintenance_work_mem=1GB` — faster PK index creation

### 4. HTTP Compression

Add `Accept-Encoding: gzip` headers. Currently ~1GB of uncompressed JSON is transferred. With gzip, this drops to ~150-200MB — a 30-80% reduction in network I/O.

### 5. In-Memory Dedup

Maintain a `Set<string>` of seen event IDs in Node.js (3M UUIDs ~ 108MB heap). Skip duplicates before they hit the database, eliminating the post-load dedup pass entirely.

### 6. Remove Stream Self-Throttle

The stream client currently enforces a 6-second minimum interval between requests (`MIN_REQUEST_INTERVAL_MS`). This was added conservatively but the stream endpoint has no observed rate limit. Removing or reducing this would immediately increase throughput.

### 7. Unit & Integration Tests

Add test coverage for:
- Timestamp normalization edge cases
- COPY stream escaping (current `esc()` only covers `properties`, not all fields)
- Stream/standard failover logic
- Checkpoint resume scenarios

### 8. Metrics & Monitoring

Add structured metrics (events/sec, error rates, DB insert latency) exposed via a `/metrics` endpoint for Prometheus scraping or a lightweight dashboard.

---

## AI Tools Used

This solution was developed with assistance from:

- **Claude Code** (Anthropic's CLI tool) — primary development environment for code implementation, debugging, and iterative development
- **Claude Code Agents** — specialized sub-agents (performance-engineer, database-optimizer, data-engineer, code-reviewer) for parallel analysis of optimization strategies, API discovery, and architecture review
- **SpecKit** — specification-driven workflow tooling for structured planning, task generation, and cross-artifact consistency analysis

Key areas where AI tooling accelerated development:
- API endpoint discovery and reverse-engineering the dashboard JS bundle
- Architecture design and optimization strategy analysis
- Code implementation, debugging, and performance profiling
- Structured planning with dependency-ordered task breakdown
