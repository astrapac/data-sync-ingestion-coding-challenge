export interface Config {
  apiBaseUrl: string;
  apiKey: string;
  databaseUrl: string;
  batchSize: number;
  bufferCapacity: number;
  logIntervalMs: number;
  tokenRefreshBufferMs: number;
  maxStreamRetries: number;
  streamReacquireIntervalMs: number;
  totalEvents: number;
}

export function loadConfig(): Config {
  const apiKey = process.env.API_KEY ?? process.env.TARGET_API_KEY;
  if (!apiKey) {
    throw new Error("API_KEY or TARGET_API_KEY environment variable is required");
  }

  return {
    apiBaseUrl:
      process.env.API_BASE_URL ??
      "http://datasync-dev-alb-101078500.us-east-1.elb.amazonaws.com",
    apiKey,
    databaseUrl:
      process.env.DATABASE_URL ??
      "postgresql://postgres:postgres@postgres:5432/ingestion",
    batchSize: parseInt(process.env.BATCH_SIZE ?? "5000", 10),
    bufferCapacity: parseInt(process.env.BUFFER_CAPACITY ?? "3", 10),
    logIntervalMs: parseInt(process.env.LOG_INTERVAL_MS ?? "10000", 10),
    tokenRefreshBufferMs: 60_000,
    maxStreamRetries: 3,
    streamReacquireIntervalMs: 60_000,
    totalEvents: 3_000_000,
  };
}
