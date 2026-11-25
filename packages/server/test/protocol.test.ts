import { Doc, type Op } from "@collab-canvas/crdt";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  encodeServerFrame,
  invalidFrameError,
  parseClientFrame,
  type ServerFrame,
} from "../src/protocol.js";

const MAX_FRAME_BYTES = 64 * 1024;

function sampleOp(): Op {
  return new Doc("client-1").createShape({
    kind: "rect",
    x: 0,
    y: 0,
    w: 10,
    h: 10,
    fill: "#ffffff",
    stroke: "#000000",
    z: 1,
  });
}

/** Returns a deep, mutable copy of a JSON-compatible value. */
function clone<T>(value: T): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function presenceText(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: "presence", x: 1, y: 2, name: "Ana", color: "#1a2b3c", ...overrides });
}

describe("parseClientFrame: valid frames", () => {
  it("parses hello", () => {
    expect(parseClientFrame('{"type":"hello","room":"demo-1","replica":"abc_DEF-1"}')).toEqual({
      type: "hello",
      room: "demo-1",
      replica: "abc_DEF-1",
    });
  });

  it("parses op and rebuilds the operation", () => {
    const op = sampleOp();
    const frame = parseClientFrame(JSON.stringify({ type: "op", op }));
    expect(frame).toEqual({ type: "op", op });
  });

  it("parses presence", () => {
    expect(parseClientFrame(presenceText())).toEqual({
      type: "presence",
      x: 1,
      y: 2,
      name: "Ana",
      color: "#1a2b3c",
    });
  });

  it("accepts presence coordinates at the magnitude limit", () => {
    expect(parseClientFrame(presenceText({ x: 1e6, y: -1e6 }))).toMatchObject({ x: 1e6, y: -1e6 });
  });

  it("accepts a name of exactly 32 code points, counting astral characters once", () => {
    const name = "😀".repeat(32);
    expect(parseClientFrame(presenceText({ name }))).toMatchObject({ name });
  });

  it("accepts an empty name", () => {
    expect(parseClientFrame(presenceText({ name: "" }))).toMatchObject({ name: "" });
  });

  it("drops unknown keys from valid frames", () => {
    const frame = parseClientFrame('{"type":"hello","room":"a","replica":"b","extra":true}');
    expect(frame).toEqual({ type: "hello", room: "a", replica: "b" });
  });

  it("accepts a frame of exactly 64 KiB", () => {
    const base = presenceText({ pad: "" });
    const padding = "a".repeat(MAX_FRAME_BYTES - Buffer.byteLength(base, "utf8"));
    const text = presenceText({ pad: padding });
    expect(Buffer.byteLength(text, "utf8")).toBe(MAX_FRAME_BYTES);
    expect(parseClientFrame(text)).not.toBeNull();
  });

  it("drops a nested __proto__ key from an op instead of copying it", () => {
    const text = JSON.stringify({ type: "op", op: sampleOp() }).replace(
      '"op":{',
      '"op":{"__proto__":{"polluted":true},',
    );
    const frame = parseClientFrame(text);
    expect(frame?.type).toBe("op");
    if (frame?.type !== "op") {
      return;
    }
    expect(Object.hasOwn(frame.op, "__proto__")).toBe(false);
    expect(Object.getPrototypeOf(frame.op)).toBe(Object.prototype);
  });
});

describe("parseClientFrame: invalid frames", () => {
  it.each([
    ["empty text", ""],
    ["plain text", "hello"],
    ["truncated JSON", '{"type":"hello"'],
    ["JSON array", "[]"],
    ["JSON null", "null"],
    ["JSON number", "42"],
    ["JSON string", '"hello"'],
    ["missing type", '{"room":"a","replica":"b"}'],
    ["unknown type", '{"type":"ping"}'],
    ["type naming an Object prototype member", '{"type":"toString"}'],
  ])("rejects %s", (_label, text) => {
    expect(parseClientFrame(text)).toBeNull();
  });

  it.each([
    ["uppercase", "Demo"],
    ["empty", ""],
    ["33 characters", "a".repeat(33)],
    ["underscore", "a_b"],
    ["space", "a b"],
    ["non-ASCII", "sala-ñ"],
    ["trailing newline", "demo\n"],
  ])("rejects room name: %s", (_label, room) => {
    expect(parseClientFrame(JSON.stringify({ type: "hello", room, replica: "r1" }))).toBeNull();
  });

  it.each([
    ["empty", ""],
    ["65 characters", "a".repeat(65)],
    ["dot", "a.b"],
    ["slash", "a/b"],
    ["space", "a b"],
  ])("rejects replica: %s", (_label, replica) => {
    expect(parseClientFrame(JSON.stringify({ type: "hello", room: "demo", replica }))).toBeNull();
  });

  it("rejects hello with a missing or non-string field", () => {
    expect(parseClientFrame('{"type":"hello","room":"demo"}')).toBeNull();
    expect(parseClientFrame('{"type":"hello","room":["demo"],"replica":"r1"}')).toBeNull();
  });

  it("rejects a frame one byte over 64 KiB", () => {
    const base = presenceText({ pad: "" });
    const padding = "a".repeat(MAX_FRAME_BYTES + 1 - Buffer.byteLength(base, "utf8"));
    const text = presenceText({ pad: padding });
    expect(Buffer.byteLength(text, "utf8")).toBe(MAX_FRAME_BYTES + 1);
    expect(parseClientFrame(text)).toBeNull();
  });

  it("counts UTF-8 bytes, not UTF-16 units, against the limit", () => {
    // Each "é" is two bytes in UTF-8 but one UTF-16 unit, so 32769 of them exceed 64 KiB.
    const text = JSON.stringify({ type: "hello", room: "a", replica: "b", pad: "é".repeat(32 * 1024 + 1) });
    expect(text.length).toBeLessThan(MAX_FRAME_BYTES);
    expect(Buffer.byteLength(text, "utf8")).toBeGreaterThan(MAX_FRAME_BYTES);
    expect(parseClientFrame(text)).toBeNull();
  });

  it("rejects op frames whose operation fails validateOp", () => {
    const op = clone(sampleOp());
    op.stamp = { lamport: -1, replica: "client-1" };
    expect(parseClientFrame(JSON.stringify({ type: "op", op }))).toBeNull();
  });

  it("rejects op frames with a mismatched id", () => {
    const op = clone(sampleOp());
    op.id = "client-1:999";
    expect(parseClientFrame(JSON.stringify({ type: "op", op }))).toBeNull();
  });

  it("rejects op frames without an op", () => {
    expect(parseClientFrame('{"type":"op"}')).toBeNull();
    expect(parseClientFrame('{"type":"op","op":{"type":"delete"}}')).toBeNull();
  });

  it.each([
    ["x above the limit", { x: 1e6 + 1 }],
    ["y below the limit", { y: -1e6 - 1 }],
    ["x null (JSON cannot carry NaN or Infinity)", { x: null }],
    ["y as a string", { y: "2" }],
    ["x missing", { x: undefined }],
  ])("rejects presence with %s", (_label, overrides) => {
    expect(parseClientFrame(presenceText(overrides))).toBeNull();
  });

  it("rejects presence names longer than 32 code points", () => {
    expect(parseClientFrame(presenceText({ name: "a".repeat(33) }))).toBeNull();
    expect(parseClientFrame(presenceText({ name: "😀".repeat(33) }))).toBeNull();
  });

  it("rejects presence with a non-string name", () => {
    expect(parseClientFrame(presenceText({ name: 7 }))).toBeNull();
  });

  it("rejects presence that carries a replica, which only the server may set", () => {
    expect(parseClientFrame(presenceText({ replica: "someone-else" }))).toBeNull();
  });

  it.each([
    ["uppercase hex", "#FFFFFF"],
    ["short form", "#fff"],
    ["named colour", "red"],
    ["too long", "#ffffff0"],
    ["no hash", "ffffff"],
    ["trailing newline", "#ffffff\n"],
  ])("rejects presence colour: %s", (_label, color) => {
    expect(parseClientFrame(presenceText({ color }))).toBeNull();
  });

  it("rejects a top-level __proto__ key", () => {
    const text = '{"type":"hello","room":"a","replica":"b","__proto__":{"polluted":true}}';
    expect(parseClientFrame(text)).toBeNull();
  });
});

describe("parseClientFrame: fuzzing", () => {
  it("never throws on arbitrary strings", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        expect(() => parseClientFrame(text)).not.toThrow();
      }),
    );
  });

  it("never throws on JSON-serialised arbitrary values", () => {
    fc.assert(
      fc.property(fc.anything().filter((v) => JSON.stringify(v) !== undefined), (value) => {
        expect(() => parseClientFrame(JSON.stringify(value))).not.toThrow();
      }),
    );
  });

  it("round-trips any valid hello frame", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z0-9-]{1,32}$/),
        fc.stringMatching(/^[A-Za-z0-9_-]{1,64}$/),
        (room, replica) => {
          const frame = { type: "hello", room, replica };
          expect(parseClientFrame(JSON.stringify(frame))).toEqual(frame);
        },
      ),
    );
  });

  it("round-trips any valid presence frame", () => {
    const coordinate = fc.double({ min: -1e6, max: 1e6, noNaN: true }).map((v) => (Object.is(v, -0) ? 0 : v));
    fc.assert(
      fc.property(
        coordinate,
        coordinate,
        fc.string({ maxLength: 32 }),
        fc.stringMatching(/^#[0-9a-f]{6}$/),
        (x, y, name, color) => {
          const frame = { type: "presence", x, y, name, color };
          expect(parseClientFrame(JSON.stringify(frame))).toEqual(frame);
        },
      ),
    );
  });
});

describe("encodeServerFrame", () => {
  it("encodes welcome with the snapshot and ops", () => {
    const doc = new Doc("server");
    const frame: ServerFrame = { type: "welcome", snapshot: doc.snapshot(), ops: [sampleOp()] };
    expect(JSON.parse(encodeServerFrame(frame))).toEqual(JSON.parse(JSON.stringify(frame)));
  });

  it("encodes op frames", () => {
    const frame: ServerFrame = { type: "op", op: sampleOp() };
    expect(JSON.parse(encodeServerFrame(frame))).toEqual({ type: "op", op: frame.op });
  });

  it("encodes presence with the replica", () => {
    const frame: ServerFrame = {
      type: "presence",
      replica: "r1",
      x: 3,
      y: -4,
      name: "Ana",
      color: "#abcdef",
    };
    expect(JSON.parse(encodeServerFrame(frame))).toEqual(frame);
  });

  it("encodes leave", () => {
    expect(JSON.parse(encodeServerFrame({ type: "leave", replica: "r1" }))).toEqual({
      type: "leave",
      replica: "r1",
    });
  });

  it("encodes error", () => {
    const frame = invalidFrameError();
    expect(JSON.parse(encodeServerFrame(frame))).toEqual({
      type: "error",
      code: "invalid_frame",
      message: "invalid frame",
    });
  });

  it("writes only whitelisted keys even when the frame carries extras", () => {
    const leaked = { type: "presence", replica: "r1", x: 0, y: 0, name: "", color: "#000000", secret: 1 };
    const parsed = JSON.parse(encodeServerFrame(leaked as ServerFrame)) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(["color", "name", "replica", "type", "x", "y"]);
  });
});
