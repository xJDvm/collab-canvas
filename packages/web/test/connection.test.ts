import { Doc, type DocSnapshot } from "@collab-canvas/crdt";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CURSOR_TTL_MS, PRESENCE_INTERVAL_MS } from "../src/presence.js";
import { Connection, type ConnectionOptions, type ConnectionView } from "../src/net.js";

/** A WebSocket stand-in that records what is sent and lets the test raise events. */
class FakeSocket extends EventTarget {
  static instances: FakeSocket[] = [];
  readonly sent: string[] = [];
  closed = false;

  constructor(readonly url: string) {
    super();
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.dispatchEvent(new Event("close"));
    }
  }

  /** Simulates the server accepting the connection. */
  open(): void {
    this.dispatchEvent(new Event("open"));
  }

  /** Simulates a text frame from the server. */
  receive(frame: object): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
  }

  /** Simulates the network dropping the connection. */
  drop(): void {
    this.close();
  }

  /** Frames this client has sent, parsed. */
  frames(): Record<string, unknown>[] {
    return this.sent.map((text) => JSON.parse(text) as Record<string, unknown>);
  }
}

const EMPTY_SNAPSHOT: DocSnapshot = { shapes: [], seen: [] };

/** A rectangle to create in tests. */
const RECT = {
  kind: "rect" as const,
  x: 0,
  y: 0,
  w: 5,
  h: 5,
  fill: "#111111",
  stroke: "#222222",
  z: 1,
};

/** A presence frame from peer `beta`. */
const BEN_CURSOR = { type: "presence", replica: "beta", x: 5, y: 6, name: "Ben", color: "#3b82f6" };

/** The first reconnect delay; the fake clock is advanced by this to reach the next attempt. */
const BASE_DELAY_MS = 500;

/** Returns the most recently created socket. */
function latest(): FakeSocket {
  const socket = FakeSocket.instances.at(-1);
  if (socket === undefined) {
    throw new Error("no socket was created");
  }
  return socket;
}

/** A connection whose views are recorded in `views`. */
function setup(replica = "alpha"): { connection: Connection; views: ConnectionView[] } {
  const views: ConnectionView[] = [];
  const options: ConnectionOptions = {
    url: "ws://test.invalid/ws",
    room: "demo",
    replica,
    name: "Ana",
    colour: "#10b981",
    onChange: (view) => {
      views.push(view);
    },
  };
  return { connection: new Connection(options), views };
}

/** The status of the newest view. */
function statusOf(views: readonly ConnectionView[]): string {
  return views.at(-1)?.status ?? "";
}

/** The op frames a socket has sent. */
function opFrames(socket: FakeSocket): Record<string, unknown>[] {
  return socket.frames().filter((frame) => frame.type === "op");
}

/** Connects, opens and welcomes the client with `snapshot`. */
function joinWith(snapshot: DocSnapshot): FakeSocket {
  const socket = latest();
  socket.open();
  socket.receive({ type: "welcome", snapshot, ops: [] });
  return socket;
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("connection lifecycle", () => {
  it("says hello on open, and reports online after the welcome", () => {
    const { connection, views } = setup();
    connection.start();
    expect(statusOf(views)).toBe("connecting");
    const socket = latest();
    socket.open();
    expect(socket.frames()).toEqual([{ type: "hello", room: "demo", replica: "alpha" }]);
    socket.receive({ type: "welcome", snapshot: EMPTY_SNAPSHOT, ops: [] });
    expect(statusOf(views)).toBe("online");
    connection.close();
  });

  it("shows the retry delay while offline and reconnects after it", () => {
    const { connection, views } = setup();
    connection.start();
    latest().open();
    latest().drop();
    expect(statusOf(views)).toBe("offline (retrying in 1s)");
    vi.advanceTimersByTime(499);
    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(statusOf(views)).toBe("connecting");
    connection.close();
  });

  it("doubles the delay on each failed attempt and resets it after a welcome", () => {
    const { connection, views } = setup();
    connection.start();
    latest().drop();
    expect(statusOf(views)).toBe("offline (retrying in 1s)");
    vi.advanceTimersByTime(500);
    latest().drop();
    expect(statusOf(views)).toBe("offline (retrying in 1s)");
    vi.advanceTimersByTime(1000);
    latest().drop();
    expect(statusOf(views)).toBe("offline (retrying in 2s)");
    vi.advanceTimersByTime(2000);
    latest().open();
    latest().receive({ type: "welcome", snapshot: EMPTY_SNAPSHOT, ops: [] });
    latest().drop();
    expect(statusOf(views)).toBe("offline (retrying in 1s)");
    connection.close();
  });

  it("stops reconnecting after close", () => {
    const { connection } = setup();
    connection.start();
    latest().drop();
    connection.close();
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });
});

describe("welcome hardening", () => {
  it("keeps the badge offline and retries when the snapshot cannot be built", () => {
    const { connection, views } = setup();
    connection.start();
    const socket = latest();
    socket.open();
    socket.receive({ type: "welcome", snapshot: { shapes: [], seen: ["not an op id"] }, ops: [] });
    expect(socket.closed).toBe(true);
    expect(statusOf(views)).toBe("offline (retrying in 1s)");
    expect(views.some((view) => view.status === "online")).toBe(false);
    vi.advanceTimersByTime(500);
    expect(FakeSocket.instances).toHaveLength(2);
    connection.close();
  });

  it("does not send anything while not joined", () => {
    const { connection } = setup();
    connection.start();
    connection.createShape(RECT);
    connection.updatePresence({ x: 1, y: 1 });
    vi.advanceTimersByTime(PRESENCE_INTERVAL_MS);
    expect(latest().sent).toEqual([]);
    connection.close();
  });
});

describe("pending operations", () => {
  const rect = RECT;

  it("resends local ops made while offline once the welcome arrives", () => {
    const { connection } = setup();
    connection.start();
    connection.createShape(rect);
    latest().drop();
    vi.advanceTimersByTime(BASE_DELAY_MS);
    connection.createShape({ ...rect, z: 2 });
    const welcomed = joinWith(EMPTY_SNAPSHOT);
    expect(opFrames(welcomed)).toHaveLength(2);
    connection.close();
  });

  it("does not resend an op that the snapshot already contains", () => {
    const { connection } = setup();
    connection.start();
    joinWith(EMPTY_SNAPSHOT);
    const op = connection.createShape(rect);
    latest().drop();
    vi.advanceTimersByTime(BASE_DELAY_MS);
    const welcomed = joinWith({ shapes: [], seen: [op.id] });
    expect(opFrames(welcomed)).toHaveLength(0);
    connection.close();
  });

  it("removes a pending op once the server echoes it back", () => {
    const { connection } = setup();
    connection.start();
    joinWith(EMPTY_SNAPSHOT);
    const op = connection.createShape(rect);
    latest().receive({ type: "op", op });
    latest().drop();
    vi.advanceTimersByTime(BASE_DELAY_MS);
    const welcomed = joinWith(EMPTY_SNAPSHOT);
    expect(opFrames(welcomed)).toHaveLength(0);
    connection.close();
  });

  it("keeps a pending local shape and shows the peer shape after a rebuild", () => {
    const { connection, views } = setup();
    connection.start();
    const local = connection.createShape(rect);
    latest().drop();
    vi.advanceTimersByTime(BASE_DELAY_MS);
    const remote = new Doc("beta");
    const peer = remote.createShape({ ...rect, x: 40 });
    joinWith(remote.snapshot());
    const ids = (views.at(-1)?.shapes ?? []).map((shape) => shape.id).sort();
    expect(ids).toEqual([local.id, peer.id].sort());
    connection.close();
  });
});

describe("presence", () => {
  it("sends the local pointer with the configured name and colour, throttled", () => {
    const { connection } = setup();
    connection.start();
    joinWith(EMPTY_SNAPSHOT);
    const socket = latest();
    connection.updatePresence({ x: 1, y: 1 });
    connection.updatePresence({ x: 2, y: 2 });
    connection.updatePresence({ x: 3, y: 3 });
    expect(socket.frames().filter((f) => f.type === "presence")).toEqual([
      { type: "presence", x: 1, y: 1, name: "Ana", color: "#10b981" },
    ]);
    vi.advanceTimersByTime(PRESENCE_INTERVAL_MS);
    expect(socket.frames().filter((f) => f.type === "presence")).toEqual([
      { type: "presence", x: 1, y: 1, name: "Ana", color: "#10b981" },
      { type: "presence", x: 3, y: 3, name: "Ana", color: "#10b981" },
    ]);
    connection.close();
  });

  it("drops a pointer position outside the server's coordinate range", () => {
    const { connection } = setup();
    connection.start();
    joinWith(EMPTY_SNAPSHOT);
    connection.updatePresence({ x: 2e6, y: 0 });
    expect(latest().frames().filter((f) => f.type === "presence")).toEqual([]);
    connection.close();
  });

  it("shows peers' cursors and removes them on leave", () => {
    const { connection, views } = setup();
    connection.start();
    joinWith(EMPTY_SNAPSHOT);
    const socket = latest();
    socket.receive(BEN_CURSOR);
    expect(views.at(-1)?.cursors).toEqual([
      { replica: "beta", x: 5, y: 6, name: "Ben", color: "#3b82f6" },
    ]);
    socket.receive({ type: "leave", replica: "beta" });
    expect(views.at(-1)?.cursors).toEqual([]);
    connection.close();
  });

  it("ignores presence frames that echo the local replica", () => {
    const { connection, views } = setup("alpha");
    connection.start();
    joinWith(EMPTY_SNAPSHOT);
    latest().receive({ ...BEN_CURSOR, replica: "alpha" });
    expect(views.at(-1)?.cursors).toEqual([]);
    connection.close();
  });

  it("removes a peer whose cursor has been silent for 10 s", () => {
    const { connection, views } = setup();
    connection.start();
    joinWith(EMPTY_SNAPSHOT);
    latest().receive(BEN_CURSOR);
    vi.advanceTimersByTime(CURSOR_TTL_MS - 1000);
    expect(views.at(-1)?.cursors).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(views.at(-1)?.cursors).toEqual([]);
    connection.close();
  });

  it("clears every cursor when the socket drops", () => {
    const { connection, views } = setup();
    connection.start();
    joinWith(EMPTY_SNAPSHOT);
    latest().receive(BEN_CURSOR);
    latest().drop();
    expect(views.at(-1)?.cursors).toEqual([]);
    connection.close();
  });
});
