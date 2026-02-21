/**
 * DataSync Event Ingestion — Shared Type Contracts
 *
 * These types define the data flowing through the ingestion pipeline.
 * They are the contract between API responses, transformation logic, and DB writes.
 */

// ─── API Response Types ───────────────────────────────────────────────

/** Raw event as returned by the DataSync API */
export interface RawApiEvent {
  id: string;
  sessionId?: string;
  userId?: string;
  type?: string;
  name?: string;
  properties?: Record<string, unknown>;
  timestamp: number | string; // epoch ms OR ISO string (mixed on standard endpoint)
  session?: {
    id?: string;
    deviceType?: string;
    browser?: string;
  };
}

/** Paginated API response shape (both standard and stream endpoints) */
export interface ApiPageResponse {
  data: RawApiEvent[];
  hasMore: boolean;
  nextCursor: string | null;
}

/** Stream token response from /internal/dashboard/stream-access */
export interface StreamAccessResponse {
  streamAccess: {
    endpoint: string;
    token: string;
    expiresIn: number;
    tokenHeader: string;
  };
}

// ─── Normalized Types (post-transform, pre-DB) ───────────────────────

/** Event after normalization — ready for DB insertion */
export interface NormalizedEvent {
  id: string;
  sessionId: string | null;
  userId: string | null;
  type: string | null;
  name: string | null;
  properties: Record<string, unknown>;
  timestamp: number; // always epoch ms
  deviceType: string | null;
  browser: string | null;
}

// ─── Checkpoint Types ─────────────────────────────────────────────────

export type IngestionStatus = "in_progress" | "completed";

/** Checkpoint persisted to PostgreSQL for crash recovery */
export interface IngestionCheckpoint {
  id: number;
  cursor: string | null;
  totalEvents: number;
  lastEventTimestamp: number | null;
  status: IngestionStatus;
  createdAt: Date;
}

// ─── Pipeline Types ───────────────────────────────────────────────────

/** A batch of events ready for DB insertion */
export interface EventBatch {
  events: NormalizedEvent[];
  cursor: string | null;
  lastTimestamp: number | null;
  pageNumber: number;
}

/** Configuration for the ingestion pipeline */
export interface PipelineConfig {
  apiBaseUrl: string;
  apiKey: string;
  databaseUrl: string;
  batchSize: number;
  bufferCapacity: number;
  logIntervalMs: number;
  tokenRefreshBufferMs: number; // refresh this many ms before expiry
  maxStreamRetries: number;
  streamReacquireIntervalMs: number; // when fallen back, retry stream every N ms
}

// ─── Logging Types ────────────────────────────────────────────────────

/** Structured log entry for progress reporting */
export interface ProgressLog {
  level: "info" | "warn" | "error";
  message: string;
  totalEvents: number;
  eventsPerSecond: number;
  percentComplete: number;
  elapsedSeconds: number;
  estimatedRemainingSeconds: number;
  source: "stream" | "standard";
  timestamp: string; // ISO string for log readability
}
