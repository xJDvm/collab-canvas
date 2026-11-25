import { Doc, type Point, type Shape } from "@collab-canvas/crdt";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { hitTest } from "../src/geometry.js";
import { PALETTE, Tools } from "../src/tools.js";

/** A document replica and a tool state machine that edits it. */
function setup(): { doc: Doc; tools: Tools } {
  const doc = new Doc("tester");
  return { doc, tools: new Tools(doc) };
}

/** Runs one complete pointer gesture from `from` to `to` and returns the ops it produced. */
function drag(tools: Tools, doc: Doc, from: Point, to: Point) {
  tools.pointerDown(from, doc.visibleShapes());
  tools.pointerMove(to);
  return tools.pointerUp(to, doc.visibleShapes());
}

/** Creates one rectangle with the rect tool and returns its id. */
function makeRect(tools: Tools, doc: Doc, x: number, y: number, w: number, h: number): string {
  tools.setTool("rect");
  drag(tools, doc, { x, y }, { x: x + w, y: y + h });
  const created = doc.visibleShapes().at(-1);
  if (created === undefined) {
    throw new Error("rectangle was not created");
  }
  return created.id;
}

/** The only visible shape, failing the test when there is not exactly one. */
function onlyShape(doc: Doc): Shape {
  const shapes = doc.visibleShapes();
  expect(shapes).toHaveLength(1);
  const [shape] = shapes;
  if (shape === undefined) {
    throw new Error("expected one shape");
  }
  return shape;
}

describe("rectangle and ellipse tools", () => {
  it("creates a rectangle spanning the drag, whatever the drag direction", () => {
    const { doc, tools } = setup();
    tools.setTool("rect");
    const ops = drag(tools, doc, { x: 50, y: 40 }, { x: 10, y: 20 });

    expect(ops.map((op) => op.type)).toEqual(["create"]);
    expect(onlyShape(doc)).toMatchObject({
      kind: "rect",
      x: 10,
      y: 20,
      w: 40,
      h: 20,
      fill: PALETTE[0],
    });
  });

  it("creates an ellipse with the ellipse tool", () => {
    const { doc, tools } = setup();
    tools.setTool("ellipse");
    drag(tools, doc, { x: 0, y: 0 }, { x: 30, y: 10 });

    expect(onlyShape(doc)).toMatchObject({ kind: "ellipse", x: 0, y: 0, w: 30, h: 10 });
  });

  it("shows a preview during the drag and commits one operation on release", () => {
    const { doc, tools } = setup();
    tools.setTool("rect");
    tools.pointerDown({ x: 0, y: 0 }, doc.visibleShapes());
    tools.pointerMove({ x: 5, y: 5 });
    tools.pointerMove({ x: 8, y: 9 });

    expect(doc.visibleShapes()).toHaveLength(0);
    expect(tools.displayShapes(doc.visibleShapes())).toMatchObject([
      { kind: "rect", x: 0, y: 0, w: 8, h: 9 },
    ]);

    tools.pointerUp({ x: 8, y: 9 }, doc.visibleShapes());
    expect(doc.visibleShapes()).toHaveLength(1);
    expect(tools.displayShapes(doc.visibleShapes())).toHaveLength(1);
  });

  it("creates nothing for a click or a drag shorter than one pixel", () => {
    const { doc, tools } = setup();
    tools.setTool("rect");

    expect(drag(tools, doc, { x: 4, y: 4 }, { x: 4, y: 4 })).toEqual([]);
    expect(drag(tools, doc, { x: 4, y: 4 }, { x: 4.5, y: 20 })).toEqual([]);
    expect(doc.visibleShapes()).toHaveLength(0);
  });

  it("uses the palette colour chosen before drawing", () => {
    const { doc, tools } = setup();
    tools.setColour(PALETTE[3], doc.visibleShapes());
    tools.setTool("ellipse");
    drag(tools, doc, { x: 0, y: 0 }, { x: 10, y: 10 });

    expect(onlyShape(doc)).toMatchObject({ fill: PALETTE[3] });
  });

  it("stacks each new shape above the ones already on the canvas", () => {
    const { doc, tools } = setup();
    const first = makeRect(tools, doc, 0, 0, 10, 10);
    const second = makeRect(tools, doc, 0, 0, 10, 10);
    const shapes = doc.visibleShapes();

    expect(shapes.map((s) => s.id)).toEqual([first, second]);
    expect(shapes[1]?.z).toBeGreaterThan(shapes[0]?.z ?? Infinity);
  });
});

describe("pen tool", () => {
  it("records each distinct point and creates a stroke on release", () => {
    const { doc, tools } = setup();
    tools.setTool("pen");
    tools.pointerDown({ x: 0, y: 0 }, doc.visibleShapes());
    tools.pointerMove({ x: 1, y: 1 });
    tools.pointerMove({ x: 2, y: 3 });
    tools.pointerUp({ x: 2, y: 3 }, doc.visibleShapes());

    expect(onlyShape(doc)).toMatchObject({
      kind: "stroke",
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
        { x: 2, y: 3 },
      ],
    });
  });

  it("does not store a point that repeats the previous one", () => {
    const { doc, tools } = setup();
    tools.setTool("pen");
    tools.pointerDown({ x: 5, y: 5 }, doc.visibleShapes());
    tools.pointerMove({ x: 5, y: 5 });
    tools.pointerMove({ x: 5, y: 5 });
    tools.pointerMove({ x: 6, y: 6 });
    tools.pointerUp({ x: 6, y: 6 }, doc.visibleShapes());

    expect(onlyShape(doc)).toMatchObject({
      kind: "stroke",
      points: [
        { x: 5, y: 5 },
        { x: 6, y: 6 },
      ],
    });
  });

  it("creates nothing for a single click", () => {
    const { doc, tools } = setup();
    tools.setTool("pen");

    expect(drag(tools, doc, { x: 1, y: 1 }, { x: 1, y: 1 })).toEqual([]);
    expect(doc.visibleShapes()).toHaveLength(0);
  });

  it("stops at the 2000 point limit of the CRDT", () => {
    const { doc, tools } = setup();
    tools.setTool("pen");
    tools.pointerDown({ x: 0, y: 0 }, doc.visibleShapes());
    for (let i = 1; i <= 2500; i++) {
      tools.pointerMove({ x: i, y: 0 });
    }
    tools.pointerUp({ x: 2500, y: 0 }, doc.visibleShapes());

    const shape = onlyShape(doc);
    if (shape.kind !== "stroke") {
      throw new Error("expected a stroke");
    }
    expect(shape.points).toHaveLength(2000);
  });
});

describe("select tool", () => {
  it("selects a shape on click and clears the selection on empty space", () => {
    const { doc, tools } = setup();
    const id = makeRect(tools, doc, 10, 10, 40, 20);
    tools.setTool("select");

    drag(tools, doc, { x: 20, y: 20 }, { x: 20, y: 20 });
    expect(tools.selection).toBe(id);

    drag(tools, doc, { x: 200, y: 200 }, { x: 200, y: 200 });
    expect(tools.selection).toBeNull();
  });

  it("moves a dragged box by the pointer delta in one update", () => {
    const { doc, tools } = setup();
    makeRect(tools, doc, 10, 10, 40, 20);
    tools.setTool("select");
    tools.pointerDown({ x: 20, y: 20 }, doc.visibleShapes());
    tools.pointerMove({ x: 30, y: 35 });

    expect(tools.displayShapes(doc.visibleShapes())).toMatchObject([{ x: 20, y: 25 }]);
    expect(doc.visibleShapes()).toMatchObject([{ x: 10, y: 10 }]);

    const ops = tools.pointerUp({ x: 30, y: 35 }, doc.visibleShapes());
    expect(ops.map((op) => op.type)).toEqual(["update"]);
    expect(onlyShape(doc)).toMatchObject({ x: 20, y: 25, w: 40, h: 20 });
  });

  it("produces no update when the pointer returns to where it started", () => {
    const { doc, tools } = setup();
    makeRect(tools, doc, 10, 10, 40, 20);
    tools.setTool("select");

    expect(drag(tools, doc, { x: 20, y: 20 }, { x: 20, y: 20 })).toEqual([]);
  });

  it("selects the topmost shape under the pointer", () => {
    const { doc, tools } = setup();
    makeRect(tools, doc, 0, 0, 100, 100);
    const top = makeRect(tools, doc, 20, 20, 100, 100);
    tools.setTool("select");
    drag(tools, doc, { x: 50, y: 50 }, { x: 50, y: 50 });

    expect(tools.selection).toBe(top);
  });

  it("selects strokes but does not move them, since their points are fixed", () => {
    const { doc, tools } = setup();
    tools.setTool("pen");
    drag(tools, doc, { x: 0, y: 0 }, { x: 100, y: 0 });
    const stroke = onlyShape(doc);

    tools.setTool("select");
    expect(drag(tools, doc, { x: 50, y: 2 }, { x: 50, y: 60 })).toEqual([]);
    expect(tools.selection).toBe(stroke.id);
    expect(tools.displayShapes(doc.visibleShapes())).toEqual(doc.visibleShapes());
  });

  it("hits an ellipse inside its outline, not anywhere in its bounding box", () => {
    const { doc, tools } = setup();
    tools.setTool("ellipse");
    drag(tools, doc, { x: 0, y: 0 }, { x: 100, y: 100 });
    tools.setTool("select");

    drag(tools, doc, { x: 5, y: 5 }, { x: 5, y: 5 });
    expect(tools.selection).toBeNull();

    drag(tools, doc, { x: 50, y: 50 }, { x: 50, y: 50 });
    expect(tools.selection).not.toBeNull();
  });
});

describe("palette and delete", () => {
  it("recolours the selected shape by updating its fill", () => {
    const { doc, tools } = setup();
    const id = makeRect(tools, doc, 0, 0, 10, 10);
    tools.setTool("select");
    drag(tools, doc, { x: 5, y: 5 }, { x: 5, y: 5 });

    const ops = tools.setColour(PALETTE[2], doc.visibleShapes());
    expect(ops.map((op) => op.type)).toEqual(["update"]);
    expect(onlyShape(doc)).toMatchObject({ id, fill: PALETTE[2] });
  });

  it("only changes the colour for new shapes when nothing is selected", () => {
    const { doc, tools } = setup();
    makeRect(tools, doc, 0, 0, 10, 10);

    expect(tools.setColour(PALETTE[4], doc.visibleShapes())).toEqual([]);
  });

  it("deletes the selected shape and clears the selection", () => {
    const { doc, tools } = setup();
    makeRect(tools, doc, 0, 0, 10, 10);
    tools.setTool("select");
    drag(tools, doc, { x: 5, y: 5 }, { x: 5, y: 5 });

    const ops = tools.deleteSelection(doc.visibleShapes());
    expect(ops.map((op) => op.type)).toEqual(["delete"]);
    expect(doc.visibleShapes()).toHaveLength(0);
    expect(tools.selection).toBeNull();
  });

  it("does nothing when deleting without a selection", () => {
    const { doc, tools } = setup();
    makeRect(tools, doc, 0, 0, 10, 10);

    expect(tools.deleteSelection(doc.visibleShapes())).toEqual([]);
    expect(doc.visibleShapes()).toHaveLength(1);
  });

  it("drops a selection whose shape was deleted by another replica", () => {
    const { doc, tools } = setup();
    const id = makeRect(tools, doc, 0, 0, 10, 10);
    tools.setTool("select");
    drag(tools, doc, { x: 5, y: 5 }, { x: 5, y: 5 });
    expect(tools.selection).toBe(id);

    doc.deleteShape(id);

    expect(tools.setColour(PALETTE[1], doc.visibleShapes())).toEqual([]);
    expect(tools.selection).toBeNull();
  });
});

describe("gesture lifecycle", () => {
  it("abandons the gesture in progress when the tool changes", () => {
    const { doc, tools } = setup();
    tools.setTool("rect");
    tools.pointerDown({ x: 0, y: 0 }, doc.visibleShapes());
    tools.pointerMove({ x: 20, y: 20 });
    tools.setTool("pen");

    expect(tools.pointerUp({ x: 20, y: 20 }, doc.visibleShapes())).toEqual([]);
    expect(doc.visibleShapes()).toHaveLength(0);
    expect(tools.displayShapes(doc.visibleShapes())).toEqual([]);
  });

  it("ignores moves and releases that have no pointer down", () => {
    const { doc, tools } = setup();
    tools.pointerMove({ x: 3, y: 3 });

    expect(tools.displayShapes(doc.visibleShapes())).toEqual([]);
    expect(tools.pointerUp({ x: 3, y: 3 }, doc.visibleShapes())).toEqual([]);
  });

  it("replaces an unfinished gesture when a new press starts", () => {
    const { doc, tools } = setup();
    tools.setTool("rect");
    tools.pointerDown({ x: 0, y: 0 }, doc.visibleShapes());
    tools.pointerMove({ x: 9, y: 9 });
    tools.pointerDown({ x: 30, y: 30 }, doc.visibleShapes());
    tools.pointerUp({ x: 40, y: 45 }, doc.visibleShapes());

    expect(onlyShape(doc)).toMatchObject({ x: 30, y: 30, w: 10, h: 15 });
  });

});

describe("hit testing", () => {
  const coordinate = fc.integer({ min: -100, max: 100 });
  const size = fc.integer({ min: 0, max: 200 });

  it("hits a rectangle exactly when the point is inside or on its edge", () => {
    fc.assert(
      fc.property(
        coordinate,
        coordinate,
        size,
        size,
        coordinate,
        coordinate,
        (x, y, w, h, px, py) => {
          const shape: Shape = {
            id: "s",
            kind: "rect",
            x,
            y,
            w,
            h,
            fill: PALETTE[0],
            stroke: PALETTE[5],
            z: 0,
          };
          const inside = px >= x && px <= x + w && py >= y && py <= y + h;
          expect(hitTest(shape, { x: px, y: py })).toBe(inside);
        },
      ),
    );
  });

  it("hits an ellipse inside its outline and misses outside it", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 200 }),
        fc.integer({ min: 2, max: 200 }),
        fc.double({ min: 0, max: 2 * Math.PI, noNaN: true, maxExcluded: true }),
        (w, h, angle) => {
          const shape: Shape = {
            id: "e",
            kind: "ellipse",
            x: 0,
            y: 0,
            w,
            h,
            fill: PALETTE[0],
            stroke: PALETTE[5],
            z: 0,
          };
          const cx = w / 2;
          const cy = h / 2;
          const at = (scale: number) => ({
            x: cx + scale * (w / 2) * Math.cos(angle),
            y: cy + scale * (h / 2) * Math.sin(angle),
          });
          expect(hitTest(shape, at(0.99))).toBe(true);
          expect(hitTest(shape, at(1.01))).toBe(false);
        },
      ),
    );
  });

  it("hits a stroke within six pixels of its polyline", () => {
    const shape: Shape = {
      id: "p",
      kind: "stroke",
      points: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ],
      fill: PALETTE[0],
      stroke: PALETTE[0],
      z: 0,
    };
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: -20, max: 20 }),
        (px, py) => {
          expect(hitTest(shape, { x: px, y: py })).toBe(Math.abs(py) <= 6);
        },
      ),
    );
  });

  it("never hits a stroke that has no points", () => {
    const shape: Shape = {
      id: "n",
      kind: "stroke",
      points: [],
      fill: PALETTE[0],
      stroke: PALETTE[0],
      z: 0,
    };
    expect(hitTest(shape, { x: 0, y: 0 })).toBe(false);
  });
});
