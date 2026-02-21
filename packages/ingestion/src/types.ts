export interface RawApiEvent {
  id?: string;
  sessionId?: string;
  userId?: string;
  type?: string;
  name?: string;
  properties?: Record<string, unknown>;
  timestamp?: number | string;
  session?: {
    id?: string;
    deviceType?: string;
    browser?: string;
  };
}

export interface NormalizedEvent {
  id: string;
  sessionId: string | null;
  userId: string | null;
  type: string | null;
  name: string | null;
  properties: Record<string, unknown>;
  timestamp: number;
  deviceType: string | null;
  browser: string | null;
}

export interface ApiPageResponse {
  data: RawApiEvent[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface StreamApiResponse {
  data: RawApiEvent[];
  pagination: {
    limit: number;
    hasMore: boolean;
    nextCursor: string | null;
    cursorExpiresIn?: number;
  } | null;
  meta: {
    total: number;
    returned: number;
    requestId: string;
  } | null;
}

export interface StreamAccessResponse {
  streamAccess: {
    endpoint: string;
    token: string;
    expiresIn: number;
    tokenHeader: string;
  };
}

export interface Checkpoint {
  id: number;
  cursor: string | null;
  totalEvents: number;
  lastEventTimestamp: number | null;
  status: "in_progress" | "completed";
}
