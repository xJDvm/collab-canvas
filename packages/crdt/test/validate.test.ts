import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Doc, validateOp, type Op, type ShapeInit } from "../src/index.js";

const rect: ShapeInit = { kind: "rect", x: 1, y: 2, w: 3, h: 4, fill: "#ff0000", stroke: "#000000", z: 0 };
const stroke: ShapeInit = {
  kind: "stroke",
  points: [
    { x: 0, y: 0 },
    { x: 5, y: -6 },
  ],
  fill: "#00ff00",
  stroke: "#123456",
  z: 2,
};

/** Simulates the network: the op as it arrives after JSON parsing. */
function wire(op: Op): Record<string, unknown> {
  return JSON.parse(JSON.stringify(op)) as Record<string, unknown>;
}

function obj(v: unknown): Record<string, unknown> {
  return v as Record<string, unknown>;
}

/** A fresh, valid rectangle-creation op in wire form, safe to mutate. */
function createRaw(): Record<string, unknown> {
  return wire(new Doc("alpha").createShape(rect));
}

describe("validateOp accepts operations produced by Doc", () => {
  it("round-trips a rectangle create deep-equal to the original", () => {
    const op = new Doc("alpha").createShape(rect);
    expect(validateOp(op)).toEqual(op);
    expect(validateOp(wire(op))).toEqual(op);
  });

  it("round-trips an ellipse and a stroke create", () => {
    const doc = new Doc("alpha");
    const ellipse = doc.createShape({ ...rect, kind: "ellipse" });
    const pen = doc.createShape(stroke);
    expect(validateOp(wire(ellipse))).toEqual(ellipse);
    expect(validateOp(wire(pen))).toEqual(pen);
  });

  it("round-trips partial and full updates and deletes", () => {
    const doc = new Doc("alpha");
    const created = doc.createShape(rect);
    const partial = doc.updateShape(created.id, { x: -10 });
    const full = doc.updateShape(created.id, { x: 0, y: 1, w: 2, h: 3, fill: "#abcdef", stroke: "#fedcba", z: -1 });
    const removed = doc.deleteShape(created.id);
    for (const op of [partial, full, removed]) {
      expect(validateOp(wire(op))).toEqual(op);
    }
  });

  it("accepts a 64-character replica id", () => {
    const op = new Doc("r".repeat(64)).createShape(rect);
    expect(validateOp(wire(op))).toEqual(op);
  });

  it("round-trips random shapes and edits from Doc", () => {
    const coord = fc.integer({ min: -1_000_000, max: 1_000_000 });
    const colour = fc.stringMatching(/^#[0-9a-f]{6}$/);
    const boxArb = fc.record({
      kind: fc.constantFrom("rect" as const, "ellipse" as const),
      x: coord,
      y: coord,
      w: coord,
      h: coord,
      fill: colour,
      stroke: colour,
      z: coord,
    });
    const strokeArb = fc.record({
      kind: fc.constant("stroke" as const),
      points: fc.array(fc.record({ x: coord, y: coord }), { maxLength: 50 }),
      fill: colour,
      stroke: colour,
      z: coord,
    });
    fc.assert(
      fc.property(
        fc.oneof(boxArb, strokeArb),
        fc.stringMatching(/^[A-Za-z0-9_-]{1,64}$/),
        coord,
        (init, replica, z) => {
          const doc = new Doc(replica);
          const op = doc.createShape(init);
          const update = doc.updateShape(op.id, { z });
          expect(validateOp(wire(op))).toEqual(op);
          expect(validateOp(wire(update))).toEqual(update);
        },
      ),
    );
  });
});

describe("validateOp rejects invalid operations", () => {
  it.each([
    ["NaN coordinate", (raw: Record<string, unknown>) => (obj(raw.shape).x = NaN)],
    ["Infinity coordinate", (raw: Record<string, unknown>) => (obj(raw.shape).y = Infinity)],
    ["-Infinity width", (raw: Record<string, unknown>) => (obj(raw.shape).w = -Infinity)],
    ["coordinate above 1e6", (raw: Record<string, unknown>) => (obj(raw.shape).w = 1e6 + 1)],
    ["coordinate below -1e6", (raw: Record<string, unknown>) => (obj(raw.shape).h = -1e6 - 1)],
    ["z above 1e6", (raw: Record<string, unknown>) => (obj(raw.shape).z = 2e6)],
    ["string coordinate", (raw: Record<string, unknown>) => (obj(raw.shape).x = "1")],
    ["65-character replica", (raw: Record<string, unknown>) => {
      obj(raw.stamp).replica = "a".repeat(65);
      raw.id = `${"a".repeat(65)}:1`;
    }],
    ["replica with a space", (raw: Record<string, unknown>) => {
      obj(raw.stamp).replica = "has space";
      raw.id = "has space:1";
    }],
    ["empty replica", (raw: Record<string, unknown>) => {
      obj(raw.stamp).replica = "";
      raw.id = ":1";
    }],
    ["bad colour (uppercase)", (raw: Record<string, unknown>) => (obj(raw.shape).fill = "#FF0000")],
    ["bad colour (short form)", (raw: Record<string, unknown>) => (obj(raw.shape).stroke = "#000")],
    ["bad colour (name)", (raw: Record<string, unknown>) => (obj(raw.shape).fill = "red")],
    ["bad colour (alpha)", (raw: Record<string, unknown>) => (obj(raw.shape).fill = "#00000080")],
    ["missing z", (raw: Record<string, unknown>) => delete obj(raw.shape).z],
    ["missing x", (raw: Record<string, unknown>) => delete obj(raw.shape).x],
    ["missing fill", (raw: Record<string, unknown>) => delete obj(raw.shape).fill],
    ["unknown kind", (raw: Record<string, unknown>) => (obj(raw.shape).kind = "triangle")],
    ["missing kind", (raw: Record<string, unknown>) => delete obj(raw.shape).kind],
    ["negative lamport", (raw: Record<string, unknown>) => {
      obj(raw.stamp).lamport = -1;
      raw.id = "alpha:-1";
    }],
    ["fractional lamport", (raw: Record<string, unknown>) => {
      obj(raw.stamp).lamport = 1.5;
      raw.id = "alpha:1.5";
    }],
    ["lamport beyond MAX_SAFE_INTEGER", (raw: Record<string, unknown>) => {
      obj(raw.stamp).lamport = Number.MAX_SAFE_INTEGER + 1;
      raw.id = `alpha:${Number.MAX_SAFE_INTEGER + 1}`;
    }],
    ["lamport as string", (raw: Record<string, unknown>) => (obj(raw.stamp).lamport = "1")],
    ["id that does not match the stamp", (raw: Record<string, unknown>) => (raw.id = "alpha:2")],
    ["missing id", (raw: Record<string, unknown>) => delete raw.id],
    ["unknown op type", (raw: Record<string, unknown>) => (raw.type = "upsert")],
    ["missing stamp", (raw: Record<string, unknown>) => delete raw.stamp],
    ["missing shape", (raw: Record<string, unknown>) => delete raw.shape],
  ])("rejects a create with %s", (_name, mutate) => {
    const raw = createRaw();
    mutate(raw);
    expect(validateOp(raw)).toBeNull();
  });

  it("accepts a 2000-point stroke and rejects a 2001-point one", () => {
    const points = (n: number) => Array.from({ length: n }, () => ({ x: 0, y: 0 }));
    const at2000 = wire(new Doc("alpha").createShape({ ...stroke, points: points(2000) }));
    expect(validateOp(at2000)).not.toBeNull();
    const at2001 = wire(new Doc("alpha").createShape({ ...stroke, points: points(2000) }));
    obj(at2001.shape).points = points(2001);
    expect(validateOp(at2001)).toBeNull();
  });

  it("rejects stroke points that are malformed", () => {
    const withPoints = (points: unknown) => {
      const raw = wire(new Doc("alpha").createShape(stroke));
      obj(raw.shape).points = points;
      return raw;
    };
    expect(validateOp(withPoints([{ x: 1 }]))).toBeNull();
    expect(validateOp(withPoints([{ x: 1, y: Number.NaN }]))).toBeNull();
    expect(validateOp(withPoints([{ x: 1e6 + 1, y: 0 }]))).toBeNull();
    expect(validateOp(withPoints([null]))).toBeNull();
    expect(validateOp(withPoints([1, 2]))).toBeNull();
    expect(validateOp(withPoints({ 0: { x: 0, y: 0 }, length: 1 }))).toBeNull();
    expect(validateOp(withPoints(new Array(2)))).toBeNull();
  });

  it("rejects a stroke without points", () => {
    const raw = wire(new Doc("alpha").createShape(stroke));
    delete obj(raw.shape).points;
    expect(validateOp(raw)).toBeNull();
  });

  it("rejects an update without a shapeId", () => {
    const raw = wire(new Doc("alpha").updateShape("alpha:9", { x: 1 }));
    delete raw.shapeId;
    expect(validateOp(raw)).toBeNull();
  });

  it("rejects an update or delete whose shapeId is oversized", () => {
    const long = "s".repeat(65);
    expect(validateOp(wire(new Doc("alpha").updateShape(long, { x: 1 })))).toBeNull();
    expect(validateOp(wire(new Doc("alpha").deleteShape(long)))).toBeNull();
  });

  it("rejects an update whose known field holds an invalid value", () => {
    expect(validateOp(wire(new Doc("alpha").updateShape("alpha:1", { x: Number.NaN })))).toBeNull();
    expect(validateOp(wire(new Doc("alpha").updateShape("alpha:1", { fill: "blue" })))).toBeNull();
  });

  it("rejects a delete with a bad stamp", () => {
    const raw = wire(new Doc("alpha").deleteShape("alpha:1"));
    obj(raw.stamp).lamport = -5;
    raw.id = "alpha:-5";
    expect(validateOp(raw)).toBeNull();
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    ["NaN", Number.NaN],
    ["a string", "create"],
    ["a boolean", true],
    ["a bigint", 1n],
    ["an array", []],
    ["an array holding an op", [createRaw()]],
    ["a function", () => 1],
    ["a symbol", Symbol("op")],
  ])("returns null for %s", (_name, value) => {
    expect(validateOp(value)).toBeNull();
  });

  it("never copies unknown keys, and ignores prototype-polluting ones", () => {
    const raw = JSON.parse(
      '{"type":"create","id":"alpha:1","stamp":{"lamport":1,"replica":"alpha"},' +
        '"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},' +
        '"shape":{"kind":"rect","x":1,"y":2,"w":3,"h":4,"fill":"#000000","stroke":"#000000","z":0,' +
        '"__proto__":{"polluted":true},"extra":"kept out"}}',
    ) as Record<string, unknown>;
    const op = validateOp(raw);
    expect(op?.type).toBe("create");
    if (op?.type !== "create") {
      return;
    }
    expect(Object.keys(op).sort()).toEqual(["id", "shape", "stamp", "type"]);
    expect(Object.keys(op.shape).sort()).toEqual(["fill", "h", "kind", "stroke", "w", "x", "y", "z"]);
    expect(Object.getPrototypeOf(op.shape)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("drops unknown field keys from updates", () => {
    const raw = JSON.parse(
      '{"type":"update","id":"alpha:2","stamp":{"lamport":2,"replica":"alpha"},"shapeId":"alpha:1",' +
        '"fields":{"x":5,"__proto__":{"polluted":true},"kind":"ellipse","constructor":1}}',
    ) as Record<string, unknown>;
    const op = validateOp(raw);
    expect(op).toEqual({
      type: "update",
      id: "alpha:2",
      stamp: { lamport: 2, replica: "alpha" },
      shapeId: "alpha:1",
      fields: { x: 5 },
    });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("validateOp boundaries", () => {
  it("accepts coordinates exactly at the limit", () => {
    const raw = createRaw();
    Object.assign(obj(raw.shape), { x: 1e6, y: -1e6, w: 0, h: -0 });
    expect(validateOp(raw)).toMatchObject({ shape: { x: 1e6, y: -1e6, w: 0, h: 0 } });
  });

  it("normalises negative zero to zero", () => {
    const raw = createRaw();
    obj(raw.shape).z = -0;
    const op = validateOp(raw);
    expect(op?.type === "create" && Object.is(op.shape.z, 0)).toBe(true);
  });

  it("accepts the largest safe lamport and a zero lamport", () => {
    const max = Number.MAX_SAFE_INTEGER;
    const raw = createRaw();
    obj(raw.stamp).lamport = max;
    raw.id = `alpha:${max}`;
    expect(validateOp(raw)?.stamp).toEqual({ lamport: max, replica: "alpha" });

    const zero = createRaw();
    obj(zero.stamp).lamport = 0;
    zero.id = "alpha:0";
    expect(validateOp(zero)?.stamp).toEqual({ lamport: 0, replica: "alpha" });
  });

  it("accepts an update with no fields", () => {
    const op = { type: "update", id: "alpha:3", stamp: { lamport: 3, replica: "alpha" }, shapeId: "alpha:1", fields: {} };
    expect(validateOp(op)).toEqual(op);
  });

  it("accepts a stroke with no points", () => {
    const raw = wire(new Doc("alpha").createShape({ ...stroke, points: [] }));
    expect(validateOp(raw)).not.toBeNull();
  });
});

describe("validateOp properties", () => {
  it("never throws, and returns null or a JSON-stable value, for any input", () => {
    fc.assert(
      fc.property(fc.anything(), (x) => {
        const out = validateOp(x);
        if (out !== null) {
          expect(JSON.parse(JSON.stringify(out))).toEqual(out);
        }
      }),
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("never pollutes prototypes when given dangerous keys", () => {
    const keys = fc.constantFrom("__proto__", "constructor", "prototype", "type", "id", "stamp", "shape", "fields");
    fc.assert(
      fc.property(fc.array(fc.tuple(keys, fc.anything()), { maxLength: 8 }), (entries) => {
        const raw: Record<string, unknown> = { type: "create" };
        for (const [key, value] of entries) {
          Object.defineProperty(raw, key, { value, enumerable: true, writable: true, configurable: true });
        }
        const out = validateOp(raw);
        expect(out).toBeNull();
      }),
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("polluted");
  });
});
