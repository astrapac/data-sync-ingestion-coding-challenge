# Data Model: DataSync Event Ingestion System

**Phase 1 Output** | **Date**: 2026-02-21

## PostgreSQL Schema

### Table: `ingested_events`

Stores all 3M events from the DataSync API.

```sql
CREATE TABLE IF NOT EXISTS ingested_events (
    id UUID PRIMARY KEY,
    session_id UUID,
    user_id UUID,
    type VARCHAR(50),
    name VARCHAR(255),
    properties JSONB,
    timestamp BIGINT NOT NULL,
    device_type VARCHAR(50),
    browser VARCHAR(100)
);
```

**Design notes**:
- `id` as PRIMARY KEY provides uniqueness constraint for `ON CONFLICT DO NOTHING`
- `properties` as JSONB — arbitrary key-value pairs, queryable in PostgreSQL
- `session` metadata (deviceType, browser) flattened into columns — avoids nested JSONB for commonly queried fields
- `timestamp` as BIGINT (epoch ms) — consistent format per FR-004
- All fields except `id` and `timestamp` are nullable — handles chaos-injected events with missing fields (FR-012)
- No additional indexes beyond PK — we only INSERT, never query by secondary columns during ingestion

### Table: `ingestion_checkpoints`

Tracks ingestion progress for crash recovery.

```sql
CREATE TABLE IF NOT EXISTS ingestion_checkpoints (
    id SERIAL PRIMARY KEY,
    cursor TEXT,
    total_events INTEGER NOT NULL DEFAULT 0,
    last_event_timestamp BIGINT,
    status VARCHAR(20) NOT NULL DEFAULT 'in_progress',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

**Design notes**:
- `cursor` — last API cursor position (may be stale on restart; `last_event_timestamp` is the reliable resume point)
- `total_events` — running count of events inserted (for progress reporting and completion detection)
- `last_event_timestamp` — timestamp of the most recent event in the last batch; used with stream `since` param on resume
- `status` — `in_progress` or `completed`; allows instant detection of prior completion on restart
- New row inserted per checkpoint; latest row = current state (`ORDER BY id DESC LIMIT 1`)

## Entity Relationships

```text
┌─────────────────────┐
│  ingested_events    │
│─────────────────────│
│  id (PK, UUID)      │
│  session_id (UUID)  │──── (logical reference to API sessions, not enforced)
│  user_id (UUID)     │
│  type (VARCHAR)     │
│  name (VARCHAR)     │
│  properties (JSONB) │
│  timestamp (BIGINT) │
│  device_type (VARCHAR)│
│  browser (VARCHAR)  │
└─────────────────────┘

┌──────────────────────────┐
│  ingestion_checkpoints   │
│──────────────────────────│
│  id (PK, SERIAL)         │
│  cursor (TEXT)            │
│  total_events (INTEGER)  │
│  last_event_timestamp    │
│  status (VARCHAR)        │
│  created_at (TIMESTAMPTZ)│
└──────────────────────────┘
```

No foreign key between tables — checkpoints reference a logical position in the API stream, not specific event rows.

## Validation Rules

| Field | Rule | On Violation |
|-------|------|-------------|
| `id` | Must be present and valid UUID | Skip event, log error |
| `timestamp` | Must be present; if ISO string, convert to epoch ms | Parse or skip |
| `type` | Should be one of 8 known types | Store as-is (no enforcement) |
| `properties` | Must be valid JSON object or null | Default to `{}` |
| `session.deviceType` | Optional string | Store null if missing |
| `session.browser` | Optional string | Store null if missing |

## State Transitions

### Ingestion Lifecycle

```text
STARTUP ──▶ CHECK_CHECKPOINT ──▶ [no checkpoint] ──▶ FRESH_START
                                  [checkpoint found, status=completed] ──▶ LOG_COMPLETE ──▶ EXIT
                                  [checkpoint found, status=in_progress] ──▶ RESUME

FRESH_START / RESUME ──▶ ACQUIRE_TOKEN ──▶ FETCH_LOOP ──▶ COMPLETE
                                           │
                                           ▼ (on fatal error)
                                          SAVE_CHECKPOINT ──▶ EXIT(1)
```
