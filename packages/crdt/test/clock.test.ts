import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Clock, compareStamps, type Stamp } from "../src/index.js";

const MAX = Number.MAX_SAFE_INTEGER;

const replicaArb = fc.stringMatching(/^[A-Za-z0-9_-]{1,8}$/);
const stampArb: fc.Arbitrary<Stamp> = fc.record({
  lamport: fc.integer({ min: 0, max: 5 }),
  replica: replicaArb,
});

describe("compareStamps", () => {
  it("is antisymmetric", () => {
    fc.assert(
      fc.property(stampArb, stampArb, (a, b) => {
        const forward = Math.sign(compareStamps(a, b));
        const backward = Math.sign(compareStamps(b, a));
        expect(forward + backward).toBe(0);
      }),
    );
  });

  it("is reflexive and returns 0 only for equal stamps", () => {
    fc.assert(
      fc.property(stampArb, stampArb, (a, b) => {
        expect(compareStamps(a, a)).toBe(0);
        const equal = a.lamport === b.lamport && a.replica === b.replica;
        expect(compareStamps(a, b) === 0).toBe(equal);
      }),
    );
  });

  it("is transitive", () => {
    fc.assert(
      fc.property(stampArb, stampArb, stampArb, (a, b, c) => {
        fc.pre(compareStamps(a, b) <= 0 && compareStamps(b, c) <= 0);
        expect(compareStamps(a, c)).toBeLessThanOrEqual(0);
      }),
    );
  });

  it("returns only -1, 0 or 1", () => {
    fc.assert(
      fc.property(stampArb, stampArb, (a, b) => {
        expect([-1, 0, 1]).toContain(compareStamps(a, b));
      }),
    );
  });

  it("orders by lamport before replica", () => {
    expect(compareStamps({ lamport: 1, replica: "z" }, { lamport: 2, replica: "a" })).toBe(-1);
    expect(compareStamps({ lamport: 3, replica: "a" }, { lamport: 2, replica: "z" })).toBe(1);
  });

  it("breaks lamport ties by replica", () => {
    expect(compareStamps({ lamport: 4, replica: "a" }, { lamport: 4, replica: "b" })).toBe(-1);
    expect(compareStamps({ lamport: 4, replica: "b" }, { lamport: 4, replica: "a" })).toBe(1);
    expect(compareStamps({ lamport: 4, replica: "a" }, { lamport: 4, replica: "a" })).toBe(0);
  });

  it("compares replicas by code unit, so uppercase sorts before lowercase", () => {
    expect(compareStamps({ lamport: 1, replica: "Z" }, { lamport: 1, replica: "a" })).toBe(-1);
    expect(compareStamps({ lamport: 1, replica: "a-" }, { lamport: 1, replica: "a" })).toBe(1);
    expect(compareStamps({ lamport: 1, replica: "a_" }, { lamport: 1, replica: "a-" })).toBe(1);
  });

  it("handles the largest safe integer", () => {
    expect(compareStamps({ lamport: MAX - 1, replica: "a" }, { lamport: MAX, replica: "a" })).toBe(
      -1,
    );
  });
});

describe("Clock", () => {
  it("rejects invalid replica ids", () => {
    expect(() => new Clock("")).toThrow(RangeError);
    expect(() => new Clock("a".repeat(65))).toThrow(RangeError);
    expect(() => new Clock("has space")).toThrow(RangeError);
    expect(() => new Clock("dot.id")).toThrow(RangeError);
    expect(() => new Clock("line\n")).toThrow(RangeError);
    expect(() => new Clock("é")).toThrow(RangeError);
  });

  it("accepts replica ids at the length and charset boundaries", () => {
    expect(() => new Clock("a")).not.toThrow();
    expect(() => new Clock("A_z-9".repeat(12) + "AB")).not.toThrow();
    expect(() => new Clock("x".repeat(64))).not.toThrow();
  });

  it("property: every replica id matching the pattern is accepted", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z0-9_-]{1,64}$/), (id) => {
        expect(() => new Clock(id)).not.toThrow();
      }),
    );
  });

  it("property: replica ids containing other characters are rejected", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 64 }).filter((s) => !/^[A-Za-z0-9_-]+$/.test(s)),
        (id) => {
          expect(() => new Clock(id)).toThrow(RangeError);
        },
      ),
    );
  });

  it("stamps carry the clock's replica and start at lamport 1", () => {
    const clock = new Clock("alpha");
    expect(clock.tick()).toEqual({ lamport: 1, replica: "alpha" });
  });

  it("property: tick is strictly increasing", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50 }), (n) => {
        const clock = new Clock("r1");
        let prev = clock.tick();
        for (let i = 1; i < n; i++) {
          const next = clock.tick();
          expect(compareStamps(next, prev)).toBe(1);
          prev = next;
        }
      }),
    );
  });

  it("observe raises the clock to the remote lamport", () => {
    const clock = new Clock("local");
    clock.observe({ lamport: 10, replica: "remote" });
    expect(clock.tick()).toEqual({ lamport: 11, replica: "local" });
  });

  it("observe never lowers the clock", () => {
    const clock = new Clock("local");
    clock.tick();
    clock.tick();
    clock.tick();
    clock.observe({ lamport: 1, replica: "remote" });
    expect(clock.tick()).toEqual({ lamport: 4, replica: "local" });
  });

  it("property: after observe(s), the next tick sorts after s", () => {
    fc.assert(
      fc.property(fc.array(stampArb, { maxLength: 20 }), (remotes) => {
        const clock = new Clock("local");
        for (const s of remotes) {
          clock.observe(s);
          expect(compareStamps(clock.tick(), s)).toBe(1);
        }
      }),
    );
  });

  it("property: ticks after a mix of ticks and observes are greater than everything seen", () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(fc.constant(null), stampArb), { maxLength: 30 }),
        (events) => {
          const clock = new Clock("local");
          let maxSeen: Stamp | null = null;
          for (const event of events) {
            if (event === null) {
              const t = clock.tick();
              if (maxSeen !== null) {
                expect(compareStamps(t, maxSeen)).toBe(1);
              }
              maxSeen = t;
            } else {
              clock.observe(event);
              if (maxSeen === null || compareStamps(event, maxSeen) > 0) {
                maxSeen = event;
              }
            }
          }
        },
      ),
    );
  });

  it("rejects a remote lamport that is not a safe integer", () => {
    const clock = new Clock("local");
    expect(() => clock.observe({ lamport: MAX + 1, replica: "remote" })).toThrow(RangeError);
    expect(() => clock.observe({ lamport: -1, replica: "remote" })).not.toThrow();
    expect(() => clock.observe({ lamport: 1.5, replica: "remote" })).toThrow(RangeError);
    expect(() => clock.observe({ lamport: Number.NaN, replica: "remote" })).toThrow(RangeError);
    expect(() => clock.observe({ lamport: Infinity, replica: "remote" })).toThrow(RangeError);
  });

  it("throws on tick when the lamport would exceed MAX_SAFE_INTEGER", () => {
    const clock = new Clock("local");
    clock.observe({ lamport: MAX - 1, replica: "remote" });
    expect(clock.tick()).toEqual({ lamport: MAX, replica: "local" });
    expect(() => clock.tick()).toThrow(RangeError);
    expect(() => clock.tick()).toThrow(RangeError);
  });

  it("throws on tick after observing MAX_SAFE_INTEGER", () => {
    const clock = new Clock("local");
    clock.observe({ lamport: MAX, replica: "remote" });
    expect(() => clock.tick()).toThrow(RangeError);
  });
});
