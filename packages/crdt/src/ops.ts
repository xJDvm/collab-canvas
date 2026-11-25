import type { Stamp } from "./clock.js";

/** A point of a freehand stroke, in canvas coordinates. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** The kinds of shape a document can contain. */
export type ShapeKind = "rect" | "ellipse" | "stroke";

/** Attributes every shape has. Colours are `#rrggbb` strings. */
export interface ShapeStyle {
  readonly fill: string;
  readonly stroke: string;
  /** Fractional z-order; higher values are drawn on top. */
  readonly z: number;
}

/** Geometry of a rectangle or ellipse anchored at `(x, y)` with size `w` by `h`. */
export interface BoxGeometry {
  readonly kind: "rect" | "ellipse";
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Geometry of a freehand stroke, as an ordered polyline. */
export interface StrokeGeometry {
  readonly kind: "stroke";
  readonly points: readonly Point[];
}

/** Everything needed to create a shape. */
export type ShapeInit = ShapeStyle & (BoxGeometry | StrokeGeometry);

/** The fields an update may change. Each one is an independent LWW register. */
export interface MutableFields {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly fill: string;
  readonly stroke: string;
  readonly z: number;
}

interface OpBase {
  /** Unique id, `"<replica>:<lamport>"`; see {@link opId}. */
  readonly id: string;
  readonly stamp: Stamp;
}

/**
 * Creates a shape. The shape's id is the id of this operation.
 */
export interface CreateOp extends OpBase {
  readonly type: "create";
  readonly shape: ShapeInit;
}

/** Sets the given fields of a shape, each one LWW-resolved on its own. */
export interface UpdateOp extends OpBase {
  readonly type: "update";
  readonly shapeId: string;
  readonly fields: Partial<MutableFields>;
}

/** Marks a shape as deleted. The tombstone is never removed. */
export interface DeleteOp extends OpBase {
  readonly type: "delete";
  readonly shapeId: string;
}

/** A document operation. Every operation is JSON-serialisable. */
export type Op = CreateOp | UpdateOp | DeleteOp;

/** A shape as seen by a reader of the document. */
export type Shape = ShapeInit & { readonly id: string };

/** A last-writer-wins register: a value together with the stamp that wrote it. */
export interface Register<T> {
  readonly value: T;
  readonly stamp: Stamp;
}

/**
 * The full state of one shape. A `null` register has never been written.
 * A record whose `kind` is `null` was created by an update or delete that
 * arrived before its create; it is not visible until the create arrives.
 */
export interface ShapeRecord {
  readonly id: string;
  readonly kind: Register<ShapeKind> | null;
  readonly x: Register<number> | null;
  readonly y: Register<number> | null;
  readonly w: Register<number> | null;
  readonly h: Register<number> | null;
  readonly points: Register<readonly Point[]> | null;
  readonly fill: Register<string> | null;
  readonly stroke: Register<string> | null;
  readonly z: Register<number> | null;
  readonly deleted: Register<true> | null;
}

/**
 * Canonical, JSON-stable state of a document. Shapes are sorted by id and
 * `seen` lists every applied op id in sorted order.
 */
export interface DocSnapshot {
  readonly shapes: readonly ShapeRecord[];
  readonly seen: readonly string[];
}

/** Returns the op id for a stamp: `"<replica>:<lamport>"`. */
export function opId(stamp: Stamp): string {
  return `${stamp.replica}:${stamp.lamport}`;
}

const OP_ID_PATTERN = /^([A-Za-z0-9_-]{1,64}):(0|[1-9][0-9]*)$/;

/**
 * Parses an op id produced by {@link opId} back into its stamp.
 *
 * @throws {RangeError} If `id` is not of the form `"<replica>:<lamport>"`.
 */
export function stampFromOpId(id: string): Stamp {
  const match = OP_ID_PATTERN.exec(id);
  if (match === null) {
    throw new RangeError("malformed op id");
  }
  return { replica: match[1] ?? "", lamport: Number(match[2]) };
}
