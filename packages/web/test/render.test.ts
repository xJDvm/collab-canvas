import type { Shape } from "@collab-canvas/crdt";
import { describe, expect, it } from "vitest";
import { draw, type Cursor } from "../src/render.js";

/** A canvas context that records the names of the methods called on it. */
function recordingContext(): { ctx: CanvasRenderingContext2D; calls: string[]; texts: string[] } {
  const calls: string[] = [];
  const texts: string[] = [];
  const target = {
    canvas: { width: 800, height: 600 },
    fillText: (text: string) => {
      texts.push(text);
      calls.push("fillText");
    },
  };
  const ctx = new Proxy(target, {
    get(obj, prop: string) {
      if (prop in obj) {
        return obj[prop as keyof typeof obj];
      }
      return (...args: unknown[]) => {
        calls.push(prop);
        return args;
      };
    },
    set(obj, prop: string, value: unknown) {
      (obj as Record<string, unknown>)[prop] = value;
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, texts };
}

const rect: Shape = {
  id: "r",
  kind: "rect",
  x: 1,
  y: 2,
  w: 30,
  h: 40,
  fill: "#111111",
  stroke: "#222222",
  z: 1,
};
const ellipse: Shape = { ...rect, id: "e", kind: "ellipse", z: 2 };
const stroke: Shape = {
  id: "s",
  kind: "stroke",
  points: [
    { x: 0, y: 0 },
    { x: 5, y: 5 },
  ],
  fill: "#333333",
  stroke: "#333333",
  z: 3,
};
const cursor: Cursor = { replica: "beta", x: 10, y: 20, name: "Ben", color: "#3b82f6" };

describe("draw", () => {
  it("paints each shape kind with the matching canvas calls", () => {
    const { ctx, calls } = recordingContext();
    draw(ctx, [rect, ellipse, stroke], null, []);
    expect(calls).toContain("fillRect");
    expect(calls).toContain("strokeRect");
    expect(calls).toContain("ellipse");
    expect(calls.filter((name) => name === "stroke").length).toBeGreaterThanOrEqual(2);
    expect(calls).toContain("lineTo");
  });

  it("skips a stroke that has no points without throwing", () => {
    const { ctx, calls } = recordingContext();
    draw(ctx, [{ ...stroke, points: [] }], null, []);
    expect(calls).not.toContain("lineTo");
  });

  it("draws a selection outline around the selected shape only", () => {
    const { ctx, calls } = recordingContext();
    draw(ctx, [rect], "r", []);
    expect(calls.filter((name) => name === "strokeRect")).toHaveLength(2);
    const plain = recordingContext();
    draw(plain.ctx, [rect], "missing", []);
    expect(plain.calls.filter((name) => name === "strokeRect")).toHaveLength(1);
  });

  it("renders each cursor as a dot with its name as canvas text", () => {
    const { ctx, calls, texts } = recordingContext();
    draw(ctx, [], null, [cursor]);
    expect(calls).toContain("arc");
    expect(calls).toContain("fill");
    expect(texts).toEqual(["Ben"]);
  });
});
