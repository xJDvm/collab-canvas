import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Doc, type MutableFields, type Op, type ShapeInit } from "../src/index.js";

const NUM_RUNS = 150;
const MAX_ACTIONS = 40;
const MAX_COPIES = 3;

/** Index of one of the three authoring replicas. */
type Author = 0 | 1 | 2;
const AUTHORS: readonly Author[] = [0, 1, 2];

/**
 * One sort key per replica. Deliveries are ordered by the key of the replica
 * they are delivered to, which yields an independent random permutation per
 * replica.
 */
type Schedule = readonly [number, number, number];

/**
 * A generated action. `target` indexes the shape ids created so far, modulo
 * their count, so that updates and deletes always refer to known shapes.
 * `copies` holds one entry per delivery of the resulting op: between one and
 * three duplicates.
 */
interface Action {
  readonly replica: Author;
  readonly kind: "create" | "update" | "delete";
  readonly target: number;
  readonly init: ShapeInit;
  readonly fields: Partial<MutableFields>;
  readonly copies: readonly Schedule[];
}

/** An op together with its delivery schedules. */
interface Entry {
  readonly op: Op;
  readonly copies: readonly Schedule[];
}

const coordArb = fc.integer({ min: -1000, max: 1000 });
const colorArb = fc.stringMatching(/^#[0-9a-f]{6}$/);
const zArb = fc.integer({ min: -3, max: 3 });
const unitArb = fc.double({ min: 0, max: 1, noNaN: true });

const initArb: fc.Arbitrary<ShapeInit> = fc.oneof(
  fc.record({
    kind: fc.constantFrom("rect" as const, "ellipse" as const),
    x: coordArb,
    y: coordArb,
    w: coordArb,
    h: coordArb,
    fill: colorArb,
    stroke: colorArb,
    z: zArb,
  }),
  fc.record({
    kind: fc.constant("stroke" as const),
    points: fc.array(fc.record({ x: coordArb, y: coordArb }), { maxLength: 4 }),
    fill: colorArb,
    stroke: colorArb,
    z: zArb,
  }),
);

const fieldsArb: fc.Arbitrary<Partial<MutableFields>> = fc.oneof(
  fc.record({ x: coordArb }),
  fc.record({ y: coordArb, w: coordArb }),
  fc.record({ h: coordArb }),
  fc.record({ fill: colorArb }),
  fc.record({ stroke: colorArb, z: zArb }),
);

const actionArb: fc.Arbitrary<Action> = fc.record({
  replica: fc.constantFrom(0 as const, 1 as const, 2 as const),
  kind: fc.constantFrom("create" as const, "update" as const, "delete" as const),
  target: fc.nat(),
  init: initArb,
  fields: fieldsArb,
  copies: fc.array(fc.tuple(unitArb, unitArb, unitArb), { minLength: 1, maxLength: MAX_COPIES }),
});

function json<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function makeReplicas(): [Doc, Doc, Doc] {
  return [new Doc("alpha"), new Doc("beta"), new Doc("gamma")];
}

/**
 * Performs each action on its author replica, in order, and returns the
 * resulting ops. Updates and deletes target ids created earlier in the
 * sequence, but the author may not have seen those shapes yet.
 */
function play(replicas: readonly [Doc, Doc, Doc], actions: readonly Action[]): Entry[] {
  const ids: string[] = [];
  const entries: Entry[] = [];
  for (const action of actions) {
    const doc = replicas[action.replica];
    const target = ids.length === 0 ? undefined : ids[action.target % ids.length];
    let op: Op;
    if (action.kind === "create" || target === undefined) {
      const created = doc.createShape(action.init);
      ids.push(created.id);
      op = created;
    } else if (action.kind === "update") {
      op = doc.updateShape(target, action.fields);
    } else {
      op = doc.deleteShape(target);
    }
    entries.push({ op, copies: action.copies });
  }
  return entries;
}

/** The ops delivered to replica `r`, duplicates included, in a random order. */
function deliveryOrder(entries: readonly Entry[], r: Author): Op[] {
  return entries
    .flatMap((entry) => entry.copies.map((schedule) => ({ op: entry.op, key: schedule[r] })))
    .sort((a, b) => a.key - b.key)
    .map((delivery) => delivery.op);
}

/** Delivers the full op set to every replica, each in its own random order with duplicates. */
function deliverEverywhere(replicas: readonly [Doc, Doc, Doc], entries: readonly Entry[]): void {
  for (const r of AUTHORS) {
    for (const op of deliveryOrder(entries, r)) {
      replicas[r].apply(op);
    }
  }
}

describe("convergence properties", () => {
  it("property: all replicas converge under random order and duplicate delivery", () => {
    fc.assert(
      fc.property(fc.array(actionArb, { maxLength: MAX_ACTIONS }), (actions) => {
        const replicas = makeReplicas();
        const entries = play(replicas, actions);
        deliverEverywhere(replicas, entries);

        const snaps = replicas.map((doc) => doc.snapshot());
        expect(snaps[1]).toEqual(snaps[0]);
        expect(snaps[2]).toEqual(snaps[0]);
        expect(snaps[0]?.seen).toHaveLength(entries.length);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("property: applying an op twice equals applying it once", () => {
    fc.assert(
      fc.property(fc.array(actionArb, { maxLength: MAX_ACTIONS }), (actions) => {
        const ops = play(makeReplicas(), actions).map((entry) => entry.op);
        const once = new Doc("once");
        const twice = new Doc("twice");
        for (const op of ops) {
          expect(once.apply(op)).toBe(true);
          expect(twice.apply(op)).toBe(true);
          const before = twice.snapshot();
          expect(twice.apply(op)).toBe(false);
          expect(twice.snapshot()).toEqual(before);
          expect(twice.snapshot()).toEqual(once.snapshot());
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("property: snapshot round-trip preserves state and visible shapes", () => {
    fc.assert(
      fc.property(fc.array(actionArb, { maxLength: MAX_ACTIONS }), (actions) => {
        const replicas = makeReplicas();
        deliverEverywhere(replicas, play(replicas, actions));
        for (const doc of replicas) {
          const snap = doc.snapshot();
          const restored = Doc.fromSnapshot("restored", json(snap));
          expect(restored.snapshot()).toEqual(snap);
          expect(restored.visibleShapes()).toEqual(doc.visibleShapes());
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("property: a deleted shape stays invisible on every replica, whatever updates follow", () => {
    fc.assert(
      fc.property(
        fc.array(actionArb, { maxLength: MAX_ACTIONS }),
        actionArb,
        fc.array(actionArb, { maxLength: 10 }),
        (before, seed, after) => {
          // The first action guarantees at least one shape exists to delete.
          const creation: Action = { ...seed, kind: "create" };
          const deletion: Action = { ...seed, kind: "delete" };
          // Later updates target the deleted shape and carry arbitrary stamps:
          // some are older than the delete, some newer.
          const updates = after.map((a) => ({ ...a, kind: "update" as const, target: seed.target }));
          const replicas = makeReplicas();
          const entries = play(replicas, [creation, ...before, deletion, ...updates]);
          deliverEverywhere(replicas, entries);

          const deleted = entries.flatMap((entry) =>
            entry.op.type === "delete" ? [entry.op.shapeId] : [],
          );
          expect(deleted.length).toBeGreaterThan(0);
          for (const doc of replicas) {
            const visible = new Set(doc.visibleShapes().map((shape) => shape.id));
            for (const id of deleted) {
              expect(visible.has(id)).toBe(false);
            }
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
