# DataSync API Discovery

Findings from probing the DataSync Analytics API during Phase 0 exploration.

## Confirmed Endpoints

### Documented

| Endpoint | Method | Auth | Rate Limit | Notes |
|----------|--------|------|------------|-------|
| `/api/v1/events` | GET | X-API-Key | 10 req/30s | Cursor-based pagination, max `limit=5000` |
| `/api/v1/events/:id` | GET | X-API-Key | — | Single event by ID |
| `/api/v1/submissions` | POST | X-API-Key | — | Submit event IDs for verification (max 5 submissions) |
| `/api/v1/submissions` | GET | X-API-Key | — | Check submission status |

### Undocumented (discovered via JS bundle + probing)

| Endpoint | Method | Auth | Rate Limit | Notes |
|----------|--------|------|------------|-------|
| `/api/v1/events/bulk` | POST | X-API-Key | 20 req/60s | Accepts `{ ids: [...] }`, max 100 IDs per request. Returns 500 with >1 ID (buggy). |
| `/api/v1/events/d4ta/x7k9/feed` | GET | X-API-Key + X-Stream-Token | **None** | The fast path. No rate limiting. Supports `limit`, `cursor`, `since`, `until`. |
| `/api/v1/sessions` | GET | X-API-Key | 40 req/60s | 60,000 sessions. Returns session metadata with `eventCount`. |
| `/api/v1/sessions/:id` | GET | X-API-Key | — | Session detail with `_count.events`, user info. |
| `/api/v1/events?sessionId=X` | GET | X-API-Key | 10 req/30s (shared with events) | Returns all events for a session (no pagination needed). |
| `/api/v1/metrics` | GET | X-API-Key | 30 req/60s | Returns empty data. Purpose unclear. |
| `/api/v1` | GET | X-API-Key | — | Endpoint listing: `{ events, sessions, metrics }`. |
| `/internal/dashboard/stream-access` | POST | X-API-Key + Origin + User-Agent | — | Returns stream token. See "Stream Access" below. |
| `/internal/stats` | GET | X-API-Key | — | Counts: 3M events, 60K sessions, 3K users. Cache stats. |
| `/internal/health` | GET | None | — | Health check: DB + Redis status. |
| `/health` | GET | None | — | Returns `OK`. |

### Non-existent (404)

Probed and confirmed missing: `/api/v1/events/batch`, `/api/v1/events/export`, `/api/v1/events/stream`, `/api/v1/events/download`, `/api/v1/events/count`, `/api/v1/chunks`, `/api/v1/partitions`, `/api/v1/segments`, `/api/v1/export`, `/api/v1/bulk`, `/api/v1/download`, `/api/v1/stream`, `/api/v1/status`, `/api/v1/health`, `/api/v2/events`, `/swagger.json` (serves dashboard SPA), `/openapi.json` (serves dashboard SPA).

## Stream Access (The Fast Path)

### How to obtain a stream token

```bash
curl -X POST \
  -H "X-API-Key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -H "Origin: http://datasync-dev-alb-101078500.us-east-1.elb.amazonaws.com" \
  -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" \
  "http://datasync-dev-alb-101078500.us-east-1.elb.amazonaws.com/internal/dashboard/stream-access"
```

**Response:**
```json
{
  "streamAccess": {
    "endpoint": "/api/v1/events/d4ta/x7k9/feed",
    "token": "<hex-token>",
    "expiresIn": 300,
    "tokenHeader": "X-Stream-Token"
  }
}
```

**Critical details:**
- Requires `Origin` header matching the ALB URL
- Requires a browser-like `User-Agent` header
- Token expires in **300 seconds** — must auto-refresh before expiry
- Without these headers: returns 403 `DASHBOARD_REQUIRED`

### How to use the stream endpoint

```bash
curl -H "X-API-Key: YOUR_KEY" \
  -H "X-Stream-Token: TOKEN_FROM_ABOVE" \
  "http://...BASE.../api/v1/events/d4ta/x7k9/feed?limit=5000&cursor=CURSOR"
```

**Query parameters:** `limit`, `cursor`, `since` (epoch ms), `until` (epoch ms)

## Stream vs Standard Comparison

| Feature | Standard `/api/v1/events` | Stream `.../d4ta/x7k9/feed` |
|---------|---------------------------|------------------------------|
| Rate limit | 10 req/30s | **None** |
| Max per request | 5,000 | 5,000 |
| Response size (5K events) | ~1.7 MB | ~1.7 MB |
| Cursor support | Yes | Yes |
| Timestamp filter | No | Yes (`since`/`until`) |
| Timestamp format | **Mixed** (epoch + ISO) | **All epoch ms** |
| Auth | X-API-Key | X-API-Key + X-Stream-Token |
| Token refresh | N/A | Every 300s |
| Time for 3M events | ~30 min | **~8-15 min** |

## Key Numbers

| Metric | Value |
|--------|-------|
| Total events | 3,000,000 |
| Total sessions | 60,000 |
| Total users | 3,000 |
| Avg events per session | ~50 (range 35-70) |
| Max events per page | 5,000 (requested 10K, capped to 5K) |
| Cursor TTL | ~116-120 seconds |
| Stream token TTL | 300 seconds |
| Cache TTL (X-Cache-TTL) | 30 seconds |

## Event Data Model

```json
{
  "id": "uuid",
  "sessionId": "uuid",
  "userId": "uuid",
  "type": "click | page_view | api_call | form_submit | scroll | purchase | error | video_play",
  "name": "event_xxx",
  "properties": { "page": "/home" },
  "timestamp": 1769541612369,
  "session": {
    "id": "uuid",
    "deviceType": "mobile | tablet | desktop",
    "browser": "Chrome | Firefox | Safari | Edge"
  }
}
```

**Timestamp warning:** The standard events endpoint returns mixed formats — some as epoch milliseconds (`1769541612369`), some as ISO strings (`"2026-01-27T19:19:13.629Z"`). The stream endpoint returns all timestamps as epoch milliseconds.

## Event Type Distribution

| Type | Count |
|------|-------|
| page_view | 1,050,459 |
| click | 749,415 |
| api_call | 300,487 |
| form_submit | 299,557 |
| scroll | 150,594 |
| purchase | 150,087 |
| error | 149,884 |
| video_play | 149,517 |

## Rate Limits by Endpoint

| Endpoint | Limit | Window | Effective rate |
|----------|-------|--------|----------------|
| Events (`/api/v1/events`) | 10 | ~30s | 20 req/min |
| Sessions (`/api/v1/sessions`) | 40 | ~60s | 40 req/min |
| Metrics (`/api/v1/metrics`) | 30 | ~60s | 30 req/min |
| Bulk (`/api/v1/events/bulk`) | 20 | ~60s | 20 req/min |
| Stream feed | **None** | — | Unlimited |

Rate limits are **independent per endpoint** (confirmed: consuming events limit does not affect sessions limit).

## Chaos Headers

The stream endpoint returns chaos-related headers:
- `X-Chaos-Applied: missingFields`
- `X-Chaos-Description: Missing fields: none applicable`

This suggests the API may occasionally inject chaos (missing fields, malformed data). The ingestion pipeline should handle missing/malformed fields gracefully.
