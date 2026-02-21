# Ingestion Pipeline Optimization Strategies

> Analysis performed by performance-engineer, database-optimizer, and data-engineer agents against the current codebase on branch `001-datasync-ingestion`. All three converged on the same core findings.

## API Discovery Context

The DataSync API has an **undocumented high-throughput stream endpoint** discovered by reverse-engineering the dashboard JS bundle:

| Endpoint | Auth | Rate Limit | Max Events/Page |
|---|---|---|---|
| `/api/v1/events` (standard) | `X-API-Key` | 10 req/60s | 1000 |
| `/api/v1/events/d4ta/x7k9/feed` (stream) | `X-API-Key` + `X-Stream-Token` | **None observed** | 1000 |

Stream access requires:
1. `POST /internal/dashboard/stream-access` with `Origin` header set to the dashboard URL
2. Returns `{ endpoint, token, expiresIn: 300, tokenHeader: "X-Stream-Token" }`
3. Stream endpoint supports `cursor`, `since`, `until` query params

---

## Tier 0 — Game Changers

### 1. Parallel Time-Range Partitioned Fetching

**Expected impact: 3-5x throughput**

The stream endpoint supports `since` and `until` timestamp filters. Instead of one serial cursor walking 3M events, partition the full time range into N non-overlapping windows and run N independent cursor chains concurrently.

**Approach:**
- Fetch first + last page to discover `[minTs, maxTs]`
- Split into N partitions: `{ since: minTs + i*range, until: minTs + (i+1)*range }`
- Each worker acquires its own stream token, follows its own cursor chain
- All workers write to the same UNLOGGED table (no PK = no contention)
- Dedup handles any overlap at partition boundaries

**Critical prerequisite:** Test whether the API allows multiple concurrent stream tokens (see Tier 3, item 14).

**Note:** The stream client currently self-throttles at 1 request per 6 seconds (`MIN_REQUEST_INTERVAL_MS = 6000` in `stream-client.ts`). This must be removed or significantly reduced for parallel fetching to have any effect. See new item 19.

### 2. Producer-Consumer with Bounded Buffer

**Expected impact: 2-3x throughput**

Decouple fetching from inserting with a bounded async queue. Currently the fetch loop and DB write loop are coupled — network is idle while DB writes, DB is idle while network fetches.

```
Producer (fetch loop)     Bounded Buffer (cap=6-8)     Consumer (COPY writers)
  fetch page 1 ──────────►  [page1]  ◄────────────── pop + COPY insert
  fetch page 2 ──────────►  [page2]
  fetch page 3 ──────────►  [page3]  ◄────────────── pop + COPY insert
  (backpressure if full)
```

- Buffer capacity: 6-8 pages (~16MB at 1000 events/page)
- Producer blocks only when buffer is full
- Consumer runs 4-6 concurrent COPY streams
- Effective per-batch time drops from `fetch_time + insert_time` to `max(fetch_time, insert_time)`

### 3. Eliminate the Drain Barrier

**Expected impact: 15-30% gain (reduced from 30-50% — prefetch partially addresses this)**

Current `pipeline.ts` calls `Promise.all()` on all 4 in-flight inserts (stop-the-world). A prefetch mechanism (`pendingFetch` at line 120) now starts the next API fetch while draining, which partially overlaps fetch and insert. However, the drain still blocks on ALL in-flight inserts before queuing more.

Remaining improvements:
- Replace `Promise.all()` drain with a sliding window that drains oldest-first
- When at capacity, `await` only the oldest in-flight insert
- New fetches begin as soon as ANY slot frees
- Increase `MAX_IN_FLIGHT` from 4 to 6-8

---

## Tier 1 — High Impact, Low Effort

### 4. UNLOGGED Table During Bulk Load — ALREADY IMPLEMENTED

**Status: Done.** `db.ts:40` uses `CREATE UNLOGGED TABLE`. `finalize()` at line 163 converts back with `ALTER TABLE ingested_events SET LOGGED` after dedup + PK creation. `ingestion_checkpoints` remains a regular LOGGED table.

### 5. Aggressive PostgreSQL Configuration

**Expected impact: 15-30% overall**

Recommended `docker-compose.yml` postgres command:

```yaml
command: >
  postgres
  -c shared_buffers=512MB
  -c work_mem=128MB
  -c maintenance_work_mem=1GB
  -c synchronous_commit=off
  -c wal_buffers=64MB
  -c checkpoint_completion_target=0.9
  -c checkpoint_timeout=30min
  -c max_wal_size=4GB
  -c min_wal_size=1GB
  -c effective_cache_size=1GB
  -c fsync=off
  -c full_page_writes=off
  -c autovacuum=off
  -c wal_level=minimal
  -c max_wal_senders=0
  -c archive_mode=off
  -c random_page_cost=1.1
  -c max_parallel_maintenance_workers=4
  -c huge_pages=try
  -c log_min_messages=warning
shm_size: 768mb
```

Key additions over current config:
- `fsync=off` — no disk sync (disposable container)
- `full_page_writes=off` — skip full-page images after checkpoint
- `autovacuum=off` — no background vacuum competing for I/O
- `wal_level=minimal` + `max_wal_senders=0` — minimal WAL detail
- `maintenance_work_mem=1GB` — faster PK index creation in finalize
- `max_parallel_maintenance_workers=4` — parallel index builds

### 6. HTTP Compression

**Expected impact: 30-80% less network I/O**

Add `Accept-Encoding: gzip, deflate, br` to all fetch headers. Currently ~1GB uncompressed JSON is transferred over 3000 pages. With gzip, this drops to ~130-200MB.

Node.js 20's `fetch` (undici) handles decompression transparently. Zero cost if server doesn't support it.

### 7. Rewrite Dedup Strategy — PARTIALLY IMPLEMENTED

**Status: The O(n^2) self-join is gone.** `db.ts:141-152` now uses `SELECT DISTINCT ON (id) * ... ORDER BY id, timestamp DESC` into a temp table, then TRUNCATE + INSERT back. This is O(n log n). Also has `hasPrimaryKey()` idempotency check to skip finalize if already done.

**Remaining optimizations:**

**Option A — In-app dedup (best):** Maintain a `Set<string>` of seen IDs in Node.js. Skip duplicates before they reach the DB. 3M UUIDs ≈ 108MB heap — acceptable. Eliminates the TRUNCATE+reinsert entirely.

**Option B — Try PK first, dedup on failure:** If duplicates are rare (likely with non-overlapping time partitions), just `ALTER TABLE ... ADD PRIMARY KEY (id)`. If it fails with duplicate key error, run the temp-table dedup then retry. Skips dedup cost in the happy path.

### 8. TEXT Instead of JSONB for Properties

**Expected impact: 5-15% faster inserts**

JSONB requires Postgres to parse + validate + convert to binary on every COPY row. TEXT just stores bytes. The properties column is never queried with JSON operators in this challenge.

---

## Tier 2 — Medium Impact

### 9. Accumulate COPY Payloads

**Expected impact: 10-15% less write time**

Build entire batch as a single string and call `copyStream.write()` once instead of per-event (currently 1000 write calls per batch, 3M total).

```typescript
const lines: string[] = [];
for (const e of events) {
  lines.push(`${e.id}\t${esc(e.sessionId)}\t...`);
}
copyStream.write(lines.join('\n') + '\n');
```

### 10. Fuse Normalize + COPY Line Building

**Expected impact: 5-10% less GC pressure**

Skip the intermediate `NormalizedEvent` object. Go directly from `RawApiEvent` to COPY tab-delimited line in a single pass. Eliminates 3M object allocations.

### 11. Fix and Optimize `esc()` Function

**Expected impact: 5-15% faster + correctness bug fix**

**Bug:** `esc()` is only applied to `properties`. The `sessionId`, `userId`, `type`, `name` fields use `?? "\\N"` and bypass escaping. If any contain `\t`, `\n`, or `\\`, the COPY stream corrupts silently.

**Optimization:** Replace 4 chained `.replace()` calls with a single-pass character scan:

```typescript
function esc(val: string | null | undefined): string {
  if (val == null) return "\\N";
  return val.replace(/[\\\t\n\r]/g, (ch) => {
    switch (ch) {
      case '\\': return '\\\\';
      case '\t': return '\\t';
      case '\n': return '\\n';
      case '\r': return '\\r';
      default: return ch;
    }
  });
}
```

### 12. Drop COUNT(*) Scans

**Expected impact: eliminates multi-second stalls**

`SELECT COUNT(*) FROM ingested_events` is a full sequential scan on 3M rows with no index. Use the checkpoint's running total for progress tracking. Reserve real COUNT for final verification only.

### 13. Async Healthcheck

**Expected impact: eliminates 750 event loop blocks**

Replace `writeFileSync` in `health.ts` with async `writeFile` from `node:fs/promises`, or debounce to at most once every few seconds.

---

## Tier 3 — Enablers & Refinements

### 14. Test Multiple Stream Tokens

**Enables: Tier 0, item 1 (parallel partitioned fetching)**

```
Acquire token A → Acquire token B → Fetch with token A
If 200: parallel tokens supported → run N stream workers
If 403: single-session enforced → 1 stream worker + N standard workers
```

### 15. Cursor Expiry Tracking

**Impact: prevents pipeline stalls**

The API returns `cursorExpiresIn` (~116s) in pagination responses. Currently ignored. Track it per-page, and before using a cursor check `Date.now() < cursorExpiresAt - 10_000`. If stale, re-fetch using `since` timestamp instead.

### 16. Increase maintenance_work_mem Before PK Creation

**Expected impact: 10-20% faster PK index**

Set `maintenance_work_mem = '1GB'` per-session before `ALTER TABLE ... ADD PRIMARY KEY`. Larger sort memory = fewer merge passes. Do NOT use `CREATE INDEX CONCURRENTLY` — it's slower (two table scans) and unnecessary without concurrent readers.

### 17. Custom undici Agent

**Expected impact: 5-10% less per-request latency**

Create a custom undici `Pool` with `connections: 10` (matching desired fetch concurrency) and `keepAliveTimeout: 30000`. Especially important if parallel fetching is implemented.

### 18. Reduce Checkpoint Frequency

**Expected impact: ~3s saved**

Currently checkpoints every 4 pages (~4000 events). Change to every 50K-100K events. The overlap from `since = lastTs - 1` on resume handles any gap.

### 19. Remove Self-Imposed Stream Throttle — CRITICAL

**Expected impact: 3-5x immediate throughput gain**

`stream-client.ts:14-15` sets `MIN_REQUEST_INTERVAL_MS = 6000`, forcing a 6-second pause between every stream API request. At 1000 events/page, this hard-caps throughput at **~167 events/second** regardless of any other optimization.

Our earlier testing showed the stream endpoint handling 3 rapid-fire requests with no 429s and no rate limit headers. This throttle appears to be a premature safety measure.

**Recommendation:** Remove the fixed throttle entirely. Replace with adaptive backoff: if a 429 is received, use `Retry-After` header or exponential backoff. Otherwise, fetch as fast as the network allows.

---

## Bug Report

### COPY Stream Escaping Bypass (Correctness) — STILL PRESENT

**File:** `packages/ingestion/src/db.ts`, lines 82-92

The `esc()` function is only called on `properties` (line 89). All other string fields (`sessionId`, `userId`, `type`, `name`, `deviceType`, `browser`) use raw `?? "\\N"` and bypass escaping. If any field contains a tab, newline, or backslash character, the COPY stream will be corrupted — potentially causing silent data loss or row misalignment.

### Rate Limit Reset Misinterpretation (Standard Client) — FIXED

**Status: Fixed.** `standard-client.ts:22-29` now uses smart detection: if the reset value < 1,000,000, it treats it as relative seconds (`Date.now() + resetVal * 1000`); otherwise as a Unix timestamp. Variable also renamed from `rateLimitResetAt` to `rateLimitResetsAt`.

### NEW: Self-Imposed Stream Throttle (Major Throughput Limiter)

**File:** `packages/ingestion/src/stream-client.ts`, lines 14-15, 88-93

`MIN_REQUEST_INTERVAL_MS = 6000` enforces a 6-second delay between stream API requests. At 1000 events/page, this caps throughput at ~167 events/second (~10,000 events/minute) regardless of all other optimizations. The stream endpoint showed **no rate limiting** in our testing (3 rapid-fire requests all returned 200). This throttle should be removed or replaced with adaptive backoff based on actual 429 responses.

---

## Implementation Status

### Already Implemented
- [x] #4 UNLOGGED table (with SET LOGGED in finalize)
- [x] #7 Dedup rewrite (DISTINCT ON temp table, replaces O(n^2) self-join)
- [x] Rate limit reset bug (smart relative/absolute detection)
- [x] Cursor reuse on resume (`pipeline.ts:74`)
- [x] `since - 1` to avoid timestamp boundary gaps (`pipeline.ts:76-78`)
- [x] Prefetch next page while draining (`pipeline.ts:120-125, 172-182`)
- [x] `hasPrimaryKey()` idempotency for crash recovery (`index.ts:40-41`)

### Still TODO

## Implementation Phases

### Phase 1 — Quick Wins (est. impact: 50-80% improvement)

Items: **#19 remove stream throttle**, #5 PG config, #6 compression, #8 TEXT props, #11 fix esc(), #12 drop COUNT, #13 async healthcheck

The stream throttle (#19) is the single most impactful quick win — it's a self-imposed 6s delay that caps throughput at ~167 events/sec. Removing it alone may 3-5x current throughput.

All are small, isolated changes. Low risk, high cumulative impact.

### Phase 2 — Architecture Refactor (est. impact: 2-3x on top of Phase 1)

Items: #3 sliding window drain (upgrade from prefetch to full sliding window), #2 producer-consumer, #9 accumulated COPY, #10 fused normalize+COPY

Medium effort refactor of `pipeline.ts` and `db.ts`. The existing prefetch partially addresses serial blocking, but a true producer-consumer with bounded buffer would eliminate it entirely.

### Phase 3 — Parallel Streams (est. impact: 3-5x on top of Phase 2)

Items: #14 test multi-token, #1 time-range partitioning, #15 cursor tracking, #7 in-app dedup (Set), #17 undici agent

High effort. Requires token multiplexing investigation, parallel worker coordination, and checkpoint schema changes. This is the multiplicative win.

### Theoretical Maximum

With all three phases implemented:
- Phase 1: 3-5x baseline (dominated by removing stream throttle)
- Phase 2: 2-3x on Phase 1 = 6-15x baseline
- Phase 3: 3-5x on Phase 2 = 18-75x baseline

Current baseline with 6s throttle: ~167 events/sec. Without throttle: ~1000-3000 events/sec (limited by serial fetch + network RTT). Theoretical ceiling with all optimizations: **27K-81K events/sec**, limited by Postgres COPY throughput and network bandwidth to the API.
