import { describe, expect, it } from "vitest";
import type { Element, ElementData } from "@sketchsync/shared";
import { SYNC_CHUNK_BYTES, chunkElements, elementBytes } from "./syncChunks.js";

const ROOM = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const style = { stroke: "#111827", width: 2 };

function el(i: number, data: ElementData): Element {
  return {
    id: `33333333-3333-4333-8333-${String(i).padStart(12, "0")}`,
    roomId: ROOM,
    data,
    version: 1,
    createdBy: USER,
    zIndex: i + 1,
    createdAt: new Date(1_700_000_000_000 + i * 1000).toISOString(),
    updatedAt: new Date(1_700_000_000_000 + i * 1000).toISOString(),
    deleted: false,
  };
}

const small = (i: number): Element =>
  el(i, { type: "rect", x: i, y: i, width: 10, height: 10, style });

/** ~n points -> a deliberately large element. */
const pencil = (i: number, n: number): Element =>
  el(i, {
    type: "pencil",
    points: Array.from({ length: n }, (_, k) => ({ x: k * 1.5, y: k * 2.25 })),
    style,
  });

const totalBytes = (chunk: Element[]): number =>
  chunk.reduce((sum, e) => sum + elementBytes(e), 0);

describe("chunk boundary math", () => {
  it("returns no chunks for an empty room", () => {
    expect(chunkElements([])).toEqual([]);
  });

  it("keeps a small room in a single chunk", () => {
    const els = Array.from({ length: 50 }, (_, i) => small(i));
    const chunks = chunkElements(els);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(50);
  });

  it("never exceeds the budget when elements fit individually", () => {
    const els = Array.from({ length: 400 }, (_, i) => pencil(i, 200));
    const chunks = chunkElements(els);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(totalBytes(c)).toBeLessThanOrEqual(SYNC_CHUNK_BYTES);
  });

  it("preserves order exactly across chunk boundaries", () => {
    const els = Array.from({ length: 300 }, (_, i) => pencil(i, 150));
    const flat = chunkElements(els).flat();
    expect(flat.map((e) => e.id)).toEqual(els.map((e) => e.id));
    expect(flat).toHaveLength(els.length);
  });

  it("splits exactly at the boundary, not one element early or late", () => {
    const one = small(0);
    const size = elementBytes(one);
    const perChunk = 4;
    // Budget that fits exactly 4 of these.
    const budget = size * perChunk;
    const els = Array.from({ length: 10 }, (_, i) => small(i));
    const chunks = chunkElements(els, budget);
    expect(chunks.map((c) => c.length)).toEqual([4, 4, 2]);
  });

  it("emits an over-budget element ALONE rather than dropping it", () => {
    const huge = pencil(0, 10_000); // ~227 KB
    const budget = 1024; // far smaller than the element
    const chunks = chunkElements([small(1), huge, small(2)], budget);
    expect(chunks.flat()).toHaveLength(3); // nothing lost
    const hugeChunk = chunks.find((c) => c.some((e) => e.id === huge.id));
    expect(hugeChunk).toHaveLength(1);
  });

  it("never emits an empty chunk", () => {
    const els = Array.from({ length: 40 }, (_, i) => pencil(i, 5000));
    for (const c of chunkElements(els)) expect(c.length).toBeGreaterThan(0);
  });

  it("chunks a 20-max-legal-stroke room one element per frame", () => {
    // Each max-legal element is ~227 KB, so at a 256 KiB budget only one fits.
    const els = Array.from({ length: 20 }, (_, i) => pencil(i, 10_000));
    const chunks = chunkElements(els);
    expect(chunks).toHaveLength(20);
    for (const c of chunks) expect(c).toHaveLength(1);
  });

  it("every chunk stays under the 1 MiB inbound frame cap", () => {
    const els = Array.from({ length: 100 }, (_, i) => pencil(i, 3000));
    for (const c of chunkElements(els)) {
      expect(totalBytes(c)).toBeLessThan(1024 * 1024);
    }
  });
});
