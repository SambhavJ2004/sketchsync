import { describe, expect, it } from "vitest";
import { ClientMessage } from "@sketchsync/shared";
import {
  CURSOR_CAPACITY,
  CURSOR_REFILL_PER_SEC,
  GLOBAL_CAPACITY,
  GLOBAL_REFILL_PER_SEC,
  MAX_VIOLATIONS,
  MUTATION_BYTES_PER_TOKEN,
  MUTATION_CAPACITY,
  MUTATION_REFILL_PER_SEC,
  VIOLATION_DECAY_PER_SEC,
  KNOWN_CLIENT_TYPES,
  checkClass,
  checkGlobal,
  classOf,
  createBucket,
  createRateLimitState,
  decayedViolations,
  mutationCost,
  refund,
  refundGlobal,
  tryConsume,
} from "./rateLimit.js";

// Every test drives a SYNTHETIC clock: the limiter is pure and timer-free, so
// elapsed time is a parameter, never something we wait for.

/** A typical small frame (cursor / single-shape mutation): costs exactly 1 token. */
const SMALL = 100;

describe("token bucket refill math", () => {
  it("starts full at capacity", () => {
    expect(createBucket(10, 5, 1000).tokens).toBe(10);
  });

  it("drains one token per consume, then refuses at the same instant", () => {
    const b = createBucket(10, 5, 1000);
    for (let i = 0; i < 10; i++) expect(tryConsume(b, 1000)).toBe(true);
    expect(tryConsume(b, 1000)).toBe(false);
    expect(b.tokens).toBeLessThan(1);
  });

  it("refills exactly refillPerSec per second", () => {
    const b = createBucket(10, 5, 1000);
    for (let i = 0; i < 10; i++) tryConsume(b, 1000);
    let allowed = 0;
    for (let i = 0; i < 20; i++) if (tryConsume(b, 2000)) allowed++;
    expect(allowed).toBe(5); // +1000ms at 5/sec, not 6
  });

  it("refills proportionally for partial elapsed time (200ms @ 25/s = 5)", () => {
    const b = createBucket(40, 25, 0);
    for (let i = 0; i < 40; i++) tryConsume(b, 0);
    let allowed = 0;
    for (let i = 0; i < 20; i++) if (tryConsume(b, 200)) allowed++;
    expect(allowed).toBe(5);
  });

  it("never accrues beyond capacity while idle", () => {
    const b = createBucket(10, 5, 0);
    tryConsume(b, 0);
    let allowed = 0;
    for (let i = 0; i < 100; i++) if (tryConsume(b, 3_600_000)) allowed++;
    expect(allowed).toBe(10); // an hour idle caps at 10, not 18000
  });

  it("does not grant tokens when the clock goes backwards", () => {
    const b = createBucket(10, 5, 10_000);
    for (let i = 0; i < 10; i++) tryConsume(b, 10_000);
    expect(tryConsume(b, 5_000)).toBe(false);
  });
});

describe("burst then sustain", () => {
  it("admits a full burst, then throttles to exactly the refill rate", () => {
    const b = createBucket(MUTATION_CAPACITY, MUTATION_REFILL_PER_SEC, 0);
    let burst = 0;
    for (let i = 0; i < 500; i++) if (tryConsume(b, 0)) burst++;
    expect(burst).toBe(MUTATION_CAPACITY);

    let sustained = 0;
    for (let sec = 1; sec <= 10; sec++) {
      for (let i = 0; i < 100; i++) if (tryConsume(b, sec * 1000)) sustained++;
    }
    expect(sustained).toBe(MUTATION_REFILL_PER_SEC * 10);
  });

  it("caps a 500-frame cursor flood at capacity", () => {
    const b = createBucket(CURSOR_CAPACITY, CURSOR_REFILL_PER_SEC, 0);
    let allowed = 0;
    for (let i = 0; i < 500; i++) if (tryConsume(b, 0)) allowed++;
    expect(allowed).toBe(CURSOR_CAPACITY);
  });
});

describe("bucket independence", () => {
  it("draining cursor leaves mutation untouched", () => {
    const s = createRateLimitState(0);
    for (let i = 0; i < 500; i++) checkClass(s, "cursor", 0, SMALL);
    expect(s.cursor.tokens).toBeLessThan(1);
    expect(s.mutation.tokens).toBe(MUTATION_CAPACITY);
    expect(checkClass(s, "mutation", 0, SMALL).allowed).toBe(true);
  });

  it("draining mutation leaves cursor untouched", () => {
    const s = createRateLimitState(0);
    for (let i = 0; i < 500; i++) checkClass(s, "mutation", 0, SMALL);
    expect(s.mutation.tokens).toBeLessThan(1);
    expect(s.cursor.tokens).toBe(CURSOR_CAPACITY);
    expect(checkClass(s, "cursor", 0, SMALL).allowed).toBe(true);
  });
});

describe("global bucket", () => {
  it("is charged on every frame regardless of type", () => {
    const s = createRateLimitState(0);
    let allowed = 0;
    for (let i = 0; i < 1000; i++) if (checkGlobal(s, 0).allowed) allowed++;
    expect(allowed).toBe(GLOBAL_CAPACITY);
  });

  it("bounds a flood of unparseable frames (they never reach a class bucket)", () => {
    const s = createRateLimitState(0);
    let admitted = 0;
    for (let i = 0; i < 500; i++) if (checkGlobal(s, 0).allowed) admitted++;
    expect(admitted).toBe(GLOBAL_CAPACITY);
    expect(500 - admitted).toBeGreaterThan(0);
    // Garbage costs nothing from the class buckets — they stay full.
    expect(s.cursor.tokens).toBe(CURSOR_CAPACITY);
    expect(s.mutation.tokens).toBe(MUTATION_CAPACITY);
  });

  it("sustains the global refill rate after the burst", () => {
    const s = createRateLimitState(0);
    for (let i = 0; i < GLOBAL_CAPACITY; i++) checkGlobal(s, 0);
    let sustained = 0;
    for (let sec = 1; sec <= 5; sec++) {
      for (let i = 0; i < 200; i++) if (checkGlobal(s, sec * 1000).allowed) sustained++;
    }
    expect(sustained).toBe(GLOBAL_REFILL_PER_SEC * 5);
  });

  it("has headroom for 20/s cursors plus a full mutation burst", () => {
    expect(GLOBAL_CAPACITY).toBeGreaterThan(MUTATION_CAPACITY + 20);
  });
});

describe("classification uses the parsed type, never the raw bytes", () => {
  it("maps the real message types", () => {
    expect(classOf("cursor")).toBe("cursor");
    expect(classOf("elementCreate")).toBe("mutation");
    expect(classOf("elementUpdate")).toBe("mutation");
    expect(classOf("elementDelete")).toBe("mutation");
    expect(classOf("join")).toBe("mutation");
  });

  it("returns null for unknown or non-string types (global keeps the charge)", () => {
    expect(classOf("bogus")).toBeNull();
    expect(classOf(undefined)).toBeNull();
    expect(classOf(null)).toBeNull();
    expect(classOf({})).toBeNull();
    expect(classOf(42)).toBeNull();
    expect(classOf("Cursor")).toBeNull(); // case-sensitive
  });

  it("its known-type set matches the ClientMessage schema exactly", () => {
    // Drift guard: rateLimit stays dependency-free, so this test — not the
    // module — is what ties the set to the shared protocol definition.
    const fromSchema = new Set(
      ClientMessage.options.map((o) => o.shape.type.value as string),
    );
    expect(new Set(KNOWN_CLIENT_TYPES)).toEqual(fromSchema);
  });

  it("a frame with 'cursor' in a FIELD VALUE is charged as a mutation", () => {
    // The exact spoof the old substring scan would have misclassified.
    const spoof = {
      type: "elementCreate",
      element: {
        id: "00000000-0000-4000-8000-000000000000",
        data: { type: "text", x: 0, y: 0, text: '"type":"cursor"', fontSize: 24 },
        version: 1,
      },
    };
    const s = createRateLimitState(0);
    expect(classOf(spoof.type)).toBe("mutation");
    checkClass(s, "mutation", 0, SMALL);
    expect(s.mutation.tokens).toBe(MUTATION_CAPACITY - 1);
    expect(s.cursor.tokens).toBe(CURSOR_CAPACITY); // cursor budget NOT spent
  });
});

describe("violations: warn throttling, decay, disconnect", () => {
  it("warns at most once per 5s window", () => {
    const s = createRateLimitState(0);
    for (let i = 0; i < CURSOR_CAPACITY; i++) checkClass(s, "cursor", 0, SMALL);
    let warns = 0;
    for (let i = 0; i < 200; i++) if (checkClass(s, "cursor", 0, SMALL).warn) warns++;
    expect(warns).toBe(1);

    let mid = 0;
    for (let i = 0; i < 500; i++) if (checkClass(s, "cursor", 4999, SMALL).warn) mid++;
    expect(mid).toBe(0);

    let later = 0;
    for (let i = 0; i < 500; i++) if (checkClass(s, "cursor", 5000, SMALL).warn) later++;
    expect(later).toBe(1);
  });

  it("does not treat timestamp 0 as 'never warned' (lastWarnMs sentinel)", () => {
    // Regression: using 0 as the sentinel re-warned on EVERY violation at t=0.
    const s = createRateLimitState(0);
    expect(s.lastWarnMs).toBeNull();
    for (let i = 0; i < CURSOR_CAPACITY; i++) checkClass(s, "cursor", 0, SMALL);
    const first = checkClass(s, "cursor", 0, SMALL);
    expect(first.warn).toBe(true);
    expect(s.lastWarnMs).toBe(0);
    let extra = 0;
    for (let i = 0; i < 100; i++) if (checkClass(s, "cursor", 0, SMALL).warn) extra++;
    expect(extra).toBe(0);
  });

  it("disconnects only once the score exceeds MAX_VIOLATIONS", () => {
    const s = createRateLimitState(0);
    let firstDisconnectAt = -1;
    for (let i = 0; i < 2000; i++) {
      const d = checkClass(s, "cursor", 0, SMALL);
      if (!d.allowed && d.disconnect && firstDisconnectAt < 0) {
        firstDisconnectAt = Math.round(d.violations);
      }
    }
    expect(firstDisconnectAt).toBe(MAX_VIOLATIONS + 1);
  });

  it("decays the score on sustained compliance", () => {
    const s = createRateLimitState(0);
    for (let i = 0; i < CURSOR_CAPACITY + 100; i++) checkClass(s, "cursor", 0, SMALL);
    expect(s.violations).toBe(100);
    // 5s of good behaviour at 10/sec decay -> 50 forgiven.
    expect(decayedViolations(s, 5_000)).toBe(100 - 5 * VIOLATION_DECAY_PER_SEC);
    // 10s -> fully forgiven, never negative.
    expect(decayedViolations(s, 10_000)).toBe(0);
    expect(decayedViolations(s, 60_000)).toBe(0);
  });

  it("a slow trickle of violations never disconnects a long-lived socket", () => {
    // 500 violations spread over 8 hours must NOT close the socket, whereas the
    // same 500 in one instant does. This is the whole point of decaying.
    const s = createRateLimitState(0);
    let disconnected = false;
    for (let i = 0; i < 500; i++) {
      for (let k = 0; k < CURSOR_CAPACITY + 1; k++) {
        const d = checkClass(s, "cursor", i * 60_000, SMALL); // one burst per minute
        if (!d.allowed && d.disconnect) disconnected = true;
      }
    }
    expect(disconnected).toBe(false);
  });

  it("an intense flood still disconnects despite decay", () => {
    const s = createRateLimitState(0);
    let disconnected = false;
    // ~1000 violations/sec for 2s: far above the 10/sec decay.
    for (let ms = 0; ms < 2000 && !disconnected; ms++) {
      for (let k = 0; k < 1000; k++) {
        const d = checkGlobal(s, ms);
        if (!d.allowed && d.disconnect) {
          disconnected = true;
          break;
        }
      }
    }
    expect(disconnected).toBe(true);
  });
});

describe("global refund", () => {
  it("returns exactly one token", () => {
    const b = createBucket(10, 5, 0);
    tryConsume(b, 0);
    expect(b.tokens).toBe(9);
    refund(b);
    expect(b.tokens).toBe(10);
  });

  it("clamps at capacity — refunds can never inflate a bucket", () => {
    const b = createBucket(10, 5, 0);
    for (let i = 0; i < 50; i++) refund(b);
    expect(b.tokens).toBe(10);

    const s = createRateLimitState(0);
    for (let i = 0; i < 50; i++) refundGlobal(s);
    expect(s.global.tokens).toBe(GLOBAL_CAPACITY);
  });

  it("makes a stream of valid frames cost the global bucket nothing", () => {
    // charge -> validate -> refund, repeated far beyond global capacity.
    const s = createRateLimitState(0);
    for (let i = 0; i < 5000; i++) {
      expect(checkGlobal(s, 0).allowed).toBe(true);
      refundGlobal(s);
    }
    expect(s.global.tokens).toBe(GLOBAL_CAPACITY);
    expect(s.violations).toBe(0);
  });
});

describe("size-weighted mutation cost", () => {
  it("charges 1 token per 4 KiB, rounded up, minimum 1", () => {
    expect(mutationCost(0)).toBe(1);
    expect(mutationCost(1)).toBe(1);
    expect(mutationCost(MUTATION_BYTES_PER_TOKEN)).toBe(1);
    expect(mutationCost(MUTATION_BYTES_PER_TOKEN + 1)).toBe(2);
    expect(mutationCost(2 * MUTATION_BYTES_PER_TOKEN)).toBe(2);
    expect(mutationCost(237_950)).toBe(59); // the measured max-legal element
  });

  it("cursors are always 1 token regardless of size", () => {
    const s = createRateLimitState(0);
    checkClass(s, "cursor", 0, 500_000);
    expect(s.cursor.tokens).toBe(CURSOR_CAPACITY - 1);
  });

  it("admits 5 max-legal elements from a full bucket, then throttles", () => {
    const s = createRateLimitState(0);
    const MAX_EL = 237_950;
    let admitted = 0;
    for (let i = 0; i < 10; i++) {
      if (checkClass(s, "mutation", 0, MAX_EL).allowed) admitted++;
    }
    expect(admitted).toBe(5); // 5 * 59 = 295 <= 300
    expect(s.mutation.tokens).toBeLessThan(mutationCost(MAX_EL));
  });

  it("sustains ~1 max-legal element per 3s (matches DB persist time)", () => {
    const s = createRateLimitState(0);
    const MAX_EL = 237_950;
    for (let i = 0; i < 10; i++) checkClass(s, "mutation", 0, MAX_EL); // drain
    let admitted = 0;
    for (let sec = 1; sec <= 30; sec++) {
      for (let i = 0; i < 5; i++) {
        if (checkClass(s, "mutation", sec * 1000, MAX_EL).allowed) admitted++;
      }
    }
    // 30s * 20 tokens/s = 600 tokens / 59 per element ~= 10 elements.
    expect(admitted).toBe(10);
  });

  it("a big mutation does not consume the cursor budget", () => {
    const s = createRateLimitState(0);
    checkClass(s, "mutation", 0, 237_950);
    expect(s.cursor.tokens).toBe(CURSOR_CAPACITY);
  });
});

describe("cost greater than capacity", () => {
  it("admits an oversized frame ONLY from a full bucket, draining it", () => {
    const b = createBucket(10, 5, 0);
    expect(tryConsume(b, 0, 15)).toBe(true); // full -> admitted
    expect(b.tokens).toBe(0);
    expect(tryConsume(b, 0, 15)).toBe(false); // now empty -> refused
  });

  it("refuses an oversized frame when the bucket is merely partial", () => {
    const b = createBucket(10, 5, 0);
    tryConsume(b, 0); // 9 tokens: not full
    expect(tryConsume(b, 0, 15)).toBe(false);
    expect(b.tokens).toBe(9); // and costs nothing
  });

  it("is unreachable in production: maxPayload caps cost below capacity", () => {
    // 1 MiB / 4 KiB = 256 tokens, under MUTATION_CAPACITY — so a legal frame is
    // always payable by a partially-full bucket. The rule above is a guard for
    // future constant changes, not live behaviour.
    expect(mutationCost(1024 * 1024)).toBeLessThan(MUTATION_CAPACITY);
  });
});
