function emit(level: string, message: string, meta?: Record<string, unknown>) {
  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...meta,
  };
  console.log(JSON.stringify(entry));
}

export const log = {
  info: (msg: string, meta?: Record<string, unknown>) => emit("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit("error", msg, meta),
};

export function logProgress(
  totalEvents: number,
  targetEvents: number,
  startTime: number,
  source: string,
) {
  const elapsed = (Date.now() - startTime) / 1000;
  const eps = elapsed > 0 ? Math.round(totalEvents / elapsed) : 0;
  const pct = Math.round((totalEvents / targetEvents) * 10000) / 100;
  const remaining =
    eps > 0 ? Math.round((targetEvents - totalEvents) / eps) : 0;

  log.info("progress", {
    totalEvents,
    eventsPerSecond: eps,
    percentComplete: pct,
    elapsedSeconds: Math.round(elapsed),
    estimatedRemainingSeconds: remaining,
    source,
  });
}
