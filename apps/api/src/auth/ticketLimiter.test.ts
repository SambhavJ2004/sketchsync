import { beforeEach, describe, expect, it } from "vitest";
import {
  TICKET_CAPACITY,
  TICKET_REFILL_PER_SEC,
  allowTicket,
  resetTicketLimiter,
} from "./ticketLimiter.js";

// A ticket endpoint that can be hammered is a token-minting oracle, so issuance
// is bounded per user. Synthetic clock — the limiter is timer-free.

beforeEach(() => resetTicketLimiter());

describe("ticket issuance limit", () => {
  it("allows a full burst, then refuses", () => {
    let allowed = 0;
    for (let i = 0; i < 50; i++) if (allowTicket("u1", 0)) allowed++;
    expect(allowed).toBe(TICKET_CAPACITY);
  });

  it("refills at the sustained rate", () => {
    for (let i = 0; i < TICKET_CAPACITY; i++) allowTicket("u1", 0);
    expect(allowTicket("u1", 0)).toBe(false);
    // 0.5/sec -> one more ticket after 2s, not before.
    expect(allowTicket("u1", 1_999)).toBe(false);
    expect(allowTicket("u1", 2_000)).toBe(true);
    expect(allowTicket("u1", 2_000)).toBe(false);
  });

  it("never accrues beyond capacity while idle", () => {
    allowTicket("u1", 0);
    let allowed = 0;
    for (let i = 0; i < 100; i++) if (allowTicket("u1", 3_600_000)) allowed++;
    expect(allowed).toBe(TICKET_CAPACITY);
  });

  it("is per-user — one user cannot exhaust another's budget", () => {
    for (let i = 0; i < 50; i++) allowTicket("noisy", 0);
    expect(allowTicket("noisy", 0)).toBe(false);
    expect(allowTicket("quiet", 0)).toBe(true);
  });

  it("admits a realistic reconnect flurry without tripping", () => {
    // Backoff is 0.5s..8s, so even the tightest legitimate loop is well inside
    // the burst allowance.
    let t = 0;
    let refused = 0;
    for (let i = 0; i < 8; i++) {
      if (!allowTicket("u1", t)) refused++;
      t += 500;
    }
    expect(refused).toBe(0);
  });

  it("bounds a hostile loop to the refill rate", () => {
    // Hammering every 10ms across a full 20s window (inclusive of t=20_000, so
    // exactly 20s of refill has elapsed by the last call).
    const SECONDS = 20;
    let allowed = 0;
    for (let t = 0; t <= SECONDS * 1000; t += 10) if (allowTicket("u1", t)) allowed++;
    // The burst, plus the sustained rate — 2000 attempts buy only this many.
    expect(allowed).toBe(TICKET_CAPACITY + SECONDS * TICKET_REFILL_PER_SEC);
  });
});
