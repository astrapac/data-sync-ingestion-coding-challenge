import { log } from "./logger.js";
import type { Config } from "./config.js";
import type { ApiPageResponse, StreamApiResponse } from "./types.js";

let rateLimitRemaining: number | null = null;
let rateLimitResetsAt: number | null = null; // Absolute time (ms) when rate limit window resets

async function waitForRateLimit(): Promise<void> {
  if (rateLimitRemaining !== null && rateLimitRemaining <= 1 && rateLimitResetsAt) {
    const waitMs = rateLimitResetsAt - Date.now();
    if (waitMs > 0) {
      log.info("rate limit: waiting", { waitMs: Math.round(waitMs) });
      await new Promise((r) => setTimeout(r, waitMs + 500));
    }
  }
}

function parseRateLimitHeaders(headers: Headers): void {
  const remaining = headers.get("x-ratelimit-remaining");
  const reset = headers.get("x-ratelimit-reset");
  if (remaining !== null) rateLimitRemaining = parseInt(remaining, 10);
  if (reset !== null) {
    const resetVal = parseInt(reset, 10);
    // Reset header could be relative (seconds until reset) or absolute (unix timestamp)
    // If value < 1000000, treat as relative seconds; otherwise as unix timestamp
    rateLimitResetsAt = resetVal < 1_000_000
      ? Date.now() + resetVal * 1000
      : resetVal * 1000;
  }
}

export async function fetchPage(
  config: Config,
  cursor?: string | null,
  since?: number | null,
): Promise<{ data: ApiPageResponse; error: null } | { data: null; error: string }> {
  await waitForRateLimit();

  const params = new URLSearchParams({ limit: String(config.batchSize) });
  if (cursor) params.set("cursor", cursor);
  if (since) params.set("since", String(since));

  const url = `${config.apiBaseUrl}/api/v1/events?${params}`;

  try {
    const res = await fetch(url, {
      headers: { "X-API-Key": config.apiKey },
    });

    parseRateLimitHeaders(res.headers);

    if (res.status === 429) {
      const retryAfter = res.headers.get("retry-after");
      const waitSec = retryAfter ? parseInt(retryAfter, 10) : 30;
      log.warn("rate limited (429)", { retryAfterSeconds: waitSec });
      await new Promise((r) => setTimeout(r, waitSec * 1000));
      return { data: null, error: "rate limited — retry" };
    }

    if (!res.ok) {
      return { data: null, error: `HTTP ${res.status} ${res.statusText}` };
    }

    const raw = (await res.json()) as StreamApiResponse;
    const body: ApiPageResponse = {
      data: raw.data,
      hasMore: raw.pagination?.hasMore ?? false,
      nextCursor: raw.pagination?.nextCursor ?? null,
    };
    return { data: body, error: null };
  } catch (err) {
    return { data: null, error: (err as Error).message };
  }
}
