import type { Point, Shape } from "@collab-canvas/crdt";

/** A box in canvas coordinates. `w` and `h` are never negative. */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** A rectangle or ellipse, as opposed to a freehand stroke. */
export type BoxShape = Extract<Shape, { readonly kind: "rect" | "ellipse" }>;

/** How far a pointer may be from a stroke's polyline and still hit it, in canvas pixels. */
export const STROKE_HIT_RADIUS = 6;

/** The box a rectangle or ellipse covers, with its corners normalised. */
function normalisedBox(shape: BoxShape): Box {
  return {
    x: Math.min(shape.x, shape.x + shape.w),
    y: Math.min(shape.y, shape.y + shape.h),
    w: Math.abs(shape.w),
    h: Math.abs(shape.h),
  };
}

/**
 * The smallest axis-aligned box that contains a shape, or `null` for a stroke
 * without points.
 */
export function boundsOf(shape: Shape): Box | null {
  if (shape.kind !== "stroke") {
    return normalisedBox(shape);
  }
  if (shape.points.length === 0) {
    return null;
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of shape.points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Distance from `p` to the segment `a`–`b`. */
function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Whether `p` lies within {@link STROKE_HIT_RADIUS} of the polyline `points`. */
function strokeHit(points: readonly Point[], p: Point): boolean {
  let previous: Point | null = null;
  for (const point of points) {
    if (distanceToSegment(p, previous ?? point, point) <= STROKE_HIT_RADIUS) {
      return true;
    }
    previous = point;
  }
  return false;
}

/**
 * Whether the pointer `p` hits `shape`: inside a rectangle, inside an ellipse,
 * or within {@link STROKE_HIT_RADIUS} of a stroke. Boundaries count as inside.
 */
export function hitTest(shape: Shape, p: Point): boolean {
  if (shape.kind === "stroke") {
    return strokeHit(shape.points, p);
  }
  const box = normalisedBox(shape);
  if (shape.kind === "rect") {
    return p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h;
  }
  const rx = box.w / 2;
  const ry = box.h / 2;
  const dx = (p.x - (box.x + rx)) / rx;
  const dy = (p.y - (box.y + ry)) / ry;
  return dx * dx + dy * dy <= 1;
}
