import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Doc, type Op } from "@collab-canvas/crdt";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SNAPSHOT_EVERY, Store } from "../src/index.js";

/** Returns `count` independent create ops authored by `replica`. */
function makeOps(replica: string, count: number): Op[] {
  const doc = new Doc(replica);
  const ops: Op[] = [];
  for (let i = 0; i < count; i++) {
    ops.push(
      doc.createShape({
        kind: "rect",
        x: i,
        y: 0,
        w: 10,
        h: 10,
        fill: "#ffffff",
        stroke: "#000000",
        z: i,
      }),
    );
  }
  return ops;
}

describe("Store: operation log", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("round-trips ops in append order", () => {
    const ops = makeOps("alice", 5);
    for (const op of ops) {
      expect(store.appendOp("demo", op)).toBe(true);
    }
    const loaded = store.load("demo");
    expect(loaded.snapshot).toBeNull();
    expect(loaded.skipped).toBe(0);
    expect(loaded.ops).toEqual(ops);
  });

  it("returns false for a duplicate op id and stores nothing new", () => {
    const [op] = makeOps("alice", 1);
    if (op === undefined) throw new Error("fixture missing");
    expect(store.appendOp("demo", op)).toBe(true);
    expect(store.appendOp("demo", op)).toBe(false);
    expect(store.lastSeq("demo")).toBe(1);
    expect(store.load("demo").ops).toEqual([op]);
  });

  it("stores the same op id in two different rooms", () => {
    const [op] = makeOps("alice", 1);
    if (op === undefined) throw new Error("fixture missing");
    expect(store.appendOp("room-a", op)).toBe(true);
    expect(store.appendOp("room-b", op)).toBe(true);
    expect(store.lastSeq("room-a")).toBe(1);
    expect(store.lastSeq("room-b")).toBe(1);
    expect(store.load("room-a").ops).toEqual([op]);
    expect(store.load("room-b").ops).toEqual([op]);
  });

  it("lets a pre-registered id in one room not block the same id in another", () => {
    const [op] = makeOps("mallory", 1);
    if (op === undefined) throw new Error("fixture missing");
    expect(store.appendOp("room-b", op)).toBe(true);
    expect(store.appendOp("room-a", op)).toBe(true);
    expect(store.appendOp("room-a", op)).toBe(false);
    expect(store.load("room-a").ops).toEqual([op]);
  });

  it("assigns seq monotonically per room and independently across rooms", () => {
    const ops = makeOps("alice", 4);
    const [a0, a1, a2, a3] = ops;
    if (a0 === undefined || a1 === undefined || a2 === undefined || a3 === undefined) {
      throw new Error("fixture missing");
    }
    expect(store.lastSeq("a")).toBe(0);
    store.appendOp("a", a0);
    store.appendOp("b", a1);
    store.appendOp("a", a2);
    store.appendOp("a", a3);
    expect(store.lastSeq("a")).toBe(3);
    expect(store.lastSeq("b")).toBe(1);
    expect(store.lastSeq("c")).toBe(0);
    expect(store.load("b").ops).toEqual([a1]);
    expect(store.load("a").ops).toEqual([a0, a2, a3]);
  });

  it("keeps room names literal, including quotes and SQL fragments", () => {
    const names = ["it's", 'say "hi"', "x'); DROP TABLE ops; --", "it''s", "%", "_"];
    const ops = makeOps("alice", names.length);
    names.forEach((name, i) => {
      const op = ops[i];
      if (op === undefined) throw new Error("fixture missing");
      expect(store.appendOp(name, op)).toBe(true);
    });
    for (const [i, name] of names.entries()) {
      expect(store.lastSeq(name)).toBe(1);
      expect(store.load(name).ops).toEqual([ops[i]]);
    }
    expect(store.load("it").ops).toEqual([]);
    expect(store.load("").ops).toEqual([]);
  });

  it("persists across reopen of the same file", () => {
    const dir = mkdtempSync(join(tmpdir(), "collab-store-"));
    try {
      const path = join(dir, "log.db");
      const ops = makeOps("alice", 3);
      const first = new Store(path);
      for (const op of ops) first.appendOp("demo", op);
      first.close();

      const second = new Store(path);
      try {
        expect(second.load("demo").ops).toEqual(ops);
        expect(second.appendOp("demo", makeOps("bob", 1)[0] as Op)).toBe(true);
        expect(second.lastSeq("demo")).toBe(4);
      } finally {
        second.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enables WAL journal mode for file databases", () => {
    const dir = mkdtempSync(join(tmpdir(), "collab-store-"));
    try {
      const path = join(dir, "wal.db");
      const opened = new Store(path);
      const probe = new DatabaseSync(path);
      try {
        const row = probe.prepare("PRAGMA journal_mode").get();
        expect(row?.journal_mode).toBe("wal");
      } finally {
        probe.close();
        opened.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("property: accepted ops keep dense per-room order and reject duplicates within a room", () => {
    const rooms = ["alpha", "beta", "it's \"quoted\""];
    const pool = makeOps("prop", 8);
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.integer({ min: 0, max: rooms.length - 1 }),
            fc.integer({ min: 0, max: pool.length - 1 }),
          ),
          { maxLength: 60 },
        ),
        (steps) => {
          const local = new Store(":memory:");
          try {
            const seen = new Map<string, Set<string>>(rooms.map((room) => [room, new Set()]));
            const expected = new Map<string, Op[]>(rooms.map((room) => [room, []]));
            for (const [roomIndex, opIndex] of steps) {
              const room = rooms[roomIndex] as string;
              const op = pool[opIndex] as Op;
              const roomSeen = seen.get(room) as Set<string>;
              const accepted = local.appendOp(room, op);
              expect(accepted).toBe(!roomSeen.has(op.id));
              if (accepted) {
                roomSeen.add(op.id);
                expected.get(room)?.push(op);
              }
            }
            for (const room of rooms) {
              const want = expected.get(room) ?? [];
              expect(local.lastSeq(room)).toBe(want.length);
              expect(local.load(room).ops).toEqual(want);
            }
          } finally {
            local.close();
          }
        },
      ),
    );
  });
});

describe("Store: snapshots", () => {
  it("uses 500 as the default snapshot interval", () => {
    const store = new Store(":memory:");
    try {
      expect(DEFAULT_SNAPSHOT_EVERY).toBe(500);
      expect(store.shouldSnapshot(499)).toBe(false);
      expect(store.shouldSnapshot(500)).toBe(true);
      expect(store.shouldSnapshot(1000)).toBe(true);
    } finally {
      store.close();
    }
  });

  it("decides snapshot points with seq % snapshotEvery === 0", () => {
    const store = new Store(":memory:", { snapshotEvery: 3 });
    try {
      const due = Array.from({ length: 9 }, (_, i) => i + 1).filter((seq) => store.shouldSnapshot(seq));
      expect(due).toEqual([3, 6, 9]);
    } finally {
      store.close();
    }
  });

  it("loads the latest snapshot and only the ops after it", () => {
    const store = new Store(":memory:", { snapshotEvery: 3 });
    try {
      const ops = makeOps("alice", 7);
      for (const [i, op] of ops.entries()) {
        expect(store.appendOp("demo", op)).toBe(true);
        const seq = store.lastSeq("demo");
        expect(seq).toBe(i + 1);
        if (store.shouldSnapshot(seq)) {
          store.saveSnapshot("demo", seq, `state-${seq}`);
        }
      }
      const loaded = store.load("demo");
      expect(loaded.snapshot).toEqual({ seq: 6, json: "state-6" });
      expect(loaded.ops).toEqual(ops.slice(6));
      expect(loaded.skipped).toBe(0);
    } finally {
      store.close();
    }
  });

  it("picks the snapshot with the highest seq regardless of save order", () => {
    const store = new Store(":memory:");
    try {
      store.saveSnapshot("demo", 6, "six");
      store.saveSnapshot("demo", 3, "three");
      expect(store.load("demo").snapshot).toEqual({ seq: 6, json: "six" });
    } finally {
      store.close();
    }
  });

  it("replaces a snapshot saved twice for the same seq", () => {
    const store = new Store(":memory:");
    try {
      store.saveSnapshot("demo", 3, "first");
      store.saveSnapshot("demo", 3, "second");
      expect(store.load("demo").snapshot).toEqual({ seq: 3, json: "second" });
    } finally {
      store.close();
    }
  });

  it("returns all ops and no snapshot when the snapshot is absent", () => {
    const store = new Store(":memory:", { snapshotEvery: 3 });
    try {
      const ops = makeOps("alice", 2);
      for (const op of ops) store.appendOp("demo", op);
      expect(store.load("demo")).toEqual({ snapshot: null, ops, skipped: 0 });
    } finally {
      store.close();
    }
  });

  it("keeps snapshots of different rooms apart", () => {
    const store = new Store(":memory:");
    try {
      store.saveSnapshot("a", 2, "a-state");
      expect(store.load("b").snapshot).toBeNull();
      expect(store.load("a").snapshot).toEqual({ seq: 2, json: "a-state" });
    } finally {
      store.close();
    }
  });

  it("rejects an invalid seq for a snapshot", () => {
    const store = new Store(":memory:");
    try {
      expect(() => store.saveSnapshot("demo", -1, "{}")).toThrow(RangeError);
      expect(() => store.saveSnapshot("demo", 1.5, "{}")).toThrow(RangeError);
      expect(() => store.saveSnapshot("demo", Number.NaN, "{}")).toThrow(RangeError);
      expect(store.load("demo").snapshot).toBeNull();
    } finally {
      store.close();
    }
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects snapshotEvery %s", (snapshotEvery) => {
    expect(() => new Store(":memory:", { snapshotEvery })).toThrow(RangeError);
  });
});

describe("Store: corrupted rows", () => {
  it("skips and counts rows that fail to parse or validate instead of throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "collab-store-"));
    try {
      const path = join(dir, "corrupt.db");
      const store = new Store(path);
      try {
        const ops = makeOps("alice", 2);
        expect(store.appendOp("demo", ops[0] as Op)).toBe(true);

        // Write rows straight through a second handle to simulate on-disk corruption.
        const raw = new DatabaseSync(path);
        try {
          const insert = raw.prepare("INSERT INTO ops (room, seq, id, json) VALUES (?, ?, ?, ?)");
          insert.run("demo", 2, "bad:1", "{not json");
          insert.run("demo", 3, "bad:2", '{"type":"create"}');
          insert.run("demo", 4, "bad:3", "null");
        } finally {
          raw.close();
        }
        expect(store.appendOp("demo", ops[1] as Op)).toBe(true);

        const loaded = store.load("demo");
        expect(loaded.skipped).toBe(3);
        expect(loaded.ops).toEqual(ops);
        expect(loaded.snapshot).toBeNull();
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
