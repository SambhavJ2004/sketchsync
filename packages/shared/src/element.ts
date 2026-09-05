import { z } from "zod";

// All geometry is expressed in WORLD coordinates (the infinite canvas space),
// never screen/viewport pixels. The client maps world <-> screen when rendering.

// ---------------------------------------------------------------------------
// Content caps
// ---------------------------------------------------------------------------
// ABUSE CEILINGS, NOT UX LIMITS. They bound what a single frame can cost the
// server (memory, JSON row size) without changing any shape semantics. Real use
// is orders of magnitude below them: a 3-second pencil stroke samples ~180-360
// points, so MAX_PENCIL_POINTS is ~30x a long deliberate stroke.
// Defined here so client and server inherit the SAME limits from one place.

/** Max points in a single freehand stroke (~30x a very long real stroke). */
export const MAX_PENCIL_POINTS = 10_000;
/** Max characters in a text element. */
export const MAX_TEXT_LENGTH = 5_000;
/** Max length of any style string (colors etc.) — "#112233"/"rgba(...)" fit easily. */
export const MAX_STYLE_STRING = 64;
/**
 * Pencil strokes above this are accepted but logged server-side, so we learn
 * whether point decimation is worth building. Not a rejection threshold.
 */
export const PENCIL_POINTS_WARN = 2_000;

/** A point in world space. */
export const Point = z.object({
  x: z.number(),
  y: z.number(),
});
export type Point = z.infer<typeof Point>;

/** Visual style shared by every element. */
export const Style = z.object({
  /** Stroke color (any CSS color string). */
  stroke: z.string().max(MAX_STYLE_STRING),
  /** Stroke width in world units. */
  width: z.number().nonnegative(),
  /** Optional fill color; absent means no fill. */
  fill: z.string().max(MAX_STYLE_STRING).optional(),
});
export type Style = z.infer<typeof Style>;

export const RectElementData = z.object({
  type: z.literal("rect"),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  style: Style,
});

export const EllipseElementData = z.object({
  type: z.literal("ellipse"),
  // Axis-aligned bounding box of the ellipse.
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  style: Style,
});

export const LineElementData = z.object({
  type: z.literal("line"),
  x1: z.number(),
  y1: z.number(),
  x2: z.number(),
  y2: z.number(),
  style: Style,
});

export const ArrowElementData = z.object({
  type: z.literal("arrow"),
  x1: z.number(),
  y1: z.number(),
  x2: z.number(),
  y2: z.number(),
  style: Style,
});

export const PencilElementData = z.object({
  type: z.literal("pencil"),
  // Freehand stroke sampled as a polyline; at least two points.
  points: z.array(Point).min(2).max(MAX_PENCIL_POINTS),
  style: Style,
});

export const TextElementData = z.object({
  type: z.literal("text"),
  x: z.number(),
  y: z.number(),
  text: z.string().max(MAX_TEXT_LENGTH),
  fontSize: z.number().positive(),
  style: Style,
});

/**
 * The shape-specific payload stored in `Element.data`, discriminated on `type`.
 * This is the single source of truth for what a drawable element contains.
 */
export const ElementData = z.discriminatedUnion("type", [
  RectElementData,
  EllipseElementData,
  LineElementData,
  ArrowElementData,
  PencilElementData,
  TextElementData,
]);
export type ElementData = z.infer<typeof ElementData>;
export type ElementType = ElementData["type"];

/**
 * The full, server-authoritative element as persisted and broadcast to clients.
 * `data.type` mirrors the DB `Element.type` column (kept for querying).
 */
export const Element = z.object({
  id: z.string().uuid(),
  roomId: z.string().uuid(),
  data: ElementData,
  version: z.number().int().positive(),
  createdBy: z.string().uuid(),
  // Controllable stacking order (float). Render order is (zIndex, createdAt).
  zIndex: z.number(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  deleted: z.boolean(),
});
export type Element = z.infer<typeof Element>;

/**
 * What a client sends when creating an element. The client generates the `id`
 * (so it can optimistically render) and starts at `version` 1; the server owns
 * `roomId`, `createdBy`, `updatedAt`, and `deleted`.
 */
export const ElementInput = z.object({
  id: z.string().uuid(),
  data: ElementData,
  // Server assigns BOTH version and zIndex authoritatively on create (zIndex
  // under a per-room advisory lock, so concurrent creates cannot collide); this
  // client-sent version is advisory, and there is deliberately no zIndex field.
  version: z.number().int().positive(),
});
export type ElementInput = z.infer<typeof ElementInput>;
