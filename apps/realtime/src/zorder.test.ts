import { describe, expect, it } from "vitest";
import {
  MIN_GAP,
  compareZ,
  minGap,
  needsRenormalize,
  renormalize,
  resolveZ,
  type ZRow,
} from "./zorder.js";

const t = (ms: number): Date => new Date(1_700_000_000_000 + ms);

function rows(zs: number[]): ZRow[] {
  return zs.map((zIndex, i) => ({
    id: `id-${String(i).padStart(4, "0")}`,
    zIndex,
    createdAt: t(i * 1000),
  }));
}

describe("gap detection / renormalization trigger", () => {
  it("does not trigger on a healthy board", () => {
    expect(needsRenormalize(rows([1, 2, 3, 4, 5]))).toBe(false);
    expect(minGap(rows([1, 2, 3]))).toBe(1);
  });

  it("does not trigger for fewer than two elements", () => {
    expect(needsRenormalize(rows([]))).toBe(false);
    expect(needsRenormalize(rows([7]))).toBe(false);
  });

  it("triggers exactly at the threshold boundary (strict <)", () => {
    // Anchored at 0 so `0 + MIN_GAP` is exactly MIN_GAP in float64 — anchoring
    // at 1 would not be, and the gap would land just under the threshold.
    expect(minGap(rows([0, MIN_GAP]))).toBe(MIN_GAP);
    expect(needsRenormalize(rows([0, MIN_GAP]))).toBe(false); // == is fine
    expect(needsRenormalize(rows([0, MIN_GAP / 2]))).toBe(true); // < is not
  });

  it("triggers after repeated midpoint insertion collapses a gap", () => {
    // Model what the client does: repeatedly insert halfway between 1 and 2.
    let lo = 1;
    const hi = 2;
    let nudges = 0;
    while (!needsRenormalize(rows([lo, (lo + hi) / 2, hi])) && nudges < 100) {
      lo = (lo + hi) / 2;
      nudges++;
    }
    expect(nudges).toBeGreaterThan(15);
    expect(nudges).toBeLessThan(30); // ~20 halvings of a gap of 1 to reach 1e-6
  });

  it("detects a fully collapsed (duplicate) gap", () => {
    expect(needsRenormalize(rows([1, 1, 2]))).toBe(true);
    expect(minGap(rows([1, 1, 2]))).toBe(0);
  });
});

describe("renormalize", () => {
  it("assigns clean sequential 1..N", () => {
    const out = renormalize(rows([0.001, 0.002, 5, 9]));
    expect(out.map((a) => a.zIndex)).toEqual([1, 2, 3, 4]);
  });

  it("preserves board order EXACTLY across the rewrite", () => {
    const input = rows([3, 1.5, 1.5000001, 99, -4]);
    const before = [...input].sort(compareZ).map((r) => r.id);

    const assignments = renormalize(input);
    const zById = new Map(assignments.map((a) => [a.id, a.zIndex]));
    const after = [...input]
      .map((r) => ({ ...r, zIndex: zById.get(r.id) ?? r.zIndex }))
      .sort(compareZ)
      .map((r) => r.id);

    expect(after).toEqual(before);
  });

  it("breaks zIndex ties by createdAt, then id — same rule as the client", () => {
    const tied: ZRow[] = [
      { id: "b", zIndex: 1, createdAt: t(2000) },
      { id: "a", zIndex: 1, createdAt: t(1000) },
      { id: "c", zIndex: 1, createdAt: t(2000) },
    ];
    // "a" sorts first and already holds zIndex 1, so it needs no change.
    const out = renormalize(tied);
    expect(out).toEqual([
      { id: "b", zIndex: 2 },
      { id: "c", zIndex: 3 },
    ]);
  });

  it("emits ONLY the rows whose value actually changes", () => {
    // Already 1..N except the last -> exactly one assignment.
    const input = rows([1, 2, 3, 7]);
    const out = renormalize(input);
    expect(out).toEqual([{ id: "id-0003", zIndex: 4 }]);
  });

  it("is a no-op on an already-normalized board", () => {
    expect(renormalize(rows([1, 2, 3, 4, 5]))).toEqual([]);
  });

  it("handles a large board without reordering", () => {
    const zs = Array.from({ length: 400 }, (_, i) => 1 + i * 1e-7); // collapsed
    const input = rows(zs);
    expect(needsRenormalize(input)).toBe(true);
    // Element 0 already sits at zIndex 1, so 399 of 400 actually change.
    const out = renormalize(input);
    expect(out).toHaveLength(399);
    expect(out.map((a) => a.id)).toEqual(input.slice(1).map((r) => r.id));
    expect(out.at(-1)?.zIndex).toBe(400);

    // The resulting board is healthy and in the original order.
    const zById = new Map(out.map((a) => [a.id, a.zIndex]));
    const after = input.map((r) => ({ ...r, zIndex: zById.get(r.id) ?? r.zIndex }));
    expect(after.map((r) => r.id)).toEqual(input.map((r) => r.id));
    expect(needsRenormalize(after)).toBe(false);
  });
});

describe("resolveZ — client zIndex is advisory, server re-places on collision", () => {
  it("passes a non-colliding value straight through", () => {
    expect(resolveZ([1, 2, 3], 2.5, 5)).toBe(2.5);
    expect(resolveZ([], 7, 1)).toBe(7);
  });

  it("moving DOWN settles between the collision and the value below it", () => {
    // Element at 5 wants 2 (already taken); next distinct below 2 is 1.
    expect(resolveZ([1, 2, 3], 2, 5)).toBe(1.5);
  });

  it("moving UP settles between the collision and the value above it", () => {
    // Element at 1 wants 2 (taken); next distinct above 2 is 3.
    expect(resolveZ([2, 3, 4], 2, 1)).toBe(2.5);
  });

  it("goes outside the range when there is no neighbour in that direction", () => {
    expect(resolveZ([1, 2, 3], 1, 9)).toBe(0); // down, nothing below 1
    expect(resolveZ([1, 2, 3], 3, 0)).toBe(4); // up, nothing above 3
  });

  it("never returns a value that collides with another element", () => {
    const others = [1, 2, 3, 4, 5];
    for (const desired of others) {
      for (const currentZ of [0, 6]) {
        const out = resolveZ(others, desired, currentZ);
        expect(others).not.toContain(out);
      }
    }
  });

  it("preserves the user's intent: down lands below, up lands above", () => {
    const others = [10, 20, 30];
    expect(resolveZ(others, 20, 30)).toBeLessThan(20); // was above, moving down
    expect(resolveZ(others, 20, 10)).toBeGreaterThan(20); // was below, moving up
  });

  it("returns the desired value unchanged when no gap is representable", () => {
    // Neighbours adjacent in float terms: the midpoint cannot separate them.
    const a = 1;
    const b = a + Number.EPSILON;
    const out = resolveZ([a, b], b, 9); // moving down onto b, gap a..b is atomic
    expect(out).toBe(b);
    // The caller's MIN_GAP check then sees the collision and renormalizes.
    const rows = [a, b, b].map((zIndex, i) => ({
      id: `id-${i}`,
      zIndex,
      createdAt: t(i * 1000),
    }));
    expect(needsRenormalize(rows)).toBe(true);
  });

  it("resolves the exact two-client race: both nudge into the same gap", () => {
    // Board [1,2,3]. Client A moves X down into the 1..2 gap -> 1.5.
    // Client B, from the same stale snapshot, proposes 1.5 for element Y.
    const afterA = [1, 1.5, 2, 3];
    const bPlaced = resolveZ(afterA, 1.5, 3);
    expect(bPlaced).not.toBe(1.5);
    expect(afterA).not.toContain(bPlaced);
    // Both remain distinct and ordered.
    const final = [...afterA, bPlaced].sort((p, q) => p - q);
    expect(new Set(final).size).toBe(final.length);
  });
});
