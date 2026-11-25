import { Doc, type Op } from "@collab-canvas/crdt";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_PENDING_OPS,
  appendPending,
  backoffDelay,
  parseServerFrame,
  prunePending,
  roomFromHash,
  statusKind,
} from "../src/net.js";
import type { Cursor } from "../src/render.js";
import {
  CURSOR_TTL_MS,
  CursorTable,
  PRESENCE_INTERVAL_MS,
  PresenceThrottle,
  presenceDelay,
} from "../src/presence.js";

const MIB = 1024 * 1024;

/** A real op produced by a fresh replica, so it passes the CRDT's own checks. */
function sampleOp(replica: string): Op {
  const doc = new Doc(replica);
  return doc.createShape({
    kind: "rect",
    x: 1,
    y: 2,
    w: 3,
    h: 4,
    fill: "#111111",
    stroke: "#222222",
    z: 0,
  });
}

function sampleSnapshot(): { shapes: []; seen: string[] } {
  return { shapes: [], seen: [] };
}

describe("parseServerFrame", () => {
  it("accepts a welcome frame with a snapshot and ops", () => {
    const frame = parseServerFrame(
      JSON.stringify({ type: "welcome", snapshot: sampleSnapshot(), ops: [] }),
    );
    expect(frame).toEqual({ type: "welcome", snapshot: sampleSnapshot(), ops: [] });
  });

  it("rejects a welcome whose snapshot or ops have the wrong shape", () => {
    const bad = [
      { type: "welcome", snapshot: null, ops: [] },
      { type: "welcome", snapshot: { shapes: {}, seen: [] }, ops: [] },
      { type: "welcome", snapshot: { shapes: [], seen: [1] }, ops: [] },
      { type: "welcome", snapshot: { shapes: [], seen: "x" }, ops: [] },
      { type: "welcome", snapshot: sampleSnapshot(), ops: "none" },
      { type: "welcome", snapshot: sampleSnapshot() },
    ];
    for (const value of bad) {
      expect(parseServerFrame(JSON.stringify(value))).toBeNull();
    }
  });

  it("accepts an op frame and passes the op through for validation", () => {
    const op = sampleOp("alpha");
    expect(parseServerFrame(JSON.stringify({ type: "op", op }))).toEqual({ type: "op", op });
  });

  it("rejects an op frame whose op is not an object", () => {
    expect(parseServerFrame(JSON.stringify({ type: "op", op: 7 }))).toBeNull();
    expect(parseServerFrame(JSON.stringify({ type: "op" }))).toBeNull();
  });

  it("accepts a presence frame with its cursor fields", () => {
    const frame = parseServerFrame(
      JSON.stringify({
        type: "presence",
        replica: "beta-1",
        x: 10.5,
        y: -3,
        name: "Ana",
        color: "#10b981",
      }),
    );
    expect(frame).toEqual({
      type: "presence",
      cursor: { replica: "beta-1", x: 10.5, y: -3, name: "Ana", color: "#10b981" },
    });
  });

  it("rejects presence frames with out-of-range fields", () => {
    const base = { type: "presence", replica: "beta", x: 1, y: 1, name: "Ana", color: "#10b981" };
    const bad = [
      { ...base, replica: "" },
      { ...base, replica: "has space" },
      { ...base, x: 1e6 + 1 },
      { ...base, y: Number.NaN },
      { ...base, x: "1" },
      { ...base, name: "" },
      { ...base, name: "x".repeat(33) },
      { ...base, color: "red" },
      { ...base, color: "#FFFFFF" },
    ];
    for (const value of bad) {
      expect(parseServerFrame(JSON.stringify(value))).toBeNull();
    }
  });

  it("accepts a name of exactly 32 code points, counting astral characters once", () => {
    const name = "😀".repeat(32);
    const frame = parseServerFrame(
      JSON.stringify({ type: "presence", replica: "beta", x: 0, y: 0, name, color: "#000000" }),
    );
    expect(frame).toMatchObject({ type: "presence", cursor: { name } });
    const longer = {
      type: "presence",
      replica: "beta",
      x: 0,
      y: 0,
      name: `${name}😀`,
      color: "#000000",
    };
    expect(parseServerFrame(JSON.stringify(longer))).toBeNull();
  });

  it("accepts a leave frame and rejects a bad replica id", () => {
    expect(parseServerFrame(JSON.stringify({ type: "leave", replica: "beta" }))).toEqual({
      type: "leave",
      replica: "beta",
    });
    expect(parseServerFrame(JSON.stringify({ type: "leave", replica: 3 }))).toBeNull();
    expect(parseServerFrame(JSON.stringify({ type: "leave", replica: "a/b" }))).toBeNull();
  });

  it("accepts an error frame with a code and message", () => {
    expect(
      parseServerFrame(JSON.stringify({ type: "error", code: "invalid_op", message: "nope" })),
    ).toEqual({ type: "error", code: "invalid_op", message: "nope" });
    expect(parseServerFrame(JSON.stringify({ type: "error", code: "invalid_op" }))).toBeNull();
  });

  it("rejects invalid JSON, non-objects and arrays", () => {
    expect(parseServerFrame("{not json")).toBeNull();
    expect(parseServerFrame("")).toBeNull();
    expect(parseServerFrame("null")).toBeNull();
    expect(parseServerFrame("[1,2]")).toBeNull();
    expect(parseServerFrame("\"op\"")).toBeNull();
  });

  it("rejects non-string input such as binary data", () => {
    expect(parseServerFrame(undefined)).toBeNull();
    expect(parseServerFrame(new ArrayBuffer(4))).toBeNull();
    expect(parseServerFrame({ type: "leave", replica: "beta" })).toBeNull();
  });

  it("rejects unknown frame types", () => {
    expect(parseServerFrame(JSON.stringify({ type: "shout", text: "hi" }))).toBeNull();
    expect(parseServerFrame(JSON.stringify({ text: "no type" }))).toBeNull();
  });

  it("accepts a frame of exactly 1 MiB and rejects one code unit more", () => {
    const head = JSON.stringify({ type: "leave", replica: "beta" });
    const exact = head + " ".repeat(MIB - head.length);
    expect(exact).toHaveLength(MIB);
    expect(parseServerFrame(exact)).toEqual({ type: "leave", replica: "beta" });
    expect(parseServerFrame(exact + " ")).toBeNull();
  });

  it("rejects a frame with a __proto__ key at the top level", () => {
    const text = '{"type":"leave","replica":"beta","__proto__":{"polluted":true}}';
    expect(parseServerFrame(text)).toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("rejects a __proto__ key nested inside a welcome snapshot", () => {
    const text =
      '{"type":"welcome","snapshot":{"shapes":[],"seen":[],"__proto__":{"x":1}},"ops":[]}';
    expect(parseServerFrame(text)).toBeNull();
  });

  it("never throws on arbitrary strings", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (text) => {
        expect(() => parseServerFrame(text)).not.toThrow();
      }),
    );
  });
});

describe("prunePending", () => {
  const pendingAndAcked = fc
    .uniqueArray(fc.stringMatching(/^[a-z]{1,4}:[0-9]{1,3}$/), { maxLength: 30 })
    .chain((ids) => fc.tuple(fc.constant(ids), fc.subarray(ids)));

  it("drops exactly the ops whose ids are acknowledged and keeps the order", () => {
    fc.assert(
      fc.property(pendingAndAcked, ([allIds, acked]) => {
        const pending = allIds.map((id) => ({ id }) as Op);
        const kept = prunePending(pending, acked);
        const ackSet = new Set(acked);
        expect(kept.map((op) => op.id)).toEqual(allIds.filter((id) => !ackSet.has(id)));
      }),
    );
  });

  it("returns a new array and leaves the input untouched", () => {
    const pending = [sampleOp("alpha")];
    const kept = prunePending(pending, []);
    expect(kept).not.toBe(pending);
    expect(kept).toEqual(pending);
    expect(pending).toHaveLength(1);
  });

  it("keeps everything when no id is acknowledged", () => {
    const pending = [sampleOp("alpha"), sampleOp("alpha")];
    expect(prunePending(pending, ["gamma:1"])).toEqual(pending);
  });
});

describe("appendPending", () => {
  it("appends in order while under the bound", () => {
    const a = sampleOp("alpha");
    const b = sampleOp("alpha");
    expect(appendPending([a], b)).toEqual([a, b]);
  });

  it("drops the oldest ops beyond the bound", () => {
    const ops = Array.from({ length: MAX_PENDING_OPS }, (_, i) => ({ id: `r:${i + 1}` }) as Op);
    const newest = { id: "r:new" } as Op;
    const next = appendPending(ops, newest);
    expect(next).toHaveLength(MAX_PENDING_OPS);
    expect(next[0]).toBe(ops[1]);
    expect(next.at(-1)).toBe(newest);
  });

  it("never exceeds the bound, whatever the sequence", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 20 }), (count) => {
        let pending: Op[] = [];
        for (let i = 0; i < count; i += 1) {
          pending = appendPending(pending, { id: `r:${i + 1}` } as Op);
        }
        expect(pending.length).toBeLessThanOrEqual(MAX_PENDING_OPS);
        expect(pending.length).toBe(Math.min(count, MAX_PENDING_OPS));
      }),
    );
  });
});

describe("backoffDelay", () => {
  it("doubles from 500 ms and caps at 10 000 ms", () => {
    const schedule = [0, 1, 2, 3, 4, 5, 6, 7].map(backoffDelay);
    expect(schedule).toEqual([500, 1000, 2000, 4000, 8000, 10_000, 10_000, 10_000]);
  });

  it("stays at the cap for very large attempt counts", () => {
    expect(backoffDelay(2000)).toBe(10_000);
    expect(backoffDelay(Number.MAX_SAFE_INTEGER)).toBe(10_000);
  });

  it("is non-decreasing and bounded for every attempt", () => {
    fc.assert(
      fc.property(fc.nat({ max: 5000 }), (attempt) => {
        const delay = backoffDelay(attempt);
        expect(delay).toBeGreaterThanOrEqual(500);
        expect(delay).toBeLessThanOrEqual(10_000);
        expect(backoffDelay(attempt + 1)).toBeGreaterThanOrEqual(delay);
      }),
    );
  });

  it("rejects negative, fractional and unsafe attempt counts", () => {
    expect(() => backoffDelay(-1)).toThrow(RangeError);
    expect(() => backoffDelay(1.5)).toThrow(RangeError);
    expect(() => backoffDelay(Number.NaN)).toThrow(RangeError);
    expect(() => backoffDelay(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe("statusKind", () => {
  it("maps every status string to its kind", () => {
    expect(statusKind("connecting")).toBe("connecting");
    expect(statusKind("online")).toBe("online");
    expect(statusKind("offline (retrying in 4s)")).toBe("offline");
  });
});

describe("roomFromHash", () => {
  it("reads a valid room and falls back to the default otherwise", () => {
    expect(roomFromHash("#room=team-42")).toBe("team-42");
    expect(roomFromHash("#room=Team")).toBe("demo");
    expect(roomFromHash("")).toBe("demo");
  });
});

describe("presenceDelay", () => {
  it("sends at once when nothing was sent yet", () => {
    expect(presenceDelay(null, 1000)).toBe(0);
  });

  it("waits out the rest of the interval after a send", () => {
    expect(presenceDelay(1000, 1000)).toBeCloseTo(PRESENCE_INTERVAL_MS);
    expect(presenceDelay(1000, 1020)).toBeCloseTo(PRESENCE_INTERVAL_MS - 20);
    expect(presenceDelay(1000, 1000 + PRESENCE_INTERVAL_MS)).toBe(0);
  });

  it("is bounded by the interval even when the clock goes backwards", () => {
    expect(presenceDelay(1000, 500)).toBe(PRESENCE_INTERVAL_MS);
  });

  it("never returns a negative delay", () => {
    fc.assert(
      fc.property(fc.nat(1e9), fc.nat(1e9), (last, now) => {
        const delay = presenceDelay(last, now);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(PRESENCE_INTERVAL_MS);
      }),
    );
  });
});

describe("PresenceThrottle", () => {
  let clock = 0;
  const now = (): number => clock;

  beforeEach(() => {
    clock = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Moves the fake clock and the fake timers together. */
  function advance(ms: number): void {
    clock += ms;
    vi.advanceTimersByTime(ms);
  }

  it("sends the first position immediately", () => {
    const sent: { x: number; y: number }[] = [];
    const throttle = new PresenceThrottle((p) => sent.push(p), now);
    throttle.offer({ x: 1, y: 1 });
    expect(sent).toEqual([{ x: 1, y: 1 }]);
  });

  it("drops intermediate positions and sends the newest when the slot opens", () => {
    const sent: { x: number; y: number }[] = [];
    const throttle = new PresenceThrottle((p) => sent.push(p), now);
    throttle.offer({ x: 0, y: 0 });
    throttle.offer({ x: 1, y: 0 });
    throttle.offer({ x: 2, y: 0 });
    expect(sent).toEqual([{ x: 0, y: 0 }]);
    advance(PRESENCE_INTERVAL_MS);
    expect(sent).toEqual([{ x: 0, y: 0 }, { x: 2, y: 0 }]);
  });

  it("sends at most one frame per interval under a burst, always ending on the newest", () => {
    const sent: { x: number; t: number }[] = [];
    const throttle = new PresenceThrottle((p) => sent.push({ x: p.x, t: clock }), now);
    for (let i = 0; i < 300; i += 1) {
      throttle.offer({ x: i, y: 0 });
      advance(1);
    }
    advance(PRESENCE_INTERVAL_MS);
    expect(sent.at(-1)?.x).toBe(299);
    for (let i = 1; i < sent.length; i += 1) {
      const gap = (sent[i]?.t ?? 0) - (sent[i - 1]?.t ?? 0);
      expect(gap).toBeGreaterThanOrEqual(PRESENCE_INTERVAL_MS);
    }
    expect(sent.length).toBeLessThanOrEqual(Math.ceil(300 / PRESENCE_INTERVAL_MS) + 1);
  });

  it("cancel discards the pending position", () => {
    const sent: number[] = [];
    const throttle = new PresenceThrottle((p) => sent.push(p.x), now);
    throttle.offer({ x: 0, y: 0 });
    throttle.offer({ x: 9, y: 0 });
    throttle.cancel();
    advance(PRESENCE_INTERVAL_MS * 3);
    expect(sent).toEqual([0]);
  });
});

describe("CursorTable", () => {
  const cursor = (replica: string, x = 0): Cursor => ({
    replica,
    x,
    y: 0,
    name: `peer ${replica}`,
    color: "#3b82f6",
  });

  it("keeps the latest position of a peer", () => {
    const table = new CursorTable();
    table.update(cursor("a", 1), 0);
    table.update(cursor("a", 5), 10);
    expect(table.list(10)).toEqual([cursor("a", 5)]);
  });

  it("removes a peer on leave and reports whether it was present", () => {
    const table = new CursorTable();
    table.update(cursor("a"), 0);
    expect(table.remove("a")).toBe(true);
    expect(table.remove("a")).toBe(false);
    expect(table.list(0)).toEqual([]);
  });

  it("hides a cursor from list() once it is 10 s old and drops it on expire()", () => {
    const table = new CursorTable();
    table.update(cursor("a"), 0);
    table.update(cursor("b"), 5000);
    expect(table.list(CURSOR_TTL_MS - 1).map((c) => c.replica)).toEqual(["a", "b"]);
    expect(table.list(CURSOR_TTL_MS)).toEqual([cursor("b")]);
    expect(table.expire(CURSOR_TTL_MS - 1)).toBe(false);
    expect(table.expire(CURSOR_TTL_MS)).toBe(true);
    expect(table.expire(CURSOR_TTL_MS)).toBe(false);
    expect(table.list(5000).map((c) => c.replica)).toEqual(["b"]);
  });

  it("a fresh update keeps a peer alive", () => {
    const table = new CursorTable();
    table.update(cursor("a"), 0);
    table.update(cursor("a"), CURSOR_TTL_MS - 1);
    expect(table.expire(CURSOR_TTL_MS + 1000)).toBe(false);
    expect(table.list(CURSOR_TTL_MS + 1000)).toHaveLength(1);
  });

  it("clear removes everything", () => {
    const table = new CursorTable();
    table.update(cursor("a"), 0);
    table.clear();
    expect(table.list(0)).toEqual([]);
  });
});
