import type { Config } from "./config.js";
import type { RawApiEvent, NormalizedEvent, ApiPageResponse } from "./types.js";
import * as db from "./db.js";
import * as stream from "./stream-client.js";
import * as standard from "./standard-client.js";
import { log, logProgress } from "./logger.js";
import { touchHealthcheck } from "./health.js";

type Source = "stream" | "standard";

const MAX_IN_FLIGHT = 4;

function normalizeTimestamp(ts: unknown): number | null {
  if (typeof ts === "number") return ts;
  if (typeof ts === "string") {
    if (/^\d+$/.test(ts)) return parseInt(ts, 10);
    const d = new Date(ts);
    return isNaN(d.getTime()) ? null : d.getTime();
  }
  return null;
}

function normalizeBatch(raw: RawApiEvent[]): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
  let skipped = 0;
  for (const r of raw) {
    if (!r.id) { skipped++; continue; }
    const ts = normalizeTimestamp(r.timestamp);
    if (ts === null) { skipped++; continue; }
    events.push({
      id: r.id,
      sessionId: r.sessionId ?? null,
      userId: r.userId ?? null,
      type: r.type ?? null,
      name: r.name ?? null,
      properties: r.properties ?? {},
      timestamp: ts,
      deviceType: r.session?.deviceType ?? null,
      browser: r.session?.browser ?? null,
    });
  }
  if (skipped > 0) log.warn("skipped malformed events", { skipped });
  return events;
}

async function fetchOnePage(
  config: Config,
  source: Source,
  cursor: string | null,
  since: number | null,
): Promise<{ page: ApiPageResponse; error: null } | { page: null; error: string }> {
  if (source === "stream") {
    const result = await stream.fetchPage(config, cursor, cursor ? null : since);
    if (result.error) return { page: null, error: result.error.message };
    return { page: result.data!, error: null };
  } else {
    const result = await standard.fetchPage(config, cursor, cursor ? null : since);
    if (result.error) return { page: null, error: result.error };
    return { page: result.data!, error: null };
  }
}

interface InFlightInsert {
  promise: Promise<number>;
  lastTs: number;
  cursor: string | null;
}

export async function run(
  config: Config,
  resumeFrom?: { cursor: string | null; totalEvents: number; lastEventTimestamp: number | null },
): Promise<void> {
  let totalEvents = resumeFrom?.totalEvents ?? 0;
  let cursor: string | null = resumeFrom?.cursor ?? null;
  // Subtract 1ms from since to avoid missing events with exact same timestamp (dedup handles overlap)
  let since: number | null = resumeFrom?.lastEventTimestamp != null
    ? resumeFrom.lastEventTimestamp - 1
    : null;
  let source: Source = "stream";
  let consecutiveStreamFailures = 0;
  let lastStreamReacquireAttempt = 0;

  const startTime = Date.now();
  let lastLogTime = startTime;

  if (resumeFrom && resumeFrom.totalEvents > 0) {
    log.info("resuming ingestion", {
      fromEvents: totalEvents,
      sinceTimestamp: since,
    });
  }

  // Acquire stream token
  if (!stream.hasToken()) {
    const acquired = await stream.acquireToken(config);
    if (!acquired) {
      log.warn("stream unavailable, falling back to standard pagination");
      source = "standard";
    }
  }

  const inFlight: InFlightInsert[] = [];

  async function drainInserts(): Promise<void> {
    if (inFlight.length === 0) return;
    const results = await Promise.all(inFlight.map((f) => f.promise));
    let inserted = 0;
    for (const n of results) inserted += n;
    totalEvents += inserted;

    const last = inFlight[inFlight.length - 1];
    since = last.lastTs;
    await db.saveCheckpoint(last.cursor, totalEvents, last.lastTs);
    touchHealthcheck();

    inFlight.length = 0;
  }

  // Prefetch: start the next API fetch while draining DB inserts
  let pendingFetch: ReturnType<typeof fetchOnePage> | null = null;

  function startFetch(): ReturnType<typeof fetchOnePage> {
    if (source === "stream") stream.refreshTokenIfNeeded(config); // fire-and-forget ok, token check is fast
    return fetchOnePage(config, source, cursor, since);
  }

  while (true) {
    const result = pendingFetch ? await pendingFetch : await startFetch();
    pendingFetch = null;

    if (result.error) {
      await drainInserts();

      if (source === "stream") {
        consecutiveStreamFailures++;
        log.warn("stream error", {
          error: result.error,
          consecutive: consecutiveStreamFailures,
        });

        if (consecutiveStreamFailures <= config.maxStreamRetries) {
          await new Promise((r) => setTimeout(r, 1000 * consecutiveStreamFailures));
          continue;
        }

        log.warn("switching to standard pagination");
        source = "standard";
        consecutiveStreamFailures = 0;
        lastStreamReacquireAttempt = Date.now();
        continue;
      } else {
        log.error("standard fetch error", { error: result.error });
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
    }

    consecutiveStreamFailures = 0;
    const page = result.page!;
    const hasNext = page.hasMore && page.nextCursor;

    const events = normalizeBatch(page.data);
    if (events.length > 0) {
      const lastTs = events[events.length - 1].timestamp;
      inFlight.push({
        promise: db.batchInsert(events),
        lastTs,
        cursor: page.nextCursor,
      });
    }

    if (hasNext) {
      cursor = page.nextCursor!;
    }

    if (inFlight.length >= MAX_IN_FLIGHT || !hasNext) {
      // Start prefetching next page WHILE we drain inserts
      if (hasNext) {
        pendingFetch = startFetch();
      }
      await drainInserts();
    }

    const now = Date.now();
    if (now - lastLogTime >= config.logIntervalMs) {
      logProgress(totalEvents, config.totalEvents, startTime, source);
      lastLogTime = now;
    }

    if (!hasNext) break;

    // Re-acquire stream periodically while on standard path
    if (
      source === "standard" &&
      Date.now() - lastStreamReacquireAttempt >= config.streamReacquireIntervalMs
    ) {
      lastStreamReacquireAttempt = Date.now();
      if (await stream.acquireToken(config)) {
        log.info("stream re-acquired, switching back");
        source = "stream";
      }
    }
  }

  logProgress(totalEvents, config.totalEvents, startTime, source);
}
