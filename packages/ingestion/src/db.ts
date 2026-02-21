import pg from "pg";
import { from as copyFrom } from "pg-copy-streams";
import { log } from "./logger.js";
import type { NormalizedEvent, Checkpoint } from "./types.js";

const { Pool } = pg;

let pool: pg.Pool;

export async function connect(databaseUrl: string): Promise<void> {
  pool = new Pool({
    connectionString: databaseUrl,
    min: 4,
    max: 20,
  });

  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const client = await pool.connect();
      client.release();
      log.info("database connected");
      return;
    } catch (err) {
      const delay = Math.min(1000 * 2 ** (attempt - 1), 16000);
      log.warn("database connection failed, retrying", {
        attempt,
        nextRetryMs: delay,
        error: (err as Error).message,
      });
      if (attempt === 5) throw err;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

export async function initSchema(): Promise<void> {
  // UNLOGGED = no WAL during bulk load (faster writes). Convert to logged in finalize().
  // No PK during bulk load — dedup + add constraint in finalize()
  await pool.query(`
    CREATE UNLOGGED TABLE IF NOT EXISTS ingested_events (
      id UUID NOT NULL,
      session_id UUID,
      user_id UUID,
      type VARCHAR(50),
      name VARCHAR(255),
      properties JSONB,
      timestamp BIGINT NOT NULL,
      device_type VARCHAR(50),
      browser VARCHAR(100)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ingestion_checkpoints (
      id SERIAL PRIMARY KEY,
      cursor TEXT,
      total_events INTEGER NOT NULL DEFAULT 0,
      last_event_timestamp BIGINT,
      status VARCHAR(20) NOT NULL DEFAULT 'in_progress',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  log.info("schema initialized");
}

// Escape a value for tab-delimited COPY format
function esc(val: string | null): string {
  if (val === null || val === undefined) return "\\N";
  return val.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n").replace(/\r/g, "\\r");
}

export async function batchInsert(events: NormalizedEvent[]): Promise<number> {
  if (events.length === 0) return 0;

  const client = await pool.connect();
  try {
    const copyStream = client.query(
      copyFrom(
        "COPY ingested_events (id, session_id, user_id, type, name, properties, timestamp, device_type, browser) FROM STDIN WITH (FORMAT text)"
      )
    );

    for (const e of events) {
      const line = [
        e.id,
        e.sessionId ?? "\\N",
        e.userId ?? "\\N",
        e.type ?? "\\N",
        e.name ?? "\\N",
        esc(JSON.stringify(e.properties)),
        String(e.timestamp),
        e.deviceType ?? "\\N",
        e.browser ?? "\\N",
      ].join("\t") + "\n";
      copyStream.write(line);
    }

    await new Promise<void>((resolve, reject) => {
      copyStream.on("finish", resolve);
      copyStream.on("error", reject);
      copyStream.end();
    });

    return events.length;
  } finally {
    client.release();
  }
}

export async function saveCheckpoint(
  cursor: string | null,
  totalEvents: number,
  lastEventTimestamp: number | null,
): Promise<void> {
  await pool.query(
    `INSERT INTO ingestion_checkpoints (cursor, total_events, last_event_timestamp, status)
     VALUES ($1, $2, $3, 'in_progress')`,
    [cursor, totalEvents, lastEventTimestamp],
  );
}

export async function hasPrimaryKey(): Promise<boolean> {
  const result = await pool.query(`
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'ingested_events'::regclass AND contype = 'p'
    LIMIT 1
  `);
  return result.rows.length > 0;
}

export async function finalize(): Promise<void> {
  // Idempotent: skip if already finalized (PK exists)
  if (await hasPrimaryKey()) {
    log.info("finalize: already finalized (PK exists), skipping");
    return;
  }

  const beforeCount = await getEventCount();
  log.info("deduplicating events", { beforeCount });

  // Use temp table + DISTINCT ON — O(n log n) vs O(n^2) self-join
  await pool.query(`
    CREATE TEMP TABLE deduped AS
    SELECT DISTINCT ON (id) *
    FROM ingested_events
    ORDER BY id, timestamp DESC
  `);
  await pool.query(`TRUNCATE ingested_events`);
  await pool.query(`
    INSERT INTO ingested_events
    SELECT * FROM deduped
  `);
  await pool.query(`DROP TABLE deduped`);

  const afterCount = await getEventCount();
  log.info("dedup complete", { removed: beforeCount - afterCount, afterCount });

  log.info("creating primary key index");
  await pool.query(`ALTER TABLE ingested_events ADD PRIMARY KEY (id)`);
  log.info("primary key created");

  // Convert to logged table for durability now that bulk load is done
  log.info("converting to logged table");
  await pool.query(`ALTER TABLE ingested_events SET LOGGED`);
  log.info("table is now logged");
}

export async function markComplete(totalEvents: number): Promise<void> {
  await pool.query(
    `INSERT INTO ingestion_checkpoints (cursor, total_events, last_event_timestamp, status)
     VALUES (NULL, $1, NULL, 'completed')`,
    [totalEvents],
  );
}

export async function getLatestCheckpoint(): Promise<Checkpoint | null> {
  const result = await pool.query(
    `SELECT id, cursor, total_events, last_event_timestamp, status
     FROM ingestion_checkpoints ORDER BY id DESC LIMIT 1`,
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    id: row.id,
    cursor: row.cursor,
    totalEvents: row.total_events,
    lastEventTimestamp: row.last_event_timestamp
      ? Number(row.last_event_timestamp)
      : null,
    status: row.status,
  };
}

export async function getEventCount(): Promise<number> {
  const result = await pool.query("SELECT COUNT(*) FROM ingested_events");
  return parseInt(result.rows[0].count, 10);
}

export async function shutdown(): Promise<void> {
  await pool.end();
}
