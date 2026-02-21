import { loadConfig } from "./config.js";
import * as db from "./db.js";
import { run } from "./pipeline.js";
import { log } from "./logger.js";

async function main() {
  const config = loadConfig();
  log.info("starting datasync ingestion", {
    apiBaseUrl: config.apiBaseUrl,
    batchSize: config.batchSize,
  });

  // Connect to database
  await db.connect(config.databaseUrl);
  await db.initSchema();

  // Check for existing checkpoint
  const checkpoint = await db.getLatestCheckpoint();

  if (checkpoint?.status === "completed") {
    const count = await db.getEventCount();
    log.info("prior ingestion already completed", { events: count });
    console.log("ingestion complete");
    await db.shutdown();
    return;
  }

  // Resume or fresh start — use actual DB count (not checkpoint count which may be stale)
  let resumeFrom: { cursor: string | null; totalEvents: number; lastEventTimestamp: number | null } | undefined;
  if (checkpoint) {
    const dbCount = await db.getEventCount();
    resumeFrom = {
      cursor: checkpoint.cursor,
      totalEvents: dbCount,
      lastEventTimestamp: checkpoint.lastEventTimestamp,
    };
  }

  // If table already has PK (crash after finalize but before markComplete), skip pipeline
  if (await db.hasPrimaryKey()) {
    log.info("table already finalized, skipping to completion");
  } else {
    if (resumeFrom) {
      log.info("found checkpoint, resuming", {
        totalEvents: resumeFrom.totalEvents,
        lastEventTimestamp: resumeFrom.lastEventTimestamp,
      });
    } else {
      log.info("no checkpoint found, starting fresh");
    }

    // Run the pipeline
    await run(config, resumeFrom);

    // Finalize: dedup + add PK
    await db.finalize();
  }

  // Mark complete
  const finalCount = await db.getEventCount();
  await db.markComplete(finalCount);

  log.info("all events ingested", { totalEvents: finalCount });
  console.log("ingestion complete");

  await db.shutdown();
}

main().catch((err) => {
  log.error("fatal error", { error: (err as Error).message, stack: (err as Error).stack });
  process.exit(1);
});
