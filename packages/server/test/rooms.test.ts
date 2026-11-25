import { Doc, type Op } from "@collab-canvas/crdt";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { type ServerFrame } from "../src/protocol.js";
import { TokenBucket } from "../src/rate-limit.js";
import { Room, type RoomMember } from "../src/room.js";
import { Store } from "../src/store.js";

/** A member that records every frame delivered to it, decoded. */
class Recorder implements RoomMember {
  readonly replica: string;
  readonly frames: ServerFrame[] = [];

  constructor(replica: string) {
    this.replica = replica;
  }

  deliver(text: string): void {
    this.frames.push(JSON.parse(text) as ServerFrame);
  }

  /** Returns the frames of type `op` and clears them. */
  takeOps(): Op[] {
    const ops = this.frames.filter((f) => f.type === "op").map((f) => f.op);
    this.frames.length = 0;
    return ops;
  }
}

/** Returns `count` distinct create ops authored by `replica`, with unique op ids. */
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

describe("TokenBucket", () => {
  it("starts full and refuses once the burst is spent", () => {
    const bucket = new TokenBucket(10, 3, 0);
    expect([bucket.tryTake(0), bucket.tryTake(0), bucket.tryTake(0), bucket.tryTake(0)]).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  it("refills at the configured rate", () => {
    const bucket = new TokenBucket(10, 1, 0);
    expect(bucket.tryTake(0)).toBe(true);
    expect(bucket.tryTake(99)).toBe(false);
    expect(bucket.tryTake(100)).toBe(true);
  });

  it("never holds more than its capacity", () => {
    const bucket = new TokenBucket(10, 3, 0);
    expect(bucket.tryTake(0)).toBe(true);
    expect(bucket.tryTake(60_000)).toBe(true);
    expect(bucket.tryTake(60_000)).toBe(true);
    expect(bucket.tryTake(60_000)).toBe(true);
    expect(bucket.tryTake(60_000)).toBe(false);
  });

  it("ignores time that goes backwards", () => {
    const bucket = new TokenBucket(10, 1, 1000);
    expect(bucket.tryTake(1000)).toBe(true);
    expect(bucket.tryTake(500)).toBe(false);
    expect(bucket.tryTake(1100)).toBe(true);
  });

  it("rejects a non-positive or non-finite rate", () => {
    for (const rate of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new TokenBucket(rate, 1, 0)).toThrow(RangeError);
    }
  });

  it("rejects a capacity below one or not finite", () => {
    for (const capacity of [0, 0.5, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new TokenBucket(10, capacity, 0)).toThrow(RangeError);
    }
  });

  it("never admits more than capacity plus the refill earned so far", () => {
    fc.assert(
      fc.property(fc.array(fc.nat({ max: 500 }), { maxLength: 200 }), (gaps) => {
        const rate = 10;
        const capacity = 5;
        const bucket = new TokenBucket(rate, capacity, 0);
        let now = 0;
        let admitted = 0;
        for (const gap of gaps) {
          now += gap;
          if (bucket.tryTake(now)) {
            admitted++;
          }
        }
        expect(admitted).toBeLessThanOrEqual(capacity + (rate * now) / 1000);
      }),
    );
  });
});

describe("loadConfig", () => {
  it("uses the design defaults for an empty environment", () => {
    const config = loadConfig({});
    expect(config).toEqual({
      host: "127.0.0.1",
      port: 8787,
      dbPath: "./collab-canvas.db",
      maxPayload: 64 * 1024,
      maxConnections: 200,
      maxConnectionsPerRoom: 50,
      opsPerSecond: 60,
      opsBurst: 120,
      presencePerSecond: 30,
      heartbeatIntervalMs: 15_000,
      heartbeatTimeoutMs: 30_000,
      helloTimeoutMs: 5_000,
      maxInvalidFrames: 5,
    });
  });

  it("reads HOST, PORT and DB_PATH", () => {
    const config = loadConfig({ HOST: "0.0.0.0", PORT: "9000", DB_PATH: "/var/data/room.db" });
    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(9000);
    expect(config.dbPath).toBe("/var/data/room.db");
  });

  it("accepts the bounds of the port range", () => {
    expect(loadConfig({ PORT: "0" }).port).toBe(0);
    expect(loadConfig({ PORT: "65535" }).port).toBe(65535);
  });

  it("accepts every integer port in range", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 65535 }), (port) => {
        expect(loadConfig({ PORT: String(port) }).port).toBe(port);
      }),
    );
  });

  it.each(["", "-1", "65536", "99999", "1.5", "1e3", "0x10", "08787", " 80", "abc"])(
    "rejects PORT %j without echoing it",
    (raw) => {
      let message = "";
      try {
        loadConfig({ PORT: raw });
      } catch (error) {
        message = error instanceof Error ? error.message : "";
      }
      expect(message).toContain("PORT");
      if (raw !== "") {
        expect(message).not.toContain(raw);
      }
    },
  );

  it("rejects an empty or whitespace-containing HOST", () => {
    expect(() => loadConfig({ HOST: "" })).toThrow(RangeError);
    expect(() => loadConfig({ HOST: "127.0.0.1 " })).toThrow(RangeError);
    expect(() => loadConfig({ HOST: "x".repeat(254) })).toThrow(RangeError);
  });

  it("rejects an empty DB_PATH or one containing NUL", () => {
    expect(() => loadConfig({ DB_PATH: "" })).toThrow(RangeError);
    expect(() => loadConfig({ DB_PATH: "a\u0000b" })).toThrow(RangeError);
  });
});

describe("Room", () => {
  it("welcomes a joining member with the full snapshot and no ops", () => {
    const room = Room.load("demo", new Store(":memory:"), 50);
    const member = new Recorder("alice");
    expect(room.join(member)).toBe("joined");
    expect(member.frames).toEqual([
      { type: "welcome", snapshot: new Doc("server").snapshot(), ops: [] },
    ]);
  });

  it("broadcasts an accepted op to every member except its sender", () => {
    const room = Room.load("demo", new Store(":memory:"), 50);
    const alice = new Recorder("alice");
    const bob = new Recorder("bob");
    const carol = new Recorder("carol");
    room.join(alice);
    room.join(bob);
    room.join(carol);
    alice.frames.length = 0;
    bob.frames.length = 0;
    carol.frames.length = 0;

    const [op] = makeOps("alice", 1);
    if (op === undefined) throw new Error("fixture missing");
    room.submitOp("alice", op);

    expect(alice.takeOps()).toEqual([]);
    expect(bob.takeOps()).toEqual([op]);
    expect(carol.takeOps()).toEqual([op]);
  });

  it("does not rebroadcast an op that was already applied", () => {
    const room = Room.load("demo", new Store(":memory:"), 50);
    const alice = new Recorder("alice");
    const bob = new Recorder("bob");
    room.join(alice);
    room.join(bob);
    bob.frames.length = 0;

    const [op] = makeOps("alice", 1);
    if (op === undefined) throw new Error("fixture missing");
    room.submitOp("alice", op);
    room.submitOp("alice", op);
    expect(bob.takeOps()).toEqual([op]);
  });

  it("rebuilds the same state from the store after a restart", () => {
    const store = new Store(":memory:");
    const first = Room.load("demo", store, 50);
    const alice = new Recorder("alice");
    first.join(alice);
    const ops = makeOps("alice", 2);
    for (const op of ops) {
      first.submitOp("alice", op);
    }
    const checker = new Recorder("checker");
    first.join(checker);
    const before = (checker.frames[0] as Extract<ServerFrame, { type: "welcome" }>).snapshot;

    const reloaded = Room.load("demo", store, 50);
    const bob = new Recorder("bob");
    reloaded.join(bob);
    const after = (bob.frames[0] as Extract<ServerFrame, { type: "welcome" }>).snapshot;

    expect(after).toEqual(before);
    expect(after.shapes.map((s) => s.id)).toEqual(ops.map((op) => op.id));
  });

  it("writes snapshots at the store interval and loads from the latest one", () => {
    const store = new Store(":memory:", { snapshotEvery: 2 });
    const room = Room.load("demo", store, 50);
    const alice = new Recorder("alice");
    room.join(alice);
    const ops = makeOps("alice", 3);
    for (const op of ops) {
      room.submitOp("alice", op);
    }

    const loaded = store.load("demo");
    expect(loaded.snapshot?.seq).toBe(2);
    expect(loaded.ops).toHaveLength(1);

    const expected = new Doc("server");
    for (const op of ops) {
      expected.apply(op);
    }
    const reloaded = Room.load("demo", store, 50);
    const bob = new Recorder("bob");
    reloaded.join(bob);
    const welcome = bob.frames[0] as Extract<ServerFrame, { type: "welcome" }>;
    expect(welcome.snapshot).toEqual(expected.snapshot());
  });

  it("neither persists nor broadcasts an op already recorded in another room", () => {
    const store = new Store(":memory:");
    const source = Room.load("source", store, 50);
    const target = Room.load("target", store, 50);
    const alice = new Recorder("alice");
    const bob = new Recorder("bob");
    source.join(alice);
    target.join(bob);
    alice.frames.length = 0;
    bob.frames.length = 0;

    const [op] = makeOps("alice", 1);
    if (op === undefined) throw new Error("fixture missing");
    source.submitOp("alice", op);
    target.submitOp("alice", op);

    expect(bob.takeOps()).toEqual([]);
    expect(store.load("target").ops).toEqual([]);
  });

  it("rejects a duplicate replica without sending anything", () => {
    const room = Room.load("demo", new Store(":memory:"), 50);
    const first = new Recorder("alice");
    room.join(first);
    const second = new Recorder("alice");
    expect(room.join(second)).toBe("duplicate");
    expect(second.frames).toEqual([]);
    expect(room.size).toBe(1);
  });

  it("rejects a join beyond the member limit", () => {
    const room = Room.load("demo", new Store(":memory:"), 2);
    expect(room.join(new Recorder("a"))).toBe("joined");
    expect(room.join(new Recorder("b"))).toBe("joined");
    const overflow = new Recorder("c");
    expect(room.join(overflow)).toBe("full");
    expect(overflow.frames).toEqual([]);
  });

  it("tells the remaining members when a member leaves", () => {
    const room = Room.load("demo", new Store(":memory:"), 50);
    const alice = new Recorder("alice");
    const bob = new Recorder("bob");
    room.join(alice);
    room.join(bob);
    bob.frames.length = 0;

    room.leave("alice");
    expect(bob.frames).toEqual([{ type: "leave", replica: "alice" }]);
    expect(room.size).toBe(1);
  });

  it("relays presence to the others, tagged with the sender's replica", () => {
    const room = Room.load("demo", new Store(":memory:"), 50);
    const alice = new Recorder("alice");
    const bob = new Recorder("bob");
    room.join(alice);
    room.join(bob);
    alice.frames.length = 0;
    bob.frames.length = 0;

    room.relayPresence("alice", { type: "presence", x: 1, y: 2, name: "A", color: "#ff0000" });
    expect(alice.frames).toEqual([]);
    expect(bob.frames).toEqual([
      { type: "presence", replica: "alice", x: 1, y: 2, name: "A", color: "#ff0000" },
    ]);
  });
});
