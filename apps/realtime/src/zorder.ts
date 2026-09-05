// Pure z-order math for SERVER-side renormalization.
//
// The client inserts at the midpoint between neighbours, which halves the gap
// each time; after ~20 nudges in the same spot the gap underflows toward zero
// and ordering stops being expressible in a float. Repairing that is a
// whole-board operation, so it belongs on the server: the client emits exactly
// ONE elementUpdate per layer action, and the server decides whether the board
// needs renumbering. (Previously the client detected this and emitted one
// update per element in the room — an unbounded burst.)

/** Gap below which the board is renumbered. Mirrors the old client MIN_GAP. */
export const MIN_GAP = 1e-6;

/** An element reduced to what ordering needs. */
export interface ZRow {
  id: string;
  zIndex: number;
  createdAt: Date;
}

/**
 * Board order: ascending zIndex, then createdAt, then id — identical to the
 * client's `compareZ`, so a renumber can never reorder the board.
 */
export function compareZ(a: ZRow, b: ZRow): number {
  if (a.zIndex !== b.zIndex) return a.zIndex - b.zIndex;
  const at = a.createdAt.getTime();
  const bt = b.createdAt.getTime();
  if (at !== bt) return at - bt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Smallest gap between consecutive zIndex values; Infinity for < 2 rows. */
export function minGap(sorted: readonly ZRow[]): number {
  let min = Infinity;
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (!prev || !cur) continue;
    const gap = cur.zIndex - prev.zIndex;
    if (gap < min) min = gap;
  }
  return min;
}

/**
 * True when the board's float gaps have collapsed far enough that further
 * midpoint insertions would stop being representable.
 */
export function needsRenormalize(sorted: readonly ZRow[], threshold = MIN_GAP): boolean {
  if (sorted.length < 2) return false;
  return minGap(sorted) < threshold;
}

/**
 * Re-place a client-proposed zIndex that collides with an existing element.
 *
 * The client computes layer moves as a midpoint between two neighbours, from a
 * snapshot that may already be stale. Two clients nudging different elements
 * into the SAME gap both compute (p+q)/2 and both would be accepted — exactly
 * the duplicate-zIndex problem the create lock eliminated, reintroduced on the
 * update path.
 *
 * On collision we RE-PLACE rather than reject: a rejected layer action is a
 * dead keystroke. The new value is the midpoint between the colliding value and
 * the next distinct neighbour in the direction the client's value implies
 * (below it if the element is moving down, above it if moving up), so the
 * user's intent is preserved.
 *
 * Returns `desired` unchanged when there is no representable gap. That is not a
 * failure: the caller's MIN_GAP check then sees the collision (gap 0) and
 * renormalizes the board, which places the element deterministically.
 *
 * @param others  zIndex of every OTHER live element in the room, ascending
 * @param desired the client's proposed value (advisory)
 * @param currentZ the element's present value, used only to infer direction
 */
export function resolveZ(
  others: readonly number[],
  desired: number,
  currentZ: number,
): number {
  if (!others.includes(desired)) return desired;

  // Moving down -> settle just below the collision; moving up -> just above.
  if (desired < currentZ) {
    let lower = -Infinity;
    for (const z of others) if (z < desired && z > lower) lower = z;
    if (lower === -Infinity) return desired - 1; // nothing below: free space
    const mid = (lower + desired) / 2;
    return mid > lower && mid < desired ? mid : desired;
  }

  let upper = Infinity;
  for (const z of others) if (z > desired && z < upper) upper = z;
  if (upper === Infinity) return desired + 1; // nothing above: free space
  const mid = (desired + upper) / 2;
  return mid > desired && mid < upper ? mid : desired;
}

export interface ZAssignment {
  id: string;
  zIndex: number;
}

/**
 * Clean sequential zIndex (1..N) over the CURRENT order, returning only rows
 * whose value actually changes. Order is preserved exactly by construction:
 * the input is sorted with `compareZ` and indices are assigned in that order.
 */
export function renormalize(rows: readonly ZRow[]): ZAssignment[] {
  const sorted = [...rows].sort(compareZ);
  const out: ZAssignment[] = [];
  sorted.forEach((row, i) => {
    const zIndex = i + 1;
    if (row.zIndex !== zIndex) out.push({ id: row.id, zIndex });
  });
  return out;
}
