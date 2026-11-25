import { Buffer } from "node:buffer";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { Config } from "./config.js";
import {
  encodeServerFrame,
  errorFrame,
  parseClientFrame,
  type ClientFrame,
  type HelloFrame,
  type ServerFrame,
} from "./protocol.js";
import { TokenBucket } from "./rate-limit.js";
import { Room, type RoomMember } from "./room.js";
import type { Store } from "./store.js";

/** RFC 6455 close code for a policy violation, used for every protocol-level rejection. */
const CLOSE_POLICY = 1008;
/** RFC 6455 close code for a server that cannot take the connection now. */
const CLOSE_TRY_AGAIN = 1013;
/** RFC 6455 close code for an unexpected server-side failure. */
const CLOSE_INTERNAL = 1011;

/** Options accepted by {@link createServer}. The caller owns `store` and closes it. */
export interface ServerOptions {
  readonly config: Config;
  readonly store: Store;
}

/** A started server. */
export interface RunningServer {
  /** The TCP port the server is listening on, resolved when `config.port` is `0`. */
  readonly port: number;
  /** Terminates every connection and stops listening. Safe to call more than once. */
  close(): Promise<void>;
}

/** Starts a WebSocket server that relays ops and presence between the members of each room. */
export async function createServer({ config, store }: ServerOptions): Promise<RunningServer> {
  const hub = new Hub(config, store);
  const wss = new WebSocketServer({
    host: config.host,
    port: config.port,
    maxPayload: config.maxPayload,
  });
  wss.on("connection", (socket: WebSocket) => {
    hub.accept(socket);
  });
  await once(wss, "listening");
  const address = wss.address();
  if (typeof address === "string" || address === null) {
    wss.close();
    throw new Error("the WebSocket server has no TCP address");
  }
  hub.start();

  let closing: Promise<void> | undefined;
  return {
    port: address.port,
    close(): Promise<void> {
      closing ??= closeServer(hub, wss);
      return closing;
    },
  };
}

async function closeServer(hub: Hub, wss: WebSocketServer): Promise<void> {
  hub.stop();
  await new Promise<void>((resolve, reject) => {
    wss.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

/** The room a session joined and the member it joined as. */
interface Membership {
  readonly room: Room;
  readonly member: RoomMember;
}

/** Per-connection state. A session joins a room with a valid `hello`. */
class Session {
  readonly socket: WebSocket;
  readonly ops: TokenBucket;
  readonly presence: TokenBucket;
  /** Time of the last pong, on the monotonic clock. */
  lastPong: number;
  /** Count of invalid frames received on this connection. */
  invalidFrames = 0;
  /** Set once `hello` succeeded. */
  joined: Membership | null = null;
  /** Set once the connection is closing; frames that arrive later are ignored. */
  closing = false;
  readonly #helloTimer: NodeJS.Timeout;

  constructor(socket: WebSocket, config: Config, now: number) {
    this.socket = socket;
    this.ops = new TokenBucket(config.opsPerSecond, config.opsBurst, now);
    this.presence = new TokenBucket(config.presencePerSecond, config.presencePerSecond, now);
    this.lastPong = now;
    this.#helloTimer = setTimeout(() => {
      this.close(CLOSE_POLICY, "hello timeout");
    }, config.helloTimeoutMs);
  }

  /** Encodes and sends `frame` if the socket is still open. */
  send(frame: ServerFrame): void {
    this.deliver(encodeServerFrame(frame));
  }

  /** Sends pre-encoded frame text if the socket is still open. */
  deliver(text: string): void {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(text);
    }
  }

  /** Records the room membership and cancels the hello timer, which only guards the first frame. */
  admit(membership: Membership): void {
    this.joined = membership;
    clearTimeout(this.#helloTimer);
  }

  /** Cancels the hello timer and marks the session as closing. */
  dispose(): void {
    this.closing = true;
    clearTimeout(this.#helloTimer);
  }

  /** Performs the closing handshake with the given code and reason. */
  close(code: number, reason: string): void {
    if (this.closing) {
      return;
    }
    this.dispose();
    this.socket.close(code, reason);
  }

  /** Drops the socket without a closing handshake. */
  terminate(): void {
    this.dispose();
    this.socket.terminate();
  }
}

/** Owns every connection and room of one server and applies the protocol rules. */
class Hub {
  readonly #config: Config;
  readonly #store: Store;
  readonly #sessions = new Set<Session>();
  readonly #rooms = new Map<string, Room>();
  #heartbeat: NodeJS.Timeout | undefined;

  constructor(config: Config, store: Store) {
    this.#config = config;
    this.#store = store;
  }

  /** Starts the heartbeat timer. */
  start(): void {
    this.#heartbeat = setInterval(() => {
      this.#beat();
    }, this.#config.heartbeatIntervalMs);
  }

  /** Stops the heartbeat timer and terminates every connection. */
  stop(): void {
    clearInterval(this.#heartbeat);
    for (const session of this.#sessions) {
      session.terminate();
    }
    this.#sessions.clear();
    this.#rooms.clear();
  }

  /** Takes ownership of a newly upgraded socket, or rejects it if the server is full. */
  accept(socket: WebSocket): void {
    // A failing socket always emits "close" next, which runs the cleanup. The listener
    // only keeps the error from being thrown as unhandled.
    socket.on("error", () => undefined);
    if (this.#sessions.size >= this.#config.maxConnections) {
      socket.close(CLOSE_TRY_AGAIN, "server is full");
      return;
    }
    const session = new Session(socket, this.#config, performance.now());
    this.#sessions.add(session);
    socket.on("message", (data: RawData, isBinary: boolean) => {
      this.#onMessage(session, data, isBinary);
    });
    socket.on("pong", () => {
      session.lastPong = performance.now();
    });
    socket.on("close", () => {
      this.#onClose(session);
    });
  }

  #beat(): void {
    const now = performance.now();
    for (const session of this.#sessions) {
      if (now - session.lastPong > this.#config.heartbeatTimeoutMs) {
        session.terminate();
      } else {
        session.socket.ping();
      }
    }
  }

  #onMessage(session: Session, data: RawData, isBinary: boolean): void {
    if (session.closing) {
      return;
    }
    try {
      // Text frames arrive as Buffers (the default binaryType). Binary frames are not protocol.
      const frame =
        !isBinary && Buffer.isBuffer(data) ? parseClientFrame(data.toString("utf8")) : null;
      if (session.joined === null) {
        this.#onFirstFrame(session, frame);
      } else {
        this.#onFrame(session, session.joined, frame);
      }
    } catch {
      session.close(CLOSE_INTERNAL, "internal error");
    }
  }

  #onFirstFrame(session: Session, frame: ClientFrame | null): void {
    if (frame === null) {
      session.send(errorFrame("invalid_frame"));
      session.close(CLOSE_POLICY, "invalid frame");
    } else if (frame.type !== "hello") {
      session.send(errorFrame("hello_required"));
      session.close(CLOSE_POLICY, "hello required");
    } else {
      this.#join(session, frame);
    }
  }

  #join(session: Session, hello: HelloFrame): void {
    let room = this.#rooms.get(hello.room);
    if (room === undefined) {
      room = Room.load(hello.room, this.#store, this.#config.maxConnectionsPerRoom);
      this.#rooms.set(hello.room, room);
    }
    const member: RoomMember = {
      replica: hello.replica,
      deliver: (text) => {
        session.deliver(text);
      },
    };
    const result = room.join(member);
    if (result === "joined") {
      session.admit({ room, member });
    } else if (result === "duplicate") {
      session.send(errorFrame("replica_in_use"));
      session.close(CLOSE_POLICY, "replica in use");
    } else {
      session.send(errorFrame("room_full"));
      session.close(CLOSE_TRY_AGAIN, "room is full");
    }
  }

  #onFrame(session: Session, joined: Membership, frame: ClientFrame | null): void {
    if (frame === null || frame.type === "hello") {
      this.#invalid(session);
      return;
    }
    if (frame.type === "op") {
      if (!session.ops.tryTake(performance.now())) {
        session.send(errorFrame("rate_limited"));
      } else if (joined.room.submitOp(joined.member.replica, frame.op) === "invalid") {
        session.send(errorFrame("invalid_op"));
      }
      return;
    }
    // Presence beyond the rate limit is dropped without a reply.
    if (session.presence.tryTake(performance.now())) {
      joined.room.relayPresence(joined.member.replica, frame);
    }
  }

  #invalid(session: Session): void {
    session.invalidFrames += 1;
    session.send(errorFrame("invalid_frame"));
    if (session.invalidFrames >= this.#config.maxInvalidFrames) {
      session.close(CLOSE_POLICY, "too many invalid frames");
    }
  }

  #onClose(session: Session): void {
    session.dispose();
    this.#sessions.delete(session);
    if (session.joined === null) {
      return;
    }
    const { room, member } = session.joined;
    room.leave(member.replica);
    if (room.size === 0) {
      this.#rooms.delete(room.name);
    }
  }
}
