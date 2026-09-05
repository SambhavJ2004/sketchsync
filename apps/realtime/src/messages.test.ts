import type { WebSocket } from "ws";
import { describe, expect, it } from "vitest";
import type { ServerMessage } from "@sketchsync/shared";
import { handleMessage } from "./messages.js";
import { RoomRegistry, type Conn } from "./registry.js";
import {
  CURSOR_CAPACITY,
  GLOBAL_CAPACITY,
  MUTATION_CAPACITY,
  createRateLimitState,
  mutationCost,
} from "./rateLimit.js";

// These drive the REAL handleMessage pipeline. Every path exercised here stops
// before authz reaches the database (bad JSON, bad schema, or "join a room
// first"), so no Prisma connection is needed — which is exactly where the
// refund policy lives.

interface Harness {
  conn: Conn;
  sent: ServerMessage[];
  registry: RoomRegistry;
}

function harness(): Harness {
  const sent: ServerMessage[] = [];
  const ws = {
    readyState: 1, // WebSocket.OPEN
    send: (payload: string) => sent.push(JSON.parse(payload) as ServerMessage),
    close: () => undefined,
  } as unknown as WebSocket;

  return {
    sent,
    registry: new RoomRegistry(),
    conn: {
      ws,
      userId: "user-1",
      name: "",
      avatarUrl: null,
      roomId: null,
      role: null,
      rate: createRateLimitState(Date.now()),
      parseErrorSent: false,
    },
  };
}

const CURSOR = JSON.stringify({ type: "cursor", x: 1, y: 2 });

describe("handleMessage refund policy", () => {
  it("refunds the global charge for a frame that parses AND validates", async () => {
    const h = harness();
    await handleMessage(h.conn, h.registry, CURSOR);
    // Valid frame -> global returned to full; the class bucket still paid.
    expect(h.conn.rate.global.tokens).toBe(GLOBAL_CAPACITY);
    expect(h.conn.rate.cursor.tokens).toBe(CURSOR_CAPACITY - 1);
  });

  it("refunds authz failures — they parsed and validated", async () => {
    const h = harness(); // roomId is null -> "Join a room first"
    await handleMessage(h.conn, h.registry, CURSOR);
    expect(h.sent.at(-1)).toEqual({ type: "error", message: "Join a room first" });
    expect(h.conn.rate.global.tokens).toBe(GLOBAL_CAPACITY);
  });

  it("does NOT refund unparseable frames", async () => {
    const h = harness();
    await handleMessage(h.conn, h.registry, "{not json");
    expect(h.sent.at(-1)).toEqual({ type: "error", message: "Invalid JSON" });
    expect(h.conn.rate.global.tokens).toBe(GLOBAL_CAPACITY - 1);
    // Never reached a class bucket.
    expect(h.conn.rate.cursor.tokens).toBe(CURSOR_CAPACITY);
    expect(h.conn.rate.mutation.tokens).toBe(MUTATION_CAPACITY);
  });

  it("DOES refund known-type-but-schema-invalid frames", async () => {
    const h = harness();
    // Classifiable, so global lets go; the cursor bucket owns it from here.
    await handleMessage(h.conn, h.registry, '{"type":"cursor","x":"nope"}');
    expect(h.sent.at(-1)).toEqual({ type: "error", message: "Invalid message" });
    expect(h.conn.rate.global.tokens).toBe(GLOBAL_CAPACITY);
    expect(h.conn.rate.cursor.tokens).toBe(CURSOR_CAPACITY - 1);
  });

  it("does NOT refund unknown-type frames (charged as mutations)", async () => {
    const h = harness();
    await handleMessage(h.conn, h.registry, '{"type":"bogus"}');
    expect(h.sent.at(-1)).toEqual({ type: "error", message: "Invalid message" });
    expect(h.conn.rate.global.tokens).toBe(GLOBAL_CAPACITY - 1);
    expect(h.conn.rate.mutation.tokens).toBe(MUTATION_CAPACITY - 1);
  });

  it("counts a parse failure as a violation immediately", async () => {
    const h = harness();
    await handleMessage(h.conn, h.registry, "{not json");
    // Previously this only scored once global had drained (~400 frames later).
    expect(h.conn.rate.violations).toBe(1);
  });

  it("replies to malformed JSON at most ONCE per socket", async () => {
    const h = harness();
    for (let i = 0; i < 200; i++) {
      await handleMessage(h.conn, h.registry, `{not json ${i}`);
    }
    const replies = h.sent.filter(
      (m) => m.type === "error" && m.message === "Invalid JSON",
    );
    expect(replies).toHaveLength(1);
    // Still fully scored as abuse — only the outbound chatter is suppressed.
    expect(h.conn.rate.violations).toBeGreaterThan(100);
  });

  it("frames that fully validate cost global nothing", async () => {
    const h = harness();
    // Within the cursor budget, so every frame reaches Zod and is refunded.
    for (let i = 0; i < CURSOR_CAPACITY; i++) {
      await handleMessage(h.conn, h.registry, CURSOR);
    }
    expect(h.conn.rate.global.tokens).toBe(GLOBAL_CAPACITY);
    // Real clock: a little refill accrues across the awaits, so not exactly 0.
    expect(h.conn.rate.cursor.tokens).toBeLessThan(1);
  });

  it("a large class-rejected flood leaves global UNTOUCHED", async () => {
    // The whole point of moving the refund to classification: a cursor flood is
    // the cursor bucket's problem (and the violation counter's), never global's.
    const h = harness();
    for (let i = 0; i < GLOBAL_CAPACITY + 50; i++) {
      await handleMessage(h.conn, h.registry, CURSOR);
    }
    expect(h.conn.rate.cursor.tokens).toBeLessThan(1); // cursor bucket absorbed it
    expect(h.conn.rate.global.tokens).toBe(GLOBAL_CAPACITY); // global never dipped
    expect(h.conn.rate.violations).toBeGreaterThan(0); // still scored as abuse
  });

  it("an unparseable flood of the SAME size DOES deplete global", async () => {
    // Same frame count, opposite outcome — this is the discriminator.
    const h = harness();
    for (let i = 0; i < GLOBAL_CAPACITY + 50; i++) {
      await handleMessage(h.conn, h.registry, `{junk ${i}`);
    }
    expect(h.conn.rate.global.tokens).toBeLessThan(1);
    // Untouched: garbage never reaches a class bucket.
    expect(h.conn.rate.cursor.tokens).toBe(CURSOR_CAPACITY);
  });

  it("a garbage flood DOES drain global, bounding pre-parse cost", async () => {
    const h = harness();
    for (let i = 0; i < GLOBAL_CAPACITY + 50; i++) {
      await handleMessage(h.conn, h.registry, `{junk ${i}`);
    }
    expect(h.conn.rate.global.tokens).toBeLessThan(1);
    expect(h.conn.rate.violations).toBeGreaterThan(0);
  });

  it("charges a large mutation by size, not per frame", async () => {
    const h = harness();
    const points = Array.from({ length: 4000 }, (_, i) => ({ x: i, y: i }));
    const frame = JSON.stringify({
      type: "elementCreate",
      element: {
        id: "00000000-0000-4000-8000-000000000000",
        data: { type: "pencil", points, style: { stroke: "#111827", width: 2 } },
        version: 1,
      },
    });
    const expected = mutationCost(Buffer.byteLength(frame, "utf8"));
    expect(expected).toBeGreaterThan(1);

    await handleMessage(h.conn, h.registry, frame);
    expect(h.conn.rate.mutation.tokens).toBe(MUTATION_CAPACITY - expected);
    // Valid frame -> global refunded even though it was big.
    expect(h.conn.rate.global.tokens).toBe(GLOBAL_CAPACITY);
  });
});
