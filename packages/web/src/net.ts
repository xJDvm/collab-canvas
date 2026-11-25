import {
  Doc,
  validateOp,
  type CreateOp,
  type DeleteOp,
  type DocSnapshot,
  type MutableFields,
  type Op,
  type Shape,
  type ShapeInit,
  type UpdateOp,
} from "@collab-canvas/crdt";
import type { Editor } from "./tools.js";

/** Room used when the URL hash does not name a valid one. */
export const DEFAULT_ROOM = "demo";

/** Accepted room names; the same pattern the server enforces. */
const ROOM_PATTERN = /^[a-z0-9-]{1,32}$/;

/** Largest server frame accepted, in UTF-16 code units. */
const MAX_FRAME_LENGTH = 16 * 1024 * 1024;

/** First reconnect delay, in milliseconds. Each failed attempt doubles it. */
const BASE_RETRY_MS = 500;

/** Upper bound on the reconnect delay, in milliseconds. */
const MAX_RETRY_MS = 10_000;

/** Whether the socket is connecting, connected to a room, or waiting to retry. */
export type ConnectionStatus = "connecting" | "online" | "offline";

/** Settings for {@link Connection}. */
export interface ConnectionOptions {
  /** WebSocket endpoint, for example `ws://127.0.0.1:5173/ws`. */
  readonly url: string;
  /** Room to join. */
  readonly room: string;
  /** Replica id of this client; must be unique per session. */
  readonly replica: string;
  /** Called whenever the status or the visible shapes change. */
  readonly onChange: (status: ConnectionStatus, shapes: readonly Shape[]) => void;
}

/** A frame from the server that the client acts on. Other known types are ignored. */
type ServerFrame =
  | { readonly type: "welcome"; readonly snapshot: DocSnapshot; readonly ops: readonly unknown[] }
  | { readonly type: "op"; readonly op: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses a text frame from the server. Returns `null` for anything that is not
 * JSON, is too large, has an unknown `type`, or lacks the top-level fields the
 * client uses. Operations are checked later by `validateOp`.
 */
function parseServerFrame(data: unknown): ServerFrame | null {
  if (typeof data !== "string" || data.length > MAX_FRAME_LENGTH) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isRecord(value)) {
    return null;
  }
  if (value.type === "welcome") {
    const { snapshot, ops } = value;
    if (!isRecord(snapshot) || !Array.isArray(ops)) {
      return null;
    }
    return { type: "welcome", snapshot: snapshot as unknown as DocSnapshot, ops };
  }
  if (value.type === "op") {
    return { type: "op", op: value.op };
  }
  return null;
}

/**
 * A live session on one room: a WebSocket that reconnects with exponential
 * backoff, and a local replica of the document.
 *
 * Local edits are applied at once and kept until a welcome frame shows that
 * the server has them. After every welcome the replica is rebuilt from the
 * server snapshot, the unacknowledged local edits are applied on top, and
 * those are sent again. The server ignores operations it has already seen.
 *
 * The class implements {@link Editor}, so a `Tools` instance can drive it.
 */
export class Connection implements Editor {
  readonly #options: ConnectionOptions;
  #doc: Doc;
  #pending: Op[] = [];
  #socket: WebSocket | null = null;
  #joined = false;
  #status: ConnectionStatus = "connecting";
  #attempt = 0;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #closed = false;

  /** @throws {RangeError} If `options.replica` is not a valid replica id. */
  constructor(options: ConnectionOptions) {
    this.#options = options;
    this.#doc = new Doc(options.replica);
  }

  /** Opens the socket and keeps it open until {@link Connection.close}. */
  start(): void {
    this.#connect();
  }

  /** Stops reconnecting and closes the socket. The instance cannot be restarted. */
  close(): void {
    this.#closed = true;
    if (this.#retryTimer !== null) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }
    const socket = this.#socket;
    this.#socket = null;
    this.#joined = false;
    socket?.close();
  }

  /** Creates a shape locally and sends it to the room. */
  createShape(init: ShapeInit): CreateOp {
    return this.#submit(this.#doc.createShape(init));
  }

  /** Updates fields of a shape locally and sends the change to the room. */
  updateShape(id: string, fields: Partial<MutableFields>): UpdateOp {
    return this.#submit(this.#doc.updateShape(id, fields));
  }

  /** Deletes a shape locally and sends the deletion to the room. */
  deleteShape(id: string): DeleteOp {
    return this.#submit(this.#doc.deleteShape(id));
  }

  #submit<T extends Op>(op: T): T {
    this.#pending.push(op);
    this.#sendOp(op);
    this.#notify();
    return op;
  }

  #sendOp(op: Op): void {
    if (this.#joined) {
      this.#socket?.send(JSON.stringify({ type: "op", op }));
    }
  }

  #connect(): void {
    this.#retryTimer = null;
    this.#setStatus("connecting");
    const socket = new WebSocket(this.#options.url);
    this.#socket = socket;
    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({ type: "hello", room: this.#options.room, replica: this.#options.replica }),
      );
    });
    socket.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (socket === this.#socket) {
        this.#receive(event.data);
      }
    });
    socket.addEventListener("close", () => {
      if (socket === this.#socket) {
        this.#lost();
      }
    });
  }

  #lost(): void {
    this.#socket = null;
    this.#joined = false;
    if (this.#closed) {
      return;
    }
    this.#setStatus("offline");
    const delay = Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** this.#attempt);
    this.#attempt += 1;
    this.#retryTimer = setTimeout(() => {
      this.#connect();
    }, delay);
  }

  #receive(data: unknown): void {
    const frame = parseServerFrame(data);
    if (frame === null) {
      return;
    }
    if (frame.type === "welcome") {
      this.#welcome(frame);
    } else if (this.#joined) {
      const op = validateOp(frame.op);
      if (op !== null && this.#doc.apply(op)) {
        this.#notify();
      }
    }
  }

  #welcome(frame: Extract<ServerFrame, { type: "welcome" }>): void {
    let doc: Doc;
    try {
      doc = Doc.fromSnapshot(this.#options.replica, frame.snapshot);
    } catch {
      // The snapshot is unusable; dropping the socket makes the next attempt ask again.
      this.#socket?.close();
      return;
    }
    for (const raw of frame.ops) {
      const op = validateOp(raw);
      if (op !== null) {
        doc.apply(op);
      }
    }
    const acknowledged = new Set(frame.snapshot.seen);
    this.#pending = this.#pending.filter((op) => !acknowledged.has(op.id));
    for (const op of this.#pending) {
      doc.apply(op);
    }
    this.#doc = doc;
    this.#joined = true;
    this.#attempt = 0;
    for (const op of this.#pending) {
      this.#sendOp(op);
    }
    this.#setStatus("online");
  }

  #setStatus(status: ConnectionStatus): void {
    this.#status = status;
    this.#notify();
  }

  #notify(): void {
    this.#options.onChange(this.#status, this.#doc.visibleShapes());
  }
}

/**
 * The room named by a URL hash of the form `#room=<name>`, or {@link DEFAULT_ROOM}
 * when the hash does not name a valid room.
 */
export function roomFromHash(hash: string): string {
  const room = new URLSearchParams(hash.replace(/^#/, "")).get("room");
  return room !== null && ROOM_PATTERN.test(room) ? room : DEFAULT_ROOM;
}
