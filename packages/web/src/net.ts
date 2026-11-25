import {
  Doc,
  validateOp,
  type CreateOp,
  type DeleteOp,
  type DocSnapshot,
  type MutableFields,
  type Op,
  type Point,
  type Shape,
  type ShapeInit,
  type UpdateOp,
} from "@collab-canvas/crdt";
import { isDisplayName } from "./identity.js";
import { CursorTable, PresenceThrottle } from "./presence.js";
import type { Cursor } from "./render.js";
import type { Editor } from "./tools.js";

/** Room used when the URL hash does not name a valid one. */
export const DEFAULT_ROOM = "demo";

/** Accepted room names; the same pattern the server enforces. */
const ROOM_PATTERN = /^[a-z0-9-]{1,32}$/;

/** Accepted replica ids in presence and leave frames; the same pattern the server enforces. */
const REPLICA_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Accepted presence colours; the same pattern the server enforces. */
const COLOUR_PATTERN = /^#[0-9a-f]{6}$/;

/** Largest coordinate accepted in a presence frame; the same bound the server enforces. */
const MAX_COORDINATE = 1e6;

/**
 * Largest server frame accepted, in UTF-16 code units. Counting code units is
 * cheaper than counting bytes; the limit is about 1 MiB of ASCII text.
 */
const MAX_FRAME_LENGTH = 1024 * 1024;

/** First reconnect delay, in milliseconds. Each failed attempt doubles it. */
const BASE_RETRY_MS = 500;

/** Upper bound on the reconnect delay, in milliseconds. */
const MAX_RETRY_MS = 10_000;

/**
 * Most locally made operations kept while waiting for the server. When the
 * queue is full, the oldest operation is dropped from the queue (it stays in
 * the local document and is not resent). The UI shows nothing special.
 */
export const MAX_PENDING_OPS = 5000;

/** How often expired remote cursors are removed, in milliseconds. */
const CURSOR_SWEEP_MS = 1000;

/**
 * The state of the link, as the badge shows it. The offline state names the
 * delay before the next attempt, in whole seconds (rounded up).
 */
export type ConnectionStatus = "connecting" | "online" | `offline (retrying in ${number}s)`;

/** The three states of {@link ConnectionStatus}, without the retry delay. */
export type StatusKind = "connecting" | "online" | "offline";

/** Everything the UI needs to paint one frame of the session. */
export interface ConnectionView {
  readonly status: ConnectionStatus;
  readonly shapes: readonly Shape[];
  readonly cursors: readonly Cursor[];
}

/** Settings for {@link Connection}. */
export interface ConnectionOptions {
  /** WebSocket endpoint, for example `ws://127.0.0.1:5173/ws`. */
  readonly url: string;
  /** Room to join. */
  readonly room: string;
  /** Replica id of this client; must be unique per session. */
  readonly replica: string;
  /** Display name sent with this client's cursor. At most 32 code points. */
  readonly name: string;
  /** Colour sent with this client's cursor, as `#rrggbb`. */
  readonly colour: string;
  /** Called whenever the status, the shapes or the cursors change. */
  readonly onChange: (view: ConnectionView) => void;
}

/** A frame from the server, validated in shape. Operations are checked later by `validateOp`. */
export type ServerFrame =
  | { readonly type: "welcome"; readonly snapshot: DocSnapshot; readonly ops: readonly unknown[] }
  | { readonly type: "op"; readonly op: unknown }
  | { readonly type: "presence"; readonly cursor: Cursor }
  | { readonly type: "leave"; readonly replica: string }
  | { readonly type: "error"; readonly code: string; readonly message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isCoordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_COORDINATE;
}

/** Reviver that fails on any `__proto__` key, at any depth. */
function rejectProtoKey(key: string, value: unknown): unknown {
  if (key === "__proto__") {
    throw new SyntaxError("__proto__ key");
  }
  return value;
}

function parseWelcome(value: Record<string, unknown>): ServerFrame | null {
  const { snapshot, ops } = value;
  if (
    !isRecord(snapshot) ||
    !Array.isArray(snapshot.shapes) ||
    !isStringArray(snapshot.seen) ||
    !Array.isArray(ops)
  ) {
    return null;
  }
  // The shapes are checked when the document is built; that step may throw.
  return { type: "welcome", snapshot: snapshot as unknown as DocSnapshot, ops };
}

function parsePresence(value: Record<string, unknown>): ServerFrame | null {
  const { replica, x, y, name, color } = value;
  if (
    typeof replica !== "string" ||
    !REPLICA_PATTERN.test(replica) ||
    !isCoordinate(x) ||
    !isCoordinate(y) ||
    typeof name !== "string" ||
    !isDisplayName(name) ||
    typeof color !== "string" ||
    !COLOUR_PATTERN.test(color)
  ) {
    return null;
  }
  return { type: "presence", cursor: { replica, x, y, name, color } };
}

function parseLeave(value: Record<string, unknown>): ServerFrame | null {
  const { replica } = value;
  return typeof replica === "string" && REPLICA_PATTERN.test(replica)
    ? { type: "leave", replica }
    : null;
}

function parseError(value: Record<string, unknown>): ServerFrame | null {
  const { code, message } = value;
  return typeof code === "string" && typeof message === "string"
    ? { type: "error", code, message }
    : null;
}

/**
 * Parses a text frame from the server. Returns `null` for anything that is not
 * a JSON object, is longer than {@link MAX_FRAME_LENGTH}, contains a `__proto__`
 * key at any depth, has an unknown `type`, or fails the shape check of its type.
 * Never throws. Operations are checked later by `validateOp`.
 */
export function parseServerFrame(data: unknown): ServerFrame | null {
  if (typeof data !== "string" || data.length > MAX_FRAME_LENGTH) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(data, rejectProtoKey);
  } catch {
    return null;
  }
  if (!isRecord(value)) {
    return null;
  }
  switch (value.type) {
    case "welcome":
      return parseWelcome(value);
    case "op":
      return isRecord(value.op) ? { type: "op", op: value.op } : null;
    case "presence":
      return parsePresence(value);
    case "leave":
      return parseLeave(value);
    case "error":
      return parseError(value);
    default:
      return null;
  }
}

/**
 * The reconnect delay after `attempt` failed attempts, in milliseconds:
 * 500, 1000, 2000 and so on, capped at 10 000.
 *
 * @throws {RangeError} If `attempt` is not a non-negative safe integer.
 */
export function backoffDelay(attempt: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 0) {
    throw new RangeError("attempt must be a non-negative integer");
  }
  return Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** attempt);
}

/** Keeps the pending operations whose ids are not in `acknowledged`, in their original order. */
export function prunePending(pending: readonly Op[], acknowledged: Iterable<string>): Op[] {
  const done = new Set(acknowledged);
  return pending.filter((op) => !done.has(op.id));
}

/**
 * Appends `op` to the pending queue, dropping the oldest entries when the
 * queue would exceed {@link MAX_PENDING_OPS}.
 */
export function appendPending(pending: readonly Op[], op: Op): Op[] {
  const next = [...pending, op];
  return next.length > MAX_PENDING_OPS ? next.slice(next.length - MAX_PENDING_OPS) : next;
}

/** The status shown for a given state, without the retry delay. */
export function statusKind(status: ConnectionStatus): StatusKind {
  return status === "connecting" || status === "online" ? status : "offline";
}

/**
 * A live session on one room: a WebSocket that reconnects with exponential
 * backoff, a local replica of the document, and the cursors of the other peers.
 *
 * Local edits are applied at once and kept until a welcome frame or an op echo
 * shows that the server has them. After every welcome the replica is rebuilt
 * from the server snapshot, the unacknowledged local edits are applied on top,
 * and those are sent again. The server ignores operations it has already seen.
 *
 * Presence is not part of the document. Cursor updates are throttled and are
 * never stored in the CRDT.
 *
 * The class implements {@link Editor}, so a `Tools` instance can drive it.
 */
export class Connection implements Editor {
  readonly #options: ConnectionOptions;
  readonly #cursors = new CursorTable();
  readonly #throttle: PresenceThrottle;
  #doc: Doc;
  #pending: Op[] = [];
  #socket: WebSocket | null = null;
  #joined = false;
  #status: ConnectionStatus = "connecting";
  #attempt = 0;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #sweepTimer: ReturnType<typeof setInterval> | null = null;
  #closed = false;

  /** @throws {RangeError} If `options.replica` is not a valid replica id. */
  constructor(options: ConnectionOptions) {
    this.#options = options;
    this.#doc = new Doc(options.replica);
    this.#throttle = new PresenceThrottle((point) => {
      this.#sendPresence(point);
    }, () => Date.now());
  }

  /** Opens the socket and keeps it open until {@link Connection.close}. */
  start(): void {
    this.#connect();
    this.#sweepTimer = setInterval(() => {
      this.#sweepCursors();
    }, CURSOR_SWEEP_MS);
  }

  /** Stops reconnecting and closes the socket. The instance cannot be restarted. */
  close(): void {
    this.#closed = true;
    if (this.#retryTimer !== null) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }
    if (this.#sweepTimer !== null) {
      clearInterval(this.#sweepTimer);
      this.#sweepTimer = null;
    }
    this.#throttle.cancel();
    this.#cursors.clear();
    const socket = this.#socket;
    this.#socket = null;
    this.#joined = false;
    socket?.close();
  }

  /**
   * Reports the local pointer position in canvas coordinates. Calls are
   * throttled to about 30 per second; only the newest position is sent.
   */
  updatePresence(point: Point): void {
    this.#throttle.offer(point);
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
    this.#pending = appendPending(this.#pending, op);
    this.#sendOp(op);
    this.#notify();
    return op;
  }

  #sendOp(op: Op): void {
    this.#transmit({ type: "op", op });
  }

  #sendPresence(point: Point): void {
    if (isCoordinate(point.x) && isCoordinate(point.y)) {
      this.#transmit({
        type: "presence",
        x: point.x,
        y: point.y,
        name: this.#options.name,
        color: this.#options.colour,
      });
    }
  }

  #transmit(frame: object): void {
    if (this.#joined) {
      this.#socket?.send(JSON.stringify(frame));
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

  /** The current socket is gone: forget the session and schedule the next attempt. */
  #lost(): void {
    this.#socket = null;
    this.#joined = false;
    this.#cursors.clear();
    if (this.#closed) {
      return;
    }
    const delay = backoffDelay(this.#attempt);
    this.#attempt += 1;
    this.#setStatus(`offline (retrying in ${Math.ceil(delay / 1000)}s)`);
    this.#retryTimer = setTimeout(() => {
      this.#connect();
    }, delay);
  }

  /** Drops the current socket on purpose, for instance after an unusable welcome. */
  #abandon(): void {
    const socket = this.#socket;
    this.#socket = null;
    socket?.close();
    this.#lost();
  }

  #receive(data: unknown): void {
    const frame = parseServerFrame(data);
    if (frame === null) {
      return;
    }
    switch (frame.type) {
      case "welcome":
        this.#welcome(frame);
        break;
      case "op":
        this.#operation(frame.op);
        break;
      case "presence":
        this.#presence(frame.cursor);
        break;
      case "leave":
        if (this.#cursors.remove(frame.replica)) {
          this.#notify();
        }
        break;
      case "error":
        // Rejections are not shown; the replica keeps what it has.
        break;
    }
  }

  #operation(raw: unknown): void {
    const op = validateOp(raw);
    if (op === null || !this.#joined) {
      return;
    }
    this.#pending = prunePending(this.#pending, [op.id]);
    if (this.#doc.apply(op)) {
      this.#notify();
    }
  }

  #presence(cursor: Cursor): void {
    if (cursor.replica === this.#options.replica) {
      return;
    }
    this.#cursors.update(cursor, Date.now());
    this.#notify();
  }

  #sweepCursors(): void {
    if (this.#cursors.expire(Date.now())) {
      this.#notify();
    }
  }

  #welcome(frame: Extract<ServerFrame, { type: "welcome" }>): void {
    let doc: Doc;
    try {
      doc = Doc.fromSnapshot(this.#options.replica, frame.snapshot);
    } catch {
      this.#abandon();
      return;
    }
    const welcomed: Op[] = [];
    for (const raw of frame.ops) {
      const op = validateOp(raw);
      if (op !== null) {
        welcomed.push(op);
        doc.apply(op);
      }
    }
    this.#pending = prunePending(this.#pending, [
      ...frame.snapshot.seen,
      ...welcomed.map((op) => op.id),
    ]);
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
    const now = Date.now();
    this.#options.onChange({
      status: this.#status,
      shapes: this.#doc.visibleShapes(),
      cursors: this.#cursors.list(now),
    });
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
