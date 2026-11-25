import type {
  CreateOp,
  DeleteOp,
  MutableFields,
  Op,
  Point,
  Shape,
  ShapeInit,
  UpdateOp,
} from "@collab-canvas/crdt";
import { hitTest, type Box } from "./geometry.js";

/** The colours offered by the palette, as lowercase `#rrggbb`. */
export const PALETTE = [
  "#ef4444",
  "#f59e0b",
  "#10b981",
  "#3b82f6",
  "#8b5cf6",
  "#111827",
] as const;

/** One colour from {@link PALETTE}. */
export type Colour = (typeof PALETTE)[number];

/** The tools of the toolbar that act on a pointer. */
export type ToolId = "rect" | "ellipse" | "pen" | "select";

/** Outline colour given to new rectangles and ellipses. */
const BOX_OUTLINE: Colour = "#111827";

/** Most points a freehand stroke may carry; mirrors the limit enforced by the CRDT. */
const MAX_STROKE_POINTS = 2000;

/** Smallest width and height, in canvas pixels, of a rectangle or ellipse that is created. */
const MIN_BOX_SIZE = 1;

/** The `id` given to shapes that are only previewed while a gesture is in progress. */
const PREVIEW_ID = "preview";

/**
 * The document operations the tools need. {@link Doc} and the connection
 * implement it: each method applies the change locally and returns the op
 * that describes it.
 */
export interface Editor {
  createShape(init: ShapeInit): CreateOp;
  updateShape(id: string, fields: Partial<MutableFields>): UpdateOp;
  deleteShape(id: string): DeleteOp;
}

/** The pointer gesture in progress, if any. */
type Gesture =
  | { readonly kind: "idle" }
  | {
      readonly kind: "box";
      readonly tool: "rect" | "ellipse";
      readonly start: Point;
      current: Point;
    }
  | { readonly kind: "pen"; readonly points: Point[] }
  | {
      readonly kind: "move";
      readonly id: string;
      readonly anchor: Point;
      readonly start: Point;
      current: Point;
    };

/** The two corners of a drag, normalised into a box. */
function boxBetween(a: Point, b: Point): Box {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  };
}

/** Appends `p` to a stroke unless it repeats the last point or the stroke is full. */
function appendPoint(points: Point[], p: Point): void {
  const last = points[points.length - 1];
  const repeats = last !== undefined && last.x === p.x && last.y === p.y;
  if (points.length < MAX_STROKE_POINTS && !repeats) {
    points.push(p);
  }
}

/** A z value above every shape in `shapes`. */
function zAbove(shapes: readonly Shape[]): number {
  let top = 0;
  for (const shape of shapes) {
    top = Math.max(top, shape.z);
  }
  return top + 1;
}

/**
 * Pointer state machine for the canvas toolbar.
 *
 * Pointer positions are in canvas coordinates. Shapes are created when a
 * gesture ends, so a drag produces one operation rather than one per move.
 * Every method that changes the document returns the operations it produced;
 * the editor has already applied them.
 */
export class Tools {
  readonly #editor: Editor;
  #tool: ToolId = "rect";
  #colour: Colour = PALETTE[0];
  #selection: string | null = null;
  #gesture: Gesture = { kind: "idle" };

  /** @param editor Receives every document change the tools make. */
  constructor(editor: Editor) {
    this.#editor = editor;
  }

  /** Id of the selected shape, or `null`. */
  get selection(): string | null {
    return this.#selection;
  }

  /** Makes `tool` the active tool and abandons any gesture in progress. */
  setTool(tool: ToolId): void {
    this.#tool = tool;
    this.#gesture = { kind: "idle" };
  }

  /**
   * Sets the colour used for new shapes. When a shape is selected, its fill
   * also changes to `colour`.
   */
  setColour(colour: Colour, shapes: readonly Shape[]): Op[] {
    this.#colour = colour;
    const shape = this.#liveSelection(shapes);
    if (shape === undefined) {
      return [];
    }
    return [this.#editor.updateShape(shape.id, { fill: colour })];
  }

  /** Starts a gesture with the active tool at `p`. */
  pointerDown(p: Point, shapes: readonly Shape[]): void {
    this.#gesture = { kind: "idle" };
    const tool = this.#tool;
    switch (tool) {
      case "pen":
        this.#gesture = { kind: "pen", points: [p] };
        break;
      case "select":
        this.#beginSelect(p, shapes);
        break;
      case "rect":
      case "ellipse":
        this.#gesture = { kind: "box", tool, start: p, current: p };
        break;
    }
  }

  /** Moves the pointer of the gesture in progress to `p`. Ignored when no gesture is active. */
  pointerMove(p: Point): void {
    const gesture = this.#gesture;
    switch (gesture.kind) {
      case "idle":
        break;
      case "box":
      case "move":
        gesture.current = p;
        break;
      case "pen":
        appendPoint(gesture.points, p);
        break;
    }
  }

  /**
   * Ends the gesture at `p` and commits it. Returns the operations produced:
   * a shape is created for a finished rectangle, ellipse or stroke, and a
   * selected shape is updated when it was dragged. Gestures too small to
   * matter produce no operations.
   */
  pointerUp(p: Point, shapes: readonly Shape[]): Op[] {
    this.pointerMove(p);
    const gesture = this.#gesture;
    this.#gesture = { kind: "idle" };
    switch (gesture.kind) {
      case "idle":
        return [];
      case "box": {
        const box = boxBetween(gesture.start, gesture.current);
        if (box.w < MIN_BOX_SIZE || box.h < MIN_BOX_SIZE) {
          return [];
        }
        return [
          this.#editor.createShape({
            kind: gesture.tool,
            ...box,
            fill: this.#colour,
            stroke: BOX_OUTLINE,
            z: zAbove(shapes),
          }),
        ];
      }
      case "pen":
        if (gesture.points.length < 2) {
          return [];
        }
        return [
          this.#editor.createShape({
            kind: "stroke",
            points: gesture.points,
            fill: this.#colour,
            stroke: this.#colour,
            z: zAbove(shapes),
          }),
        ];
      case "move": {
        const dx = gesture.current.x - gesture.start.x;
        const dy = gesture.current.y - gesture.start.y;
        if ((dx === 0 && dy === 0) || !shapes.some((s) => s.id === gesture.id)) {
          return [];
        }
        return [
          this.#editor.updateShape(gesture.id, {
            x: gesture.anchor.x + dx,
            y: gesture.anchor.y + dy,
          }),
        ];
      }
    }
  }

  /** Deletes the selected shape, if it still exists, and clears the selection. */
  deleteSelection(shapes: readonly Shape[]): Op[] {
    const shape = this.#liveSelection(shapes);
    this.#selection = null;
    if (shape === undefined) {
      return [];
    }
    return [this.#editor.deleteShape(shape.id)];
  }

  /**
   * The shapes to draw: `shapes` with any shape being dragged moved to where
   * it is headed, plus a preview of the shape a gesture would create.
   */
  displayShapes(shapes: readonly Shape[]): Shape[] {
    const gesture = this.#gesture;
    const display = shapes.map((shape): Shape => {
      if (gesture.kind !== "move" || shape.id !== gesture.id || shape.kind === "stroke") {
        return shape;
      }
      const dx = gesture.current.x - gesture.start.x;
      const dy = gesture.current.y - gesture.start.y;
      return { ...shape, x: gesture.anchor.x + dx, y: gesture.anchor.y + dy };
    });
    if (gesture.kind === "box") {
      display.push({
        id: PREVIEW_ID,
        kind: gesture.tool,
        ...boxBetween(gesture.start, gesture.current),
        fill: this.#colour,
        stroke: BOX_OUTLINE,
        z: zAbove(shapes),
      });
    } else if (gesture.kind === "pen" && gesture.points.length >= 2) {
      display.push({
        id: PREVIEW_ID,
        kind: "stroke",
        points: [...gesture.points],
        fill: this.#colour,
        stroke: this.#colour,
        z: zAbove(shapes),
      });
    }
    return display;
  }

  /** Selects the topmost shape under `p`, or clears the selection. Only boxes start a move. */
  #beginSelect(p: Point, shapes: readonly Shape[]): void {
    const hit = shapes.findLast((shape) => hitTest(shape, p));
    if (hit === undefined) {
      this.#selection = null;
      return;
    }
    this.#selection = hit.id;
    if (hit.kind === "stroke") {
      // A stroke's points are fixed once created, so it cannot be moved.
      return;
    }
    this.#gesture = {
      kind: "move",
      id: hit.id,
      anchor: { x: hit.x, y: hit.y },
      start: p,
      current: p,
    };
  }

  /** The selected shape if it still exists. A selection whose shape is gone is cleared. */
  #liveSelection(shapes: readonly Shape[]): Shape | undefined {
    if (this.#selection === null) {
      return undefined;
    }
    const shape = shapes.find((s) => s.id === this.#selection);
    if (shape === undefined) {
      this.#selection = null;
    }
    return shape;
  }
}
