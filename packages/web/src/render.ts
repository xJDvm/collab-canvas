import type { Shape } from "@collab-canvas/crdt";
import { boundsOf } from "./geometry.js";

/** A peer's pointer, in canvas coordinates. */
export interface Cursor {
  readonly replica: string;
  readonly x: number;
  readonly y: number;
  readonly name: string;
  readonly color: string;
}

const SELECTION_COLOUR = "#0ea5e9";
const LABEL_COLOUR = "#0f172a";
const BOX_LINE_WIDTH = 2;
const STROKE_LINE_WIDTH = 3;
const SELECTION_PADDING = 6;
const CURSOR_RADIUS = 5;

/**
 * Sizes the backing store of the canvas behind `ctx` for a viewport of
 * `cssWidth` by `cssHeight` CSS pixels at device pixel ratio `dpr`, and maps
 * drawing coordinates onto CSS pixels. Call it whenever the viewport changes,
 * before {@link draw}.
 */
export function fitCanvas(
  ctx: CanvasRenderingContext2D,
  cssWidth: number,
  cssHeight: number,
  dpr: number,
): void {
  ctx.canvas.width = Math.max(1, Math.round(cssWidth * dpr));
  ctx.canvas.height = Math.max(1, Math.round(cssHeight * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

/**
 * Paints one frame: clears the canvas, then draws `shapes` in the order given,
 * a selection outline around the shape whose id is `selection`, and the
 * `cursors` on top. Coordinates are CSS pixels, as set up by {@link fitCanvas}.
 *
 * A stroke is painted in its `fill` colour. Shapes that cannot be drawn
 * (a stroke without points) are skipped.
 */
export function draw(
  ctx: CanvasRenderingContext2D,
  shapes: readonly Shape[],
  selection: string | null,
  cursors: readonly Cursor[],
): void {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.restore();

  for (const shape of shapes) {
    drawShape(ctx, shape);
  }
  const selected = selection === null ? undefined : shapes.find((s) => s.id === selection);
  if (selected !== undefined) {
    drawSelection(ctx, selected);
  }
  for (const cursor of cursors) {
    drawCursor(ctx, cursor);
  }
}

function drawShape(ctx: CanvasRenderingContext2D, shape: Shape): void {
  switch (shape.kind) {
    case "rect":
      ctx.fillStyle = shape.fill;
      ctx.fillRect(shape.x, shape.y, shape.w, shape.h);
      ctx.strokeStyle = shape.stroke;
      ctx.lineWidth = BOX_LINE_WIDTH;
      ctx.strokeRect(shape.x, shape.y, shape.w, shape.h);
      break;
    case "ellipse":
      ctx.beginPath();
      ctx.ellipse(
        shape.x + shape.w / 2,
        shape.y + shape.h / 2,
        Math.abs(shape.w) / 2,
        Math.abs(shape.h) / 2,
        0,
        0,
        2 * Math.PI,
      );
      ctx.fillStyle = shape.fill;
      ctx.fill();
      ctx.strokeStyle = shape.stroke;
      ctx.lineWidth = BOX_LINE_WIDTH;
      ctx.stroke();
      break;
    case "stroke": {
      const [first, ...rest] = shape.points;
      if (first === undefined) {
        break;
      }
      ctx.beginPath();
      ctx.moveTo(first.x, first.y);
      for (const p of rest) {
        ctx.lineTo(p.x, p.y);
      }
      ctx.strokeStyle = shape.fill;
      ctx.lineWidth = STROKE_LINE_WIDTH;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke();
      break;
    }
  }
}

function drawSelection(ctx: CanvasRenderingContext2D, shape: Shape): void {
  const box = boundsOf(shape);
  if (box === null) {
    return;
  }
  ctx.save();
  ctx.strokeStyle = SELECTION_COLOUR;
  ctx.lineWidth = 1;
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(
    box.x - SELECTION_PADDING,
    box.y - SELECTION_PADDING,
    box.w + 2 * SELECTION_PADDING,
    box.h + 2 * SELECTION_PADDING,
  );
  ctx.restore();
}

function drawCursor(ctx: CanvasRenderingContext2D, cursor: Cursor): void {
  ctx.save();
  ctx.fillStyle = cursor.color;
  ctx.beginPath();
  ctx.arc(cursor.x, cursor.y, CURSOR_RADIUS, 0, 2 * Math.PI);
  ctx.fill();
  ctx.fillStyle = LABEL_COLOUR;
  ctx.font = "12px system-ui, sans-serif";
  ctx.textBaseline = "middle";
  ctx.fillText(cursor.name, cursor.x + CURSOR_RADIUS + 4, cursor.y);
  ctx.restore();
}
