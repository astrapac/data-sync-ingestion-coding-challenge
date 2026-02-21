# Research: DataSync Event Ingestion System

**Phase 0 Output** | **Date**: 2026-02-21

## Resolved Unknowns

### 1. Fastest API Path

**Decision**: Use undocumented stream endpoint `/api/v1/events/d4ta/x7k9/feed`
**Rationale**: No rate limits (vs 10 req/30s on standard endpoint). 5K events per page. Estimated 8-12 min for 3M events vs ~30 min with standard pagination.
**Alternatives considered**:
- Standard `/api/v1/events` with cursor pagination — 10 req/30s rate limit makes it ~30 min minimum
- Bulk `/api/v1/events/bulk` — buggy (500 errors with >1 ID), max 100 IDs/req, 20 req/60s
- Session-based fetching (`/api/v1/sessions` → events per session) — 40 req/60s on sessions, still rate-limited on events

### 2. Stream Token Acquisition

**Decision**: POST to `/internal/dashboard/stream-access` with `Origin` + browser `User-Agent` headers
**Rationale**: Only way to obtain stream token. Requires specific headers to bypass `DASHBOARD_REQUIRED` check.
**Key details**:
- Origin: `http://datasync-dev-alb-101078500.us-east-1.elb.amazonaws.com`
- User-Agent: Browser-like string (Mozilla/5.0...)
- Token expires in 300s — refresh proactively at 240s
- Response: `{ streamAccess: { endpoint, token, expiresIn, tokenHeader } }`

### 3. HTTP Client Choice

**Decision**: Node.js built-in `fetch` (undici)
**Rationale**: Zero additional dependencies. Node 20 ships undici as the fetch implementation. Sufficient for sequential cursor-based requests. No need for connection pooling on HTTP side (single stream fetcher).
**Alternatives considered**:
- `undici` (direct) — More control over connection pooling, but `fetch` is simpler and sufficient
- `axios` — Unnecessary dependency; `fetch` handles our needs
- `got` — Same reasoning as axios

### 4. PostgreSQL Client

**Decision**: `pg` (node-postgres)
**Rationale**: Standard, well-maintained, supports connection pooling via `Pool`. No ORM needed — we're doing simple INSERTs with a known schema.
**Alternatives considered**:
- `postgres` (porsager/postgres) — Faster in benchmarks, but `pg` is more widely used and sufficient
- Prisma/Drizzle/TypeORM — ORM overhead not justified for batch inserts into a single table

### 5. Concurrent Fetch Strategy

**Decision**: Single sequential fetcher with producer-consumer pipeline overlap
**Rationale**: Stream endpoint is cursor-based — `nextCursor` from page N is required to fetch page N+1. True parallel fetching requires time-range splitting (`since`/`until`), which adds complexity (non-uniform distribution, boundary handling, coordinated checkpointing) for marginal gain. Sequential fetch at ~0.5-1s/page completes in ~5 min. Pipeline overlap with DB writes gives us concurrent I/O.
**Alternatives considered**:
- Parallel time-range workers — Complex; risk of uneven distribution; not worth it when sequential already hits ~8-12 min
- Multiple cursor streams — Not supported by the API

### 6. Checkpoint Storage Mechanism

**Decision**: PostgreSQL table (`ingestion_checkpoints`) storing cursor, event count, and last event timestamp
**Rationale**: Same database as events — no additional infrastructure. On restart, read latest checkpoint. If cursor is stale (120s TTL), use `last_event_timestamp` with stream `since` param to resume. Idempotent inserts handle any overlap.
**Alternatives considered**:
- File-based checkpoints — Lost if container volume not persisted; PostgreSQL volume IS persisted
- Redis — Not provided in docker-compose; would add unnecessary infrastructure

### 7. Batch Insert Strategy

**Decision**: Multi-row `INSERT INTO ... VALUES (...), (...), ... ON CONFLICT (id) DO NOTHING`
**Rationale**: One DB round-trip per 5K events. `ON CONFLICT` handles dedup on restart. PostgreSQL handles 5K-row inserts efficiently.
**Alternatives considered**:
- COPY command — Faster for bulk loads but harder to integrate with ON CONFLICT
- Row-by-row INSERT — Unacceptably slow at 3M events
- Prepared statements with batched params — Similar performance to multi-row INSERT but more complex

### 8. Timestamp Normalization

**Decision**: Normalize all timestamps to epoch milliseconds (BIGINT) at parse time
**Rationale**: Stream endpoint returns epoch ms natively. Standard endpoint returns mixed formats. Normalizing at parse time means DB schema is consistent regardless of source.
**Logic**: If value is string and contains 'T' or '-', parse as ISO → `.getTime()`. If numeric, use as-is.

## Technology Best Practices Applied

### Node.js 20 Fetch
- Use `AbortController` for request timeouts
- Check `response.ok` before parsing JSON
- Handle network errors (DNS, connection refused) separately from HTTP errors

### PostgreSQL Batch Inserts
- Use parameterized queries to avoid SQL injection
- Pool connections (min 2, max 5) — matches writer concurrency
- Use transactions for checkpoint + batch insert atomicity (optional — ON CONFLICT handles idempotency)

### Docker Multi-Stage Build
- Builder stage: install all deps, compile TypeScript
- Runtime stage: copy compiled JS + production deps only
- Result: smaller image, faster builds
