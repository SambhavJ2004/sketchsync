// Per-socket token-bucket rate limiting.
//
// Pure and timer-free: every bucket refills lazily from the elapsed time handed
// to it, so there is nothing to schedule, nothing to clean up, and the whole
// module is unit-testable by passing a synthetic clock.
//
// Three buckets per socket, charged in two stages:
//
//   1. `global`, charged unconditionally BEFORE the frame is parsed. This is the
//      only bound that applies to garbage — unparseable frames and frames whose
//      type we don't recognise still pay it, so a flood of nonsense can never
//      buy unbounded parse work.
//   2. `cursor` / `mutation`, charged AFTER parsing, keyed off the real
//      `msg.type`. Classification is never guessed from the raw bytes: a crafted
//      frame could otherwise put "cursor" in a field value and be charged the
//      wrong bucket.
//
// `capacity` is burst tolerance; the refill rate is the sustained-throughput
// ceiling that actually bounds abuse (a flood converges to the refill rate no
// matter how large the capacity).

/**
 * Every inbound frame, charged pre-parse then REFUNDED once the frame proves
 * valid. Its only job is bounding pre-parse cost, so frames that parse and
 * validate must not consume it — otherwise it re-couples the class buckets and
 * a cursor burst could block a legitimate write the client already rendered.
 */
export const GLOBAL_CAPACITY = 400;
export const GLOBAL_REFILL_PER_SEC = 60;

/** Cursor frames. The client throttles to 50ms (=20/sec), so 25/sec has headroom. */
export const CURSOR_CAPACITY = 40;
export const CURSOR_REFILL_PER_SEC = 25;

/**
 * elementCreate/Update/Delete. Capacity is deliberately well above the refill
 * rate: legitimate client code emits synchronous bursts (multi-select delete,
 * and zIndex renormalization, which rewrites one update per element in the
 * room). Dropping those would lose writes the server never saw — unlike an LWW
 * drop, which is safe because server truth already won.
 */
export const MUTATION_CAPACITY = 300;
export const MUTATION_REFILL_PER_SEC = 20;

/**
 * Mutations are charged BY SIZE, not per frame: one token per 4 KiB (rounded
 * up, minimum 1). Counting frames alone lets 20 max-legal elements/sec through,
 * and a max-legal element is ~238 KB that takes seconds to persist — that would
 * starve the shared Neon pool for every room on the instance. Size-weighting
 * makes the admitted rate track what the database can actually absorb.
 */
export const MUTATION_BYTES_PER_TOKEN = 4096;

/** Violation score at which the socket is closed. */
export const MAX_VIOLATIONS = 500;
/**
 * Violations decay at this rate while the socket behaves, so the counter
 * measures INTENSITY, not lifetime total: 500 violations in ten seconds is
 * abuse, 500 spread over an eight-hour session is noise. A socket must sustain
 * more than this many violations per second to ever reach MAX_VIOLATIONS.
 */
export const VIOLATION_DECAY_PER_SEC = 10;
/** Never log violations for the same socket more often than this. */
export const WARN_INTERVAL_MS = 5_000;

export type FrameClass = "cursor" | "mutation";

/** Token bucket state. Mutated in place by `tryConsume`. */
export interface TokenBucket {
  tokens: number;
  readonly capacity: number;
  readonly refillPerSec: number;
  /** Timestamp (ms) the tokens were last refilled to. */
  lastMs: number;
}

export function createBucket(
  capacity: number,
  refillPerSec: number,
  nowMs: number,
): TokenBucket {
  return { tokens: capacity, capacity, refillPerSec, lastMs: nowMs };
}

/**
 * Refill from elapsed time, then take one token if available. Returns false when
 * the bucket is empty (caller drops the frame). Never schedules anything.
 */
export function tryConsume(bucket: TokenBucket, nowMs: number, cost = 1): boolean {
  const elapsedMs = nowMs - bucket.lastMs;
  if (elapsedMs > 0) {
    const refilled = bucket.tokens + (elapsedMs / 1000) * bucket.refillPerSec;
    bucket.tokens = Math.min(bucket.capacity, refilled);
    bucket.lastMs = nowMs;
  }
  if (bucket.tokens >= cost) {
    bucket.tokens -= cost;
    return true;
  }
  // A frame costing more than the ENTIRE bucket could never satisfy the check
  // above, so it would be permanently unsendable. Admit it from a full bucket
  // only, draining to zero — it pays the maximum the bucket can charge, and the
  // refill rate still bounds how often that can happen.
  if (cost > bucket.capacity && bucket.tokens >= bucket.capacity) {
    bucket.tokens = 0;
    return true;
  }
  return false;
}

/**
 * Return one token (clamped to capacity). Used to undo the global charge once a
 * frame has proven itself parseable AND schema-valid.
 */
export function refund(bucket: TokenBucket, amount = 1): void {
  bucket.tokens = Math.min(bucket.capacity, bucket.tokens + amount);
}

/** Tokens a mutation of `bytes` costs: 1 per 4 KiB, rounded up, minimum 1. */
export function mutationCost(bytes: number): number {
  return Math.max(1, Math.ceil(bytes / MUTATION_BYTES_PER_TOKEN));
}

/**
 * Every `type` the client protocol defines. Kept as a plain set so this module
 * stays dependency-free and synchronously testable; a unit test asserts it
 * matches `ClientMessage`'s discriminator values exactly, so it cannot drift.
 */
export const KNOWN_CLIENT_TYPES: ReadonlySet<string> = new Set([
  "join",
  "leave",
  "elementCreate",
  "elementUpdate",
  "elementDelete",
  "cursor",
]);

/**
 * Map a PARSED message type to its bucket, or null when the frame carries no
 * type the protocol defines. `type` is deliberately `unknown` — a hostile frame
 * can carry any JSON value here.
 *
 * null is the signal that global must KEEP its charge: an unclassifiable frame
 * is the only kind global is still responsible for (see `refundGlobal`).
 */
export function classOf(type: unknown): FrameClass | null {
  if (typeof type !== "string" || !KNOWN_CLIENT_TYPES.has(type)) return null;
  return type === "cursor" ? "cursor" : "mutation";
}

/** Per-socket limiter state. Lives on the connection; dies with it. */
export interface RateLimitState {
  global: TokenBucket;
  cursor: TokenBucket;
  mutation: TokenBucket;
  /** Decaying violation score (not a lifetime count). */
  violations: number;
  /** When `violations` was last updated, for decay. null = no violations yet. */
  lastViolationMs: number | null;
  /** Timestamp of the last emitted warning; null = never warned. Must NOT use 0
   *  as the sentinel — 0 is a legal timestamp and would re-warn on every frame. */
  lastWarnMs: number | null;
}

export function createRateLimitState(nowMs: number): RateLimitState {
  return {
    global: createBucket(GLOBAL_CAPACITY, GLOBAL_REFILL_PER_SEC, nowMs),
    cursor: createBucket(CURSOR_CAPACITY, CURSOR_REFILL_PER_SEC, nowMs),
    mutation: createBucket(MUTATION_CAPACITY, MUTATION_REFILL_PER_SEC, nowMs),
    violations: 0,
    lastViolationMs: null,
    lastWarnMs: null,
  };
}

export interface RateLimitDecision {
  /** False -> drop the frame silently. */
  allowed: boolean;
  /** Decayed violation score after this frame. */
  violations: number;
  /** True when the caller should emit a log line (throttled to one per 5s). */
  warn: boolean;
  /** True once the score exceeds MAX_VIOLATIONS — close the socket. */
  disconnect: boolean;
}

const ALLOWED: Omit<RateLimitDecision, "violations"> = {
  allowed: true,
  warn: false,
  disconnect: false,
};

/** Current violation score with decay applied, without mutating state. */
export function decayedViolations(state: RateLimitState, nowMs: number): number {
  if (state.lastViolationMs === null) return state.violations;
  const elapsedMs = Math.max(0, nowMs - state.lastViolationMs);
  const decayed =
    state.violations - (elapsedMs / 1000) * VIOLATION_DECAY_PER_SEC;
  return Math.max(0, decayed);
}

/**
 * Record one abusive frame: decay the old score, add 1, decide warn/disconnect.
 * Exported as `penalize` for callers outside the bucket checks (a frame that
 * fails JSON.parse is abuse too, and must count at the same weight).
 */
export function penalize(
  state: RateLimitState,
  nowMs: number,
): RateLimitDecision {
  return registerViolation(state, nowMs);
}

function registerViolation(
  state: RateLimitState,
  nowMs: number,
): RateLimitDecision {
  state.violations = decayedViolations(state, nowMs) + 1;
  state.lastViolationMs = nowMs;

  const warn =
    state.lastWarnMs === null || nowMs - state.lastWarnMs >= WARN_INTERVAL_MS;
  if (warn) state.lastWarnMs = nowMs;

  return {
    allowed: false,
    violations: state.violations,
    warn,
    disconnect: state.violations > MAX_VIOLATIONS,
  };
}

/**
 * Stage 1 — charge the global bucket. Call this on EVERY inbound frame, before
 * any parsing, so unparseable and unknown frames are bounded too.
 */
export function checkGlobal(
  state: RateLimitState,
  nowMs: number,
): RateLimitDecision {
  if (tryConsume(state.global, nowMs)) {
    return { ...ALLOWED, violations: decayedViolations(state, nowMs) };
  }
  return registerViolation(state, nowMs);
}

/**
 * Stage 2 — charge the per-class bucket, using the type read from the PARSED
 * message. Only reached by frames that already paid the global charge. Cursors
 * cost 1; mutations cost 1 token per 4 KiB of the raw frame.
 */
export function checkClass(
  state: RateLimitState,
  cls: FrameClass,
  nowMs: number,
  bytes: number,
): RateLimitDecision {
  const bucket = cls === "cursor" ? state.cursor : state.mutation;
  const cost = cls === "cursor" ? 1 : mutationCost(bytes);
  if (tryConsume(bucket, nowMs, cost)) {
    return { ...ALLOWED, violations: decayedViolations(state, nowMs) };
  }
  return registerViolation(state, nowMs);
}

/**
 * Stage 3 — the frame yielded a KNOWN type, so give the global token back.
 *
 * DO NOT move this later in the pipeline (e.g. after the class bucket or after
 * Zod). Once a frame is classifiable, the class bucket owns it, and a frame the
 * class bucket rejects already increments the violation counter — which closes
 * the socket at 500. That is a strictly stronger bound than global draining at
 * 400 and leaving the socket open, so keeping the charge here adds nothing
 * except re-coupling the buckets: a cursor burst would once again block a
 * legitimate write the client has already rendered.
 *
 * Global's sole remaining responsibility is frames that CANNOT be classified —
 * unparseable bodies and unknown/non-string types. Those keep the charge,
 * because nothing downstream will ever account for them.
 */
export function refundGlobal(state: RateLimitState): void {
  refund(state.global);
}
