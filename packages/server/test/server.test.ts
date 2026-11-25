import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { once } from "node:events";
import { Buffer } from "node:buffer";
import { Doc, type Op } from "@collab-canvas/crdt";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../src/config.js";
import { createServer, type RunningServer } from "../src/server.js";
import { Store } from "../src/store.js";
import { frameOf, join, Peer, sleep, within } from "./helpers.js";

const MAX_FRAME_BYTES = 64 * 1024;
const CLOSE_POLICY = 1008;
const CLOSE_TOO_BIG = 1009;
const CLOSE_TRY_AGAIN = 1013;

/** Config for tests: ephemeral port, in-memory store, and any overrides. */
function testConfig(overrides: Partial<Config> = {}): Config {
  return { ...loadConfig({ HOST: "127.0.0.1", PORT: "0", DB_PATH: ":memory:" }), ...overrides };
}

/** Returns one valid create op authored by `replica`. */
function makeOp(replica: string): Op {
  return new Doc(replica).createShape({
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

/** Returns a raw presence frame padded with spaces to exactly `bytes` UTF-8 bytes. */
function paddedPresence(bytes: number): string {
  const frame = JSON.stringify({ type: "presence", x: 0, y: 0, name: "a", color: "#000000" });
  return " ".repeat(bytes - Buffer.byteLength(frame)) + frame;
}

describe("createServer", () => {
  let store: Store;
  let server: RunningServer | undefined;
  let peers: Peer[] = [];

  /** Starts a server on an ephemeral port with `overrides` applied. */
  async function start(overrides: Partial<Config> = {}): Promise<number> {
    server = await createServer({ config: testConfig(overrides), store });
    return server.port;
  }

  /** Joins a room and keeps the peer so the test teardown can drop it. */
  async function joinTracked(port: number, room: string, replica: string) {
    const joined = await join(port, room, replica);
    peers.push(joined.peer);
    return joined;
  }

  /** Connects without joining and keeps the peer so the test teardown can drop it. */
  async function connectTracked(port: number): Promise<Peer> {
    const peer = await Peer.connect(port);
    peers.push(peer);
    return peer;
  }

  beforeEach(() => {
    store = new Store(":memory:");
    peers = [];
  });

  afterEach(async () => {
    for (const peer of peers) {
      peer.terminate();
    }
    peers = [];
    await server?.close();
    server = undefined;
    store.close();
  });

  it("binds an ephemeral port when configured with 0 and reports the real one", async () => {
    const port = await start({ port: 0 });
    expect(port).toBeGreaterThan(0);
    const peer = await connectTracked(port);
    expect(peer.socket.readyState).toBe(peer.socket.OPEN);
  });

  it("relays an op to the other member and never echoes it to the sender", async () => {
    const port = await start();
    const a = await joinTracked(port, "demo", "replica-a");
    const b = await joinTracked(port, "demo", "replica-b");

    const docA = new Doc("replica-a");
    const op = docA.createShape({
      kind: "rect",
      x: 1,
      y: 2,
      w: 3,
      h: 4,
      fill: "#112233",
      stroke: "#445566",
      z: 1,
    });
    a.peer.send({ type: "op", op });

    expect(await b.peer.next()).toEqual({ type: "op", op });
    const docB = Doc.fromSnapshot("replica-b", frameOf(b.welcome, "welcome").snapshot);
    docB.apply(op);
    expect(docB.snapshot()).toEqual(docA.snapshot());

    await sleep(50);
    expect(a.peer.drain()).toEqual([]);
  });

  it("welcomes a late joiner with the current full snapshot", async () => {
    const port = await start();
    const a = await joinTracked(port, "demo", "replica-a");
    const b = await joinTracked(port, "demo", "replica-b");
    const op = makeOp("replica-a");
    a.peer.send({ type: "op", op });
    await b.peer.next();

    const late = await joinTracked(port, "demo", "replica-c");
    const welcome = frameOf(late.welcome, "welcome");
    expect(welcome.snapshot.shapes.map((shape) => shape.id)).toEqual([op.id]);
    expect(welcome.ops).toEqual([]);
  });

  it("keeps rooms separate", async () => {
    const port = await start();
    const a = await joinTracked(port, "room-one", "replica-a");
    const b = await joinTracked(port, "room-two", "replica-b");
    a.peer.send({ type: "op", op: makeOp("replica-a") });
    await sleep(50);
    expect(b.peer.drain()).toEqual([]);
  });

  it("answers a malformed frame with an invalid_frame error and no internal detail", async () => {
    const port = await start();
    const { peer } = await joinTracked(port, "demo", "replica-a");
    peer.sendRaw("{not json");
    const error = frameOf(await peer.next(), "error");
    expect(error).toEqual({ type: "error", code: "invalid_frame", message: "invalid frame" });
  });

  it("answers a binary frame with an invalid_frame error", async () => {
    const port = await start();
    const { peer } = await joinTracked(port, "demo", "replica-a");
    peer.socket.send(Buffer.from([1, 2, 3]));
    expect(frameOf(await peer.next(), "error").code).toBe("invalid_frame");
  });

  it("rejects a second hello on a joined connection as an invalid frame", async () => {
    const port = await start();
    const { peer } = await joinTracked(port, "demo", "replica-a");
    peer.send({ type: "hello", room: "demo", replica: "replica-a" });
    expect(frameOf(await peer.next(), "error").code).toBe("invalid_frame");
  });

  it("closes with 1008 after the configured number of invalid frames", async () => {
    const port = await start({ maxInvalidFrames: 5 });
    const { peer } = await joinTracked(port, "demo", "replica-a");
    for (let i = 0; i < 6; i++) {
      peer.sendRaw("{}");
    }
    expect(await within(peer.closeCode, 2000, "close after invalid frames")).toBe(CLOSE_POLICY);
  });

  it("closes an oversized frame", async () => {
    const port = await start();
    const { peer } = await joinTracked(port, "demo", "replica-a");
    peer.sendRaw("x".repeat(MAX_FRAME_BYTES + 1));
    expect(await within(peer.closeCode, 2000, "close after oversized frame")).toBe(CLOSE_TOO_BIG);
  });

  it("accepts a frame of exactly 64 KiB", async () => {
    const port = await start();
    const a = await joinTracked(port, "demo", "replica-a");
    const b = await joinTracked(port, "demo", "replica-b");
    a.peer.sendRaw(paddedPresence(MAX_FRAME_BYTES));
    const relayed = frameOf(await b.peer.next(), "presence");
    expect(relayed.replica).toBe("replica-a");
  });

  it("keeps a joined client open past the hello timeout and applies its ops", async () => {
    const helloTimeoutMs = 150;
    const port = await start({ helloTimeoutMs });
    const a = await joinTracked(port, "demo", "replica-a");
    const b = await joinTracked(port, "demo", "replica-b");
    await sleep(3 * helloTimeoutMs);
    expect(a.peer.socket.readyState).toBe(a.peer.socket.OPEN);
    expect(b.peer.socket.readyState).toBe(b.peer.socket.OPEN);

    const op = makeOp("replica-a");
    a.peer.send({ type: "op", op });
    expect(frameOf(await b.peer.next(), "op").op).toEqual(op);
    const late = await joinTracked(port, "demo", "replica-c");
    expect(frameOf(late.welcome, "welcome").snapshot.shapes.map((shape) => shape.id)).toEqual([
      op.id,
    ]);
  });

  it("joins a room whose stored log holds an unsafe-lamport row", async () => {
    const dir = mkdtempSync(joinPath(tmpdir(), "collab-canvas-unsafe-"));
    const file = joinPath(dir, "rooms.db");
    try {
      const first = new Store(file);
      const good = makeOp("replica-a");
      first.appendOp("demo", good);
      first.close();

      const raw = new DatabaseSync(file);
      try {
        const bad = makeOp("replica-b");
        const unsafe = { ...bad, stamp: { lamport: Number.MAX_SAFE_INTEGER + 1, replica: "replica-b" } };
        raw
          .prepare("INSERT INTO ops (room, seq, id, json) VALUES (?, ?, ?, ?)")
          .run("demo", 2, bad.id, JSON.stringify(unsafe));
      } finally {
        raw.close();
      }

      store.close();
      store = new Store(file);
      server = await createServer({ config: testConfig(), store });
      const c = await joinTracked(server.port, "demo", "replica-c");
      const welcome = frameOf(c.welcome, "welcome");
      expect(welcome.snapshot.shapes.map((shape) => shape.id)).toEqual([good.id]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("closes a connection that does not send hello in time", async () => {
    const port = await start({ helloTimeoutMs: 100 });
    const peer = await connectTracked(port);
    expect(await within(peer.closeCode, 2000, "close after hello timeout")).toBe(CLOSE_POLICY);
  });

  it("rejects a first frame that is not hello, then closes", async () => {
    const port = await start();
    const peer = await connectTracked(port);
    peer.send({ type: "op", op: makeOp("replica-a") });
    expect(frameOf(await peer.next(), "error").code).toBe("hello_required");
    expect(await within(peer.closeCode, 2000, "close after missing hello")).toBe(CLOSE_POLICY);
  });

  it("rejects an unparseable first frame, then closes", async () => {
    const port = await start();
    const peer = await connectTracked(port);
    peer.sendRaw("nope");
    expect(frameOf(await peer.next(), "error").code).toBe("invalid_frame");
    expect(await within(peer.closeCode, 2000, "close after invalid first frame")).toBe(
      CLOSE_POLICY,
    );
  });

  it("rate limits ops after the burst and drops the excess", async () => {
    const port = await start();
    const a = await joinTracked(port, "demo", "replica-a");
    const b = await joinTracked(port, "demo", "replica-b");
    const docA = new Doc("replica-a");
    for (let i = 0; i < 130; i++) {
      a.peer.send({
        type: "op",
        op: docA.createShape({
          kind: "rect",
          x: i,
          y: 0,
          w: 1,
          h: 1,
          fill: "#ffffff",
          stroke: "#000000",
          z: i,
        }),
      });
    }
    await sleep(300);
    const rejected = a.peer.drain().filter((f) => f.type === "error" && f.code === "rate_limited");
    const delivered = b.peer.drain().filter((f) => f.type === "op");
    expect(rejected.length).toBeGreaterThanOrEqual(1);
    expect(delivered.length).toBeGreaterThanOrEqual(120);
    expect(rejected.length + delivered.length).toBe(130);
  });

  it("drops presence beyond its own rate without an error frame", async () => {
    const port = await start({ presencePerSecond: 30 });
    const a = await joinTracked(port, "demo", "replica-a");
    const b = await joinTracked(port, "demo", "replica-b");
    for (let i = 0; i < 40; i++) {
      a.peer.send({ type: "presence", x: i, y: 0, name: "a", color: "#000000" });
    }
    await sleep(200);
    const presence = b.peer.drain().filter((f) => f.type === "presence");
    expect(presence.length).toBeGreaterThanOrEqual(30);
    expect(presence.length).toBeLessThan(40);
    expect(a.peer.drain()).toEqual([]);
  });

  it("tells the remaining members when a member disconnects", async () => {
    const port = await start();
    const a = await joinTracked(port, "demo", "replica-a");
    const b = await joinTracked(port, "demo", "replica-b");
    b.peer.socket.close();
    expect(frameOf(await a.peer.next(), "leave")).toEqual({ type: "leave", replica: "replica-b" });
  });

  it("rejects a replica id that is already in the room", async () => {
    const port = await start();
    await joinTracked(port, "demo", "replica-a");
    const peer = await connectTracked(port);
    peer.send({ type: "hello", room: "demo", replica: "replica-a" });
    expect(frameOf(await peer.next(), "error").code).toBe("replica_in_use");
    expect(await within(peer.closeCode, 2000, "close after duplicate replica")).toBe(
      CLOSE_POLICY,
    );
  });

  it("rejects the 51st member of a room and keeps other rooms open", async () => {
    const port = await start();
    for (let i = 0; i < 50; i++) {
      await joinTracked(port, "full-room", `member-${i}`);
    }
    const overflow = await connectTracked(port);
    overflow.send({ type: "hello", room: "full-room", replica: "member-50" });
    expect(frameOf(await overflow.next(), "error").code).toBe("room_full");
    expect(await within(overflow.closeCode, 2000, "close after room cap")).toBe(CLOSE_TRY_AGAIN);

    const elsewhere = await joinTracked(port, "other-room", "member-0");
    expect(elsewhere.welcome.type).toBe("welcome");
  });

  it("rejects connections beyond the server-wide limit with 1013", async () => {
    const port = await start({ maxConnections: 2 });
    await connectTracked(port);
    await connectTracked(port);
    const extra = await connectTracked(port);
    expect(await within(extra.closeCode, 2000, "close after connection cap")).toBe(
      CLOSE_TRY_AGAIN,
    );
  });

  it("terminates a connection that does not answer heartbeat pings", async () => {
    const port = await start({ heartbeatIntervalMs: 20, heartbeatTimeoutMs: 60 });
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.on("error", () => undefined);
    await within(once(socket, "connect"), 2000, "raw connect");
    socket.write(
      [
        "GET / HTTP/1.1",
        "Host: 127.0.0.1",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
        "Sec-WebSocket-Version: 13",
        "",
        "",
      ].join("\r\n"),
    );
    // Reading and discarding everything keeps the socket flowing, so its close is observed.
    socket.resume();
    await within(once(socket, "close"), 2000, "close after missed pongs");
  });

  it("keeps a responsive client connected through several heartbeats", async () => {
    const port = await start({ heartbeatIntervalMs: 20, heartbeatTimeoutMs: 60 });
    const a = await joinTracked(port, "demo", "replica-a");
    const b = await joinTracked(port, "demo", "replica-b");
    await sleep(250);
    expect(a.peer.socket.readyState).toBe(a.peer.socket.OPEN);
    a.peer.send({ type: "op", op: makeOp("replica-a") });
    expect(frameOf(await b.peer.next(), "op").op.type).toBe("create");
  });

  it("restores room state from a file-backed store after a restart", async () => {
    const dir = mkdtempSync(joinPath(tmpdir(), "collab-canvas-restart-"));
    const file = joinPath(dir, "rooms.db");
    try {
      const first = new Store(file);
      const firstServer = await createServer({ config: testConfig(), store: first });
      const op = makeOp("replica-a");
      const a = await join(firstServer.port, "demo", "replica-a");
      const b = await join(firstServer.port, "demo", "replica-b");
      a.peer.send({ type: "op", op });
      await b.peer.next();
      a.peer.terminate();
      b.peer.terminate();
      await firstServer.close();
      first.close();

      const second = new Store(file);
      server = await createServer({ config: testConfig(), store: second });
      store.close();
      store = second;
      const c = await joinTracked(server.port, "demo", "replica-c");
      const welcome = frameOf(c.welcome, "welcome");
      expect(welcome.snapshot.shapes.map((shape) => shape.id)).toEqual([op.id]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
