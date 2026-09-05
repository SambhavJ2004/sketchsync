// Pure chunking for the `sync` snapshot.
//
// `maxPayload` bounds INBOUND frames only; an outbound snapshot is O(room size)
// with no ceiling. Measured: a 500-element realistic board is ~818 KiB and a
// room of 20 max-legal strokes is ~4.4 MiB, so a single frame is not viable.
// We emit ordered batches under a fixed byte budget and the client commits the
// scene once, on `done`.

import type { Element } from "@sketchsync/shared";

/**
 * Target bytes per sync frame. Well under the 1 MiB inbound cap so the same
 * ceiling would hold if these frames were ever echoed back through it.
 */
export const SYNC_CHUNK_BYTES = 256 * 1024;

/** Serialized size of one element as it will appear in the frame. */
export function elementBytes(el: Element): number {
  return Buffer.byteLength(JSON.stringify(el), "utf8");
}

/**
 * Split `elements` into ordered batches, each under `budget` bytes where
 * possible. Input order is preserved exactly, so partial state still renders
 * bottom-up in z-order.
 *
 * An element larger than the whole budget cannot be split, so it is emitted
 * ALONE in its own chunk rather than dropped — the schema permits a ~238 KB
 * element, and silently refusing to sync one would be a client/server
 * divergence of the kind this phase exists to remove.
 */
export function chunkElements(
  elements: readonly Element[],
  budget = SYNC_CHUNK_BYTES,
): Element[][] {
  if (elements.length === 0) return [];

  const chunks: Element[][] = [];
  let current: Element[] = [];
  let currentBytes = 0;

  for (const el of elements) {
    const bytes = elementBytes(el);
    if (current.length > 0 && currentBytes + bytes > budget) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(el);
    currentBytes += bytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
