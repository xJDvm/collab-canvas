import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  Doc,
  type DocSnapshot,
  type MutableFields,
  type Op,
  type Point,
  type ShapeInit,
} from "../src/index.js";

const rect: ShapeInit = { kind: "rect", x: 1, y: 2, w: 3, h: 4, fill: "#ff0000", stroke: "#000000", z: 0 };

function json<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Applies the operations to a fresh replica, in the given order. */
function replay(replica: string, ops: readonly Op[]): Doc {
  const doc = new Doc(replica);
  for (const op of ops) {
    doc.apply(op);
  }
  return doc;
}

describe("Doc constructor", () => {
  it("rejects invalid replica ids", () => {
    expect(() => new Doc("")).toThrow(RangeError);
    expect(() => new Doc("has space")).toThrow(RangeError);
  });
});

describe("createShape", () => {
  it("returns a create op whose id is the shape id", () => {
    const doc = new Doc("alpha");
    const op = doc.createShape(rect);
    expect(op).toEqual({
      type: "create",
      id: "alpha:1",
      stamp: { lamport: 1, replica: "alpha" },
      shape: rect,
    });
    expect(doc.visibleShapes()).toEqual([{ id: "alpha:1", ...rect }]);
  });

  it("creates a stroke with its points and no box geometry", () => {
    const doc = new Doc("alpha");
    const points = [
      { x: 0, y: 0 },
      { x: 5, y: 6 },
    ];
    doc.createShape({ kind: "stroke", points, fill: "#00ff00", stroke: "#123456", z: 2 });
    expect(doc.visibleShapes()).toEqual([
      { id: "alpha:1", kind: "stroke", points, fill: "#00ff00", stroke: "#123456", z: 2 },
    ]);
  });

  it("does not keep references to the caller's input", () => {
    const doc = new Doc("alpha");
    const points = [{ x: 1, y: 1 }];
    const init = { kind: "stroke" as const, points, fill: "#000000", stroke: "#000000", z: 0 };
    const op = doc.createShape(init);
    points.push({ x: 9, y: 9 });
    expect(op.shape).toEqual({ ...init, points: [{ x: 1, y: 1 }] });
    expect(doc.visibleShapes()[0]).toMatchObject({ points: [{ x: 1, y: 1 }] });
  });

  it("gives each created shape a distinct id", () => {
    const doc = new Doc("alpha");
    const a = doc.createShape(rect);
    const b = doc.createShape(rect);
    expect(a.id).not.toBe(b.id);
    expect(doc.visibleShapes().map((s) => s.id)).toEqual([a.id, b.id]);
  });
});

describe("updateShape", () => {
  it("sets only the given fields", () => {
    const doc = new Doc("alpha");
    const { id } = doc.createShape(rect);
    doc.updateShape(id, { x: 10, fill: "#00ff00" });
    expect(doc.visibleShapes()).toEqual([
      { id, ...rect, x: 10, fill: "#00ff00" },
    ]);
  });

  it("ignores fields that are absent from the update", () => {
    const doc = new Doc("alpha");
    const { id } = doc.createShape(rect);
    doc.updateShape(id, {});
    expect(doc.visibleShapes()).toEqual([{ id, ...rect }]);
  });

  it("returns an update op carrying the requested fields", () => {
    const doc = new Doc("alpha");
    const { id } = doc.createShape(rect);
    const fields: { z?: number } = { z: 7 };
    const op = doc.updateShape(id, fields);
    expect(op).toEqual({
      type: "update",
      id: "alpha:2",
      stamp: { lamport: 2, replica: "alpha" },
      shapeId: id,
      fields: { z: 7 },
    });
    fields.z = 99;
    expect(op.fields).toEqual({ z: 7 });
  });

  it("keeps the greater stamp regardless of delivery order", () => {
    const a = new Doc("a");
    const b = new Doc("b");
    const create = a.createShape(rect);
    b.apply(create);
    const first = a.updateShape(create.id, { x: 100 });
    const second = b.updateShape(create.id, { x: 200 });
    const replica = new Doc("c");
    replica.apply(create);
    replica.apply(second);
    replica.apply(first);
    expect(replica.visibleShapes()[0]).toMatchObject({ x: 200 });
  });

  it("applies a remote update to a shape created elsewhere", () => {
    const a = new Doc("a");
    const create = a.createShape(rect);
    const b = new Doc("b");
    b.apply(create);
    const update = b.updateShape(create.id, { w: 50 });
    expect(a.apply(update)).toBe(true);
    expect(a.visibleShapes()[0]).toMatchObject({ w: 50, h: 4 });
  });
});

describe("deleteShape", () => {
  it("hides the shape from visibleShapes but keeps it in the snapshot", () => {
    const doc = new Doc("alpha");
    const { id } = doc.createShape(rect);
    const op = doc.deleteShape(id);
    expect(op).toMatchObject({ type: "delete", shapeId: id, id: "alpha:2" });
    expect(doc.visibleShapes()).toEqual([]);
    const snap = doc.snapshot();
    expect(snap.shapes).toHaveLength(1);
    expect(snap.shapes[0]?.deleted).toEqual({ value: true, stamp: { lamport: 2, replica: "alpha" } });
  });

  it("is not undone by a later update", () => {
    const a = new Doc("a");
    const create = a.createShape(rect);
    const del = a.deleteShape(create.id);
    const late = new Doc("b");
    late.apply(create);
    late.apply(del);
    late.updateShape(create.id, { x: 5 });
    expect(late.visibleShapes()).toEqual([]);
  });

  it("is not undone by a re-delivered create", () => {
    const a = new Doc("a");
    const create = a.createShape(rect);
    a.deleteShape(create.id);
    expect(a.apply(create)).toBe(false);
    expect(a.visibleShapes()).toEqual([]);
  });

  it("stays deleted when an update with a greater stamp arrives after the delete", () => {
    const a = new Doc("a");
    const create = a.createShape(rect);
    const del = a.deleteShape(create.id);
    const b = new Doc("b");
    b.apply(create);
    b.apply(del);
    const update = b.updateShape(create.id, { x: 1000 });
    expect(update.stamp.lamport).toBeGreaterThan(del.stamp.lamport);
    a.apply(update);
    expect(a.visibleShapes()).toEqual([]);
    expect(a.snapshot()).toEqual(b.snapshot());
  });

  it("is idempotent", () => {
    const a = new Doc("a");
    const create = a.createShape(rect);
    const del = a.deleteShape(create.id);
    const b = new Doc("b");
    b.apply(create);
    expect(b.apply(del)).toBe(true);
    expect(b.apply(del)).toBe(false);
    expect(b.visibleShapes()).toEqual([]);
  });
});

describe("apply", () => {
  it("returns true for a new op and false for a duplicate", () => {
    const a = new Doc("a");
    const op = a.createShape(rect);
    const b = new Doc("b");
    expect(b.apply(op)).toBe(true);
    expect(b.apply(op)).toBe(false);
  });

  it("leaves the document unchanged on a duplicate", () => {
    const a = new Doc("a");
    const create = a.createShape(rect);
    const update = a.updateShape(create.id, { x: 9 });
    const b = new Doc("b");
    b.apply(create);
    b.apply(update);
    const before = b.snapshot();
    b.apply(create);
    expect(b.snapshot()).toEqual(before);
  });

  it("makes the local clock sort after observed remote stamps", () => {
    const remote = new Doc("zeta");
    for (let i = 0; i < 9; i++) {
      remote.createShape(rect);
    }
    const local = new Doc("alpha");
    local.apply(remote.createShape(rect));
    expect(local.createShape(rect).stamp.lamport).toBe(11);
  });

  it("buffers an update that arrives before its create without showing the shape", () => {
    const a = new Doc("a");
    const create = a.createShape(rect);
    const update = a.updateShape(create.id, { x: 77 });
    const b = new Doc("b");
    expect(b.apply(update)).toBe(true);
    expect(b.visibleShapes()).toEqual([]);
    expect(b.snapshot().shapes[0]?.kind).toBeNull();
    b.apply(create);
    expect(b.visibleShapes()).toEqual([{ id: create.id, ...rect, x: 77 }]);
  });

  it("converges whether a buffered update or its create arrives first", () => {
    const a = new Doc("a");
    const create = a.createShape(rect);
    const update = a.updateShape(create.id, { x: 77 });
    const early = new Doc("e");
    early.apply(update);
    early.apply(create);
    const lateCreate = new Doc("l");
    lateCreate.apply(create);
    lateCreate.apply(update);
    expect(early.snapshot()).toEqual(lateCreate.snapshot());
    expect(early.visibleShapes()[0]).toMatchObject({ x: 77 });
  });

  it("keeps a buffered delete so the shape stays hidden once created", () => {
    const a = new Doc("a");
    const create = a.createShape(rect);
    const del = a.deleteShape(create.id);
    const b = new Doc("b");
    b.apply(del);
    b.apply(create);
    expect(b.visibleShapes()).toEqual([]);
  });

  it("does not show a stroke's box fields that were never created", () => {
    const doc = new Doc("alpha");
    const { id } = doc.createShape({
      kind: "stroke",
      points: [{ x: 0, y: 0 }],
      fill: "#000000",
      stroke: "#000000",
      z: 0,
    });
    doc.updateShape(id, { x: 4 });
    expect(doc.visibleShapes()[0]).not.toHaveProperty("x");
  });

  it("does not mutate the op it applies", () => {
    const a = new Doc("a");
    const create = a.createShape(rect);
    const update = a.updateShape(create.id, { x: 3 });
    const before = json([create, update]);
    replay("b", [create, update]);
    expect(json([create, update])).toEqual(before);
  });
});

describe("visibleShapes", () => {
  it("sorts by z and then by id", () => {
    const doc = new Doc("alpha");
    const top = doc.createShape({ ...rect, z: 5 });
    const low = doc.createShape({ ...rect, z: -1 });
    const tieA = doc.createShape({ ...rect, z: 1 });
    const tieB = doc.createShape({ ...rect, z: 1 });
    expect(doc.visibleShapes().map((s) => s.id)).toEqual([low.id, tieA.id, tieB.id, top.id]);
  });

  it("orders ids by code unit when z ties", () => {
    const doc = new Doc("b");
    const other = new Doc("B");
    const fromLower = doc.createShape({ ...rect, z: 0 });
    const fromUpper = other.createShape({ ...rect, z: 0 });
    const shared = new Doc("c");
    shared.apply(fromLower);
    shared.apply(fromUpper);
    expect(shared.visibleShapes().map((s) => s.id)).toEqual([fromUpper.id, fromLower.id]);
  });

  it("reflects z updates in the order", () => {
    const doc = new Doc("alpha");
    const first = doc.createShape({ ...rect, z: 1 });
    const second = doc.createShape({ ...rect, z: 2 });
    doc.updateShape(first.id, { z: 3 });
    expect(doc.visibleShapes().map((s) => s.id)).toEqual([second.id, first.id]);
  });

  it("is empty for a new document", () => {
    expect(new Doc("alpha").visibleShapes()).toEqual([]);
  });
});

describe("snapshot", () => {
  it("lists shapes sorted by id regardless of creation order", () => {
    const a = new Doc("a");
    const b = new Doc("b");
    const first = a.createShape(rect);
    const second = b.createShape(rect);
    const left = replay("x", [first, second]).snapshot();
    const right = replay("y", [second, first]).snapshot();
    expect(left.shapes.map((s) => s.id)).toEqual([first.id, second.id].sort());
    expect(right).toEqual(left);
  });

  it("is JSON-stable across a serialisation round trip", () => {
    const doc = new Doc("alpha");
    const { id } = doc.createShape(rect);
    doc.updateShape(id, { fill: "#abcdef" });
    const snap = doc.snapshot();
    expect(json(snap)).toEqual(snap);
    expect(JSON.stringify(json(snap))).toBe(JSON.stringify(snap));
  });

  it("returns a copy that cannot change the document", () => {
    const doc = new Doc("alpha");
    doc.createShape({ kind: "stroke", points: [{ x: 1, y: 1 }], fill: "#000000", stroke: "#000000", z: 0 });
    const snap = doc.snapshot();
    const points = (snap.shapes[0]?.points?.value ?? []) as Point[];
    points.push({ x: 2, y: 2 });
    expect(doc.visibleShapes()[0]).toMatchObject({ points: [{ x: 1, y: 1 }] });
  });
});

describe("fromSnapshot", () => {
  it("round-trips to an equal snapshot", () => {
    const doc = new Doc("alpha");
    const box = doc.createShape(rect);
    doc.createShape({ kind: "stroke", points: [{ x: 0, y: 1 }], fill: "#000000", stroke: "#111111", z: 4 });
    doc.updateShape(box.id, { x: 9 });
    doc.deleteShape(box.id);
    doc.updateShape("alpha:999", { z: 1 });
    const snap = doc.snapshot();
    expect(Doc.fromSnapshot("beta", json(snap)).snapshot()).toEqual(snap);
    expect(Doc.fromSnapshot("beta", snap).visibleShapes()).toEqual(doc.visibleShapes());
  });

  it("keeps duplicate detection across the snapshot", () => {
    const a = new Doc("a");
    const op = a.createShape(rect);
    const restored = Doc.fromSnapshot("b", a.snapshot());
    expect(restored.apply(op)).toBe(false);
  });

  it("never reuses a stamp recorded in the snapshot", () => {
    const doc = new Doc("alpha");
    doc.createShape(rect);
    doc.createShape(rect);
    const restored = Doc.fromSnapshot("alpha", doc.snapshot());
    const next = restored.createShape(rect);
    expect(next.stamp.lamport).toBe(3);
    expect(doc.snapshot().seen).not.toContain(next.id);
  });

  it("accepts an empty snapshot", () => {
    const empty: DocSnapshot = { shapes: [], seen: [] };
    expect(Doc.fromSnapshot("alpha", empty).snapshot()).toEqual(empty);
  });

  it("rejects malformed op ids in the snapshot", () => {
    const bad: DocSnapshot = { shapes: [], seen: ["not an id"] };
    expect(() => Doc.fromSnapshot("alpha", bad)).toThrow(RangeError);
  });
});

const coordArb = fc.integer({ min: -1000, max: 1000 });
const colorArb = fc.stringMatching(/^#[0-9a-f]{6}$/);
const boxArb: fc.Arbitrary<ShapeInit> = fc.record({
  kind: fc.constantFrom("rect" as const, "ellipse" as const),
  x: coordArb,
  y: coordArb,
  w: coordArb,
  h: coordArb,
  fill: colorArb,
  stroke: colorArb,
  z: fc.integer({ min: -3, max: 3 }),
});
const strokeArb: fc.Arbitrary<ShapeInit> = fc.record({
  kind: fc.constant("stroke" as const),
  points: fc.array(fc.record({ x: coordArb, y: coordArb }), { maxLength: 4 }),
  fill: colorArb,
  stroke: colorArb,
  z: fc.integer({ min: -3, max: 3 }),
});
const fieldsArb: fc.Arbitrary<Partial<MutableFields>> = fc.oneof(
  fc.record({ x: coordArb }),
  fc.record({ y: coordArb }),
  fc.record({ w: coordArb, h: coordArb }),
  fc.record({ fill: colorArb }),
  fc.record({ stroke: colorArb }),
  fc.record({ z: fc.integer({ min: -3, max: 3 }) }),
);
interface Step {
  readonly replica: 0 | 1 | 2;
  readonly action: "create" | "update" | "delete";
  readonly pick: number;
  readonly init: ShapeInit;
  readonly fields: Partial<MutableFields>;
}
const stepArb: fc.Arbitrary<Step> = fc.record({
  replica: fc.constantFrom(0 as const, 1 as const, 2 as const),
  action: fc.constantFrom("create" as const, "update" as const, "delete" as const),
  pick: fc.nat(),
  init: fc.oneof(boxArb, strokeArb),
  fields: fieldsArb,
});

/**
 * Plays steps on three author replicas and returns the operations in the
 * order they were authored. Updates and deletes may target shapes that the
 * author has not yet seen, exactly as a laggy peer would.
 */
function author(steps: readonly Step[]): Op[] {
  const authors = [new Doc("a"), new Doc("b"), new Doc("c")] as const;
  const ids: string[] = [];
  const log: Op[] = [];
  for (const step of steps) {
    const doc = authors[step.replica];
    const target = ids.length === 0 ? undefined : ids[step.pick % ids.length];
    if (step.action === "create" || target === undefined) {
      const op = doc.createShape(step.init);
      ids.push(op.id);
      log.push(op);
    } else if (step.action === "update") {
      log.push(doc.updateShape(target, step.fields));
    } else {
      log.push(doc.deleteShape(target));
    }
  }
  return log;
}

describe("properties", () => {
  it("property: any delivery order with duplicates converges to the authored state", () => {
    const deliveryArb = fc.record({
      step: stepArb,
      key: fc.double({ min: 0, max: 1, noNaN: true }),
      extraKey: fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: null }),
    });
    fc.assert(
      fc.property(fc.array(deliveryArb, { maxLength: 30 }), (items) => {
        const steps = items.map((item) => item.step);
        const ops = author(steps);
        const reference = replay("ref", ops).snapshot();

        const deliveries: { op: Op; key: number }[] = [];
        items.forEach((item, i) => {
          const op = ops[i];
          if (op === undefined) return;
          deliveries.push({ op, key: item.key });
          if (item.extraKey !== null) {
            deliveries.push({ op, key: item.extraKey });
          }
        });
        deliveries.sort((a, b) => a.key - b.key);

        const observer = new Doc("observer");
        for (const { op } of deliveries) {
          observer.apply(op);
        }
        expect(observer.snapshot()).toEqual(reference);
        expect(observer.snapshot().seen).toHaveLength(ops.length);
      }),
    );
  });

  it("property: applying every op twice equals applying it once", () => {
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 30 }), (steps) => {
        const ops = author(steps);
        const once = replay("x", ops).snapshot();
        const twice = replay("y", [...ops, ...ops]).snapshot();
        expect(twice).toEqual(once);
      }),
    );
  });

  it("property: a snapshot round-trip preserves state and visible shapes", () => {
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 30 }), (steps) => {
        const doc = replay("x", author(steps));
        const snap = doc.snapshot();
        const restored = Doc.fromSnapshot("y", json(snap));
        expect(restored.snapshot()).toEqual(snap);
        expect(restored.visibleShapes()).toEqual(doc.visibleShapes());
      }),
    );
  });

  it("property: deleted shapes never appear in visibleShapes", () => {
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 30 }), (steps) => {
        const doc = replay("x", author(steps));
        const deleted = new Set(
          doc
            .snapshot()
            .shapes.filter((s) => s.deleted !== null)
            .map((s) => s.id),
        );
        for (const shape of doc.visibleShapes()) {
          expect(deleted.has(shape.id)).toBe(false);
        }
      }),
    );
  });
});
