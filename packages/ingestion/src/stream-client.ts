import { log } from "./logger.js";
import type { Config } from "./config.js";
import type { ApiPageResponse, StreamAccessResponse, StreamApiResponse } from "./types.js";

const ORIGIN =
  "http://datasync-dev-alb-101078500.us-east-1.elb.amazonaws.com";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

let token: string | null = null;
let tokenEndpoint: string | null = null;
let tokenAcquiredAt = 0;
let tokenExpiresIn = 300;
let lastRequestAt = 0;
const MIN_REQUEST_INTERVAL_MS = 6000; // Pace to stay under rate limit (~10 req/60s)

export type StreamError = { type: "transient" | "persistent"; message: string };

export async function acquireToken(config: Config): Promise<boolean> {
  try {
    const res = await fetch(
      `${config.apiBaseUrl}/internal/dashboard/stream-access`,
      {
        method: "POST",
        headers: {
          "X-API-Key": config.apiKey,
          "Content-Type": "application/json",
          Origin: ORIGIN,
          "User-Agent": USER_AGENT,
        },
      },
    );

    if (!res.ok) {
      log.warn("stream token acquisition failed", {
        status: res.status,
        statusText: res.statusText,
      });
      return false;
    }

    const body = (await res.json()) as StreamAccessResponse;
    token = body.streamAccess.token;
    tokenEndpoint = body.streamAccess.endpoint;
    tokenExpiresIn = body.streamAccess.expiresIn;
    tokenAcquiredAt = Date.now();

    log.info("stream token acquired", {
      endpoint: tokenEndpoint,
      expiresIn: tokenExpiresIn,
    });
    return true;
  } catch (err) {
    log.warn("stream token acquisition error", {
      error: (err as Error).message,
    });
    return false;
  }
}

function isTokenExpiringSoon(bufferMs: number): boolean {
  if (!token) return true;
  const age = Date.now() - tokenAcquiredAt;
  return age >= tokenExpiresIn * 1000 - bufferMs;
}

export async function refreshTokenIfNeeded(config: Config): Promise<boolean> {
  if (!isTokenExpiringSoon(config.tokenRefreshBufferMs)) return true;
  log.info("refreshing stream token (proactive)");
  return acquireToken(config);
}

export async function fetchPage(
  config: Config,
  cursor?: string | null,
  since?: number | null,
): Promise<{ data: ApiPageResponse; error: null } | { data: null; error: StreamError }> {
  if (!token || !tokenEndpoint) {
    return { data: null, error: { type: "persistent", message: "no stream token" } };
  }

  const params = new URLSearchParams({ limit: String(config.batchSize) });
  if (cursor) params.set("cursor", cursor);
  if (since) params.set("since", String(since));

  const url = `${config.apiBaseUrl}${tokenEndpoint}?${params}`;

  // Pace requests to avoid rate limiting
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < MIN_REQUEST_INTERVAL_MS) {
    await new Promise((r) => setTimeout(r, MIN_REQUEST_INTERVAL_MS - elapsed));
  }
  lastRequestAt = Date.now();

  try {
    const res = await fetch(url, {
      headers: {
        "X-API-Key": config.apiKey,
        "X-Stream-Token": token,
      },
    });

    if (res.status === 403) {
      // Could be token expiry — try refresh
      const refreshed = await acquireToken(config);
      if (refreshed) {
        return { data: null, error: { type: "transient", message: "403 — token refreshed, retry" } };
      }
      return { data: null, error: { type: "persistent", message: "403 — token refresh failed" } };
    }

    if (res.status === 429) {
      return { data: null, error: { type: "transient", message: "HTTP 429" } };
    }

    if (res.status >= 500) {
      return { data: null, error: { type: "transient", message: `server error ${res.status}` } };
    }

    if (!res.ok) {
      return { data: null, error: { type: "persistent", message: `HTTP ${res.status}` } };
    }

    const raw = (await res.json()) as StreamApiResponse;
    // Normalize stream response to common ApiPageResponse
    const body: ApiPageResponse = {
      data: raw.data,
      hasMore: raw.pagination?.hasMore ?? false,
      nextCursor: raw.pagination?.nextCursor ?? null,
    };
    return { data: body, error: null };
  } catch (err) {
    return { data: null, error: { type: "transient", message: (err as Error).message } };
  }
}

export function hasToken(): boolean {
  return token !== null;
}
