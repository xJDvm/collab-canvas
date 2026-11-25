import { Buffer } from "node:buffer";
import { validateOp, type DocSnapshot, type Op } from "@collab-canvas/crdt";

/** Largest accepted size of a text frame, in UTF-8 bytes. */
const MAX_FRAME_BYTES = 64 * 1024;

/** Largest accepted magnitude of a presence coordinate. */
const MAX_COORDINATE = 1e6;

/** Largest accepted number of Unicode code points in a presence name. */
const MAX_NAME_LENGTH = 32;

const ROOM_PATTERN = /^[a-z0-9-]{1,32}$/;
const REPLICA_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const COLOUR_PATTERN = /^#[0-9a-f]{6}$/;

/** Codes carried by an {@link ErrorFrame}. */
export type ErrorCode =
  | "invalid_frame"
  | "invalid_op"
  | "hello_required"
  | "rate_limited"
  | "room_full"
  | "replica_in_use";

/** Fixed, client-safe message for each error code. No internal detail is ever included. */
const ERROR_MESSAGES: Readonly<Record<ErrorCode, string>> = {
  invalid_frame: "invalid frame",
  invalid_op: "the operation cannot be applied",
  hello_required: "the first frame must be hello",
  rate_limited: "too many operations, slow down",
  room_full: "the room is full",
  replica_in_use: "this replica id is already in the room",
};

/** Client joins a room. */
export interface HelloFrame {
  readonly type: "hello";
  readonly room: string;
  readonly replica: string;
}

/** A document operation, sent by a client or broadcast by the server. */
export interface OpFrame {
  readonly type: "op";
  readonly op: Op;
}

/** Client reports its cursor. The server attaches the sender's replica id. */
export interface ClientPresenceFrame {
  readonly type: "presence";
  readonly x: number;
  readonly y: number;
  readonly name: string;
  readonly color: string;
}

/** Server relays a peer's cursor, tagged with the replica that sent it. */
export interface ServerPresenceFrame {
  readonly type: "presence";
  readonly replica: string;
  readonly x: number;
  readonly y: number;
  readonly name: string;
  readonly color: string;
}

/** Server sends the room snapshot and the ops applied since it was taken. */
export interface WelcomeFrame {
  readonly type: "welcome";
  readonly snapshot: DocSnapshot;
  readonly ops: readonly Op[];
}

/** Server reports that a replica left the room. */
export interface LeaveFrame {
  readonly type: "leave";
  readonly replica: string;
}

/** Server reports a rejected or failed request. */
export interface ErrorFrame {
  readonly type: "error";
  readonly code: ErrorCode;
  readonly message: string;
}

/** Any frame a client may send. */
export type ClientFrame = HelloFrame | OpFrame | ClientPresenceFrame;

/** Any frame the server may send. */
export type ServerFrame =
  | WelcomeFrame
  | OpFrame
  | ServerPresenceFrame
  | LeaveFrame
  | ErrorFrame;

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function readString(v: unknown, pattern: RegExp): string | undefined {
  return typeof v === "string" && pattern.test(v) ? v : undefined;
}

function readCoordinate(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= MAX_COORDINATE
    ? v
    : undefined;
}

function readName(v: unknown): string | undefined {
  return typeof v === "string" && [...v].length <= MAX_NAME_LENGTH ? v : undefined;
}

function parseHello(v: Record<string, unknown>): HelloFrame | null {
  const room = readString(v.room, ROOM_PATTERN);
  const replica = readString(v.replica, REPLICA_PATTERN);
  return room === undefined || replica === undefined ? null : { type: "hello", room, replica };
}

function parseOp(v: Record<string, unknown>): OpFrame | null {
  const op = validateOp(v.op);
  return op === null ? null : { type: "op", op };
}

function parsePresence(v: Record<string, unknown>): ClientPresenceFrame | null {
  // The sender's identity is assigned by the server, never trusted from the client.
  if (Object.hasOwn(v, "replica")) {
    return null;
  }
  const x = readCoordinate(v.x);
  const y = readCoordinate(v.y);
  const name = readName(v.name);
  const color = readString(v.color, COLOUR_PATTERN);
  if (x === undefined || y === undefined || name === undefined || color === undefined) {
    return null;
  }
  return { type: "presence", x, y, name, color };
}

/**
 * Parses and validates a text frame received from a client.
 *
 * The frame is rejected (returns `null`) when it exceeds 64 KiB in UTF-8, is
 * not a JSON object, carries a `__proto__` key, has an unknown `type`, or
 * fails the field checks of its type. The result is rebuilt field by field
 * from whitelisted keys; unknown keys are ignored and input objects are never
 * copied. Never throws, whatever `text` is.
 *
 * @returns The validated frame, or `null` if the frame is invalid.
 */
export function parseClientFrame(text: string): ClientFrame | null {
  if (Buffer.byteLength(text, "utf8") > MAX_FRAME_BYTES) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value) || Object.hasOwn(value, "__proto__")) {
    return null;
  }
  switch (value.type) {
    case "hello":
      return parseHello(value);
    case "op":
      return parseOp(value);
    case "presence":
      return parsePresence(value);
    default:
      return null;
  }
}

/**
 * Serialises a server frame to JSON text. Each frame is written from an
 * explicit field list, so no extra properties can leak onto the wire.
 */
export function encodeServerFrame(frame: ServerFrame): string {
  switch (frame.type) {
    case "welcome":
      return JSON.stringify({ type: frame.type, snapshot: frame.snapshot, ops: frame.ops });
    case "op":
      return JSON.stringify({ type: frame.type, op: frame.op });
    case "presence":
      return JSON.stringify({
        type: frame.type,
        replica: frame.replica,
        x: frame.x,
        y: frame.y,
        name: frame.name,
        color: frame.color,
      });
    case "leave":
      return JSON.stringify({ type: frame.type, replica: frame.replica });
    case "error":
      return JSON.stringify({ type: frame.type, code: frame.code, message: frame.message });
  }
}

/** Builds the error frame for `code` with its fixed message. */
export function errorFrame(code: ErrorCode): ErrorFrame {
  return { type: "error", code, message: ERROR_MESSAGES[code] };
}

/** The error sent in reply to a frame that failed {@link parseClientFrame}. */
export function invalidFrameError(): ErrorFrame {
  return errorFrame("invalid_frame");
}
