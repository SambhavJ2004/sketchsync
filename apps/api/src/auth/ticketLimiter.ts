// Per-user rate limit for WebSocket ticket issuance.
//
// A ticket endpoint that can be hammered is a token-minting oracle, so issuance
// is bounded per user rather than per socket.
//
// Deliberately NOT reusing apps/realtime's rateLimit.ts: that limiter is
// per-SOCKET state with violation scoring and message classes, released when the
// connection closes. This is per-USER state that outlives any one request and
// must be swept. Same lazy-refill idea, different lifecycle — sharing the module
// would mean exporting a shape neither side wants.

/** Burst allowance: covers a reconnect flurry without minting unboundedly. */
export const TICKET_CAPACITY = 10;
/** Sustained rate: 0.5/sec = 30/min, far above any legitimate client. */
export const TICKET_REFILL_PER_SEC = 0.5;
/** Drop a user's bucket after this long idle, so the Map cannot grow forever. */
const IDLE_EVICT_MS = 10 * 60 * 1000;

interface Bucket {
  tokens: number;
  lastMs: number;
}

const buckets = new Map<string, Bucket>();
let lastSweepMs = 0;

function sweep(nowMs: number): void {
  if (nowMs - lastSweepMs < IDLE_EVICT_MS) return;
  lastSweepMs = nowMs;
  for (const [userId, b] of buckets) {
    if (nowMs - b.lastMs > IDLE_EVICT_MS) buckets.delete(userId);
  }
}

/**
 * Take one token for `userId`. Returns true when issuance is allowed. Refill is
 * computed from elapsed time on each call — no timers.
 */
export function allowTicket(userId: string, nowMs: number = Date.now()): boolean {
  sweep(nowMs);
  let b = buckets.get(userId);
  if (!b) {
    b = { tokens: TICKET_CAPACITY, lastMs: nowMs };
    buckets.set(userId, b);
  } else {
    const elapsedMs = nowMs - b.lastMs;
    if (elapsedMs > 0) {
      b.tokens = Math.min(
        TICKET_CAPACITY,
        b.tokens + (elapsedMs / 1000) * TICKET_REFILL_PER_SEC,
      );
      b.lastMs = nowMs;
    }
  }
  if (b.tokens >= 1) {
    b.tokens -= 1;
    return true;
  }
  return false;
}

/** Test seam: forget all buckets. */
export function resetTicketLimiter(): void {
  buckets.clear();
  lastSweepMs = 0;
}
