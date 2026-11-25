import type { Stamp } from "./clock.js";
import {
  opId,
  type MutableFields,
  type Op,
  type Point,
  type ShapeInit,
} from "./ops.js";

/** Largest accepted magnitude of a coordinate, size, z value or point component. */
const MAX_COORDINATE = 1e6;

/** Largest accepted number of points in a stroke. */
const MAX_POINTS = 2000;

const REPLICA_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * A shape id is either a client-chosen id of at most 64 characters, or an op
 * id (`<replica>:<lamport>`) as produced by `Doc.createShape`.
 */
const SHAPE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}(?::(?:0|[1-9][0-9]{0,15}))?$/;

const COLOUR_PATTERN = /^#[0-9a-f]{6}$/;

const NUMERIC_FIELDS = ["x", "y", "w", "h", "z"] as const;
const COLOUR_FIELDS = ["fill", "stroke"] as const;

type MutableUpdate = { -readonly [K in keyof MutableFields]?: MutableFields[K] };

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/**
 * Returns `v` if it is a finite number with magnitude at most
 * {@link MAX_COORDINATE}, otherwise `undefined`. Negative zero is normalised
 * to zero because JSON cannot carry it.
 */
function readNumber(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > MAX_COORDINATE) {
    return undefined;
  }
  return v === 0 ? 0 : v;
}

function readString(v: unknown, pattern: RegExp): string | undefined {
  return typeof v === "string" && pattern.test(v) ? v : undefined;
}

function readColour(v: unknown): string | undefined {
  return readString(v, COLOUR_PATTERN);
}

function readStamp(v: unknown): Stamp | undefined {
  if (!isRecord(v)) {
    return undefined;
  }
  const replica = readString(v.replica, REPLICA_PATTERN);
  const lamport = v.lamport;
  if (replica === undefined || typeof lamport !== "number") {
    return undefined;
  }
  if (!Number.isSafeInteger(lamport) || lamport < 0) {
    return undefined;
  }
  return { lamport: lamport === 0 ? 0 : lamport, replica };
}

function readPoint(v: unknown): Point | undefined {
  if (!isRecord(v)) {
    return undefined;
  }
  const x = readNumber(v.x);
  const y = readNumber(v.y);
  return x === undefined || y === undefined ? undefined : { x, y };
}

function readPoints(v: unknown): Point[] | undefined {
  if (!Array.isArray(v) || v.length > MAX_POINTS) {
    return undefined;
  }
  const points: Point[] = [];
  for (let i = 0; i < v.length; i++) {
    const point = readPoint(v[i]);
    if (point === undefined) {
      return undefined;
    }
    points.push(point);
  }
  return points;
}

/** Reads the `fill`, `stroke` and `z` attributes shared by every shape kind. */
function readStyle(v: Record<string, unknown>): { fill: string; stroke: string; z: number } | undefined {
  const fill = readColour(v.fill);
  const stroke = readColour(v.stroke);
  const z = readNumber(v.z);
  if (fill === undefined || stroke === undefined || z === undefined) {
    return undefined;
  }
  return { fill, stroke, z };
}

/** Reads a shape definition, dispatching on its `kind`. Unknown keys are dropped. */
function readShapeInit(v: unknown): ShapeInit | undefined {
  if (!isRecord(v)) {
    return undefined;
  }
  const style = readStyle(v);
  if (style === undefined) {
    return undefined;
  }
  if (v.kind === "stroke") {
    const points = readPoints(v.points);
    return points === undefined
      ? undefined
      : { kind: "stroke", points, fill: style.fill, stroke: style.stroke, z: style.z };
  }
  if (v.kind !== "rect" && v.kind !== "ellipse") {
    return undefined;
  }
  const x = readNumber(v.x);
  const y = readNumber(v.y);
  const w = readNumber(v.w);
  const h = readNumber(v.h);
  if (x === undefined || y === undefined || w === undefined || h === undefined) {
    return undefined;
  }
  return { kind: v.kind, x, y, w, h, fill: style.fill, stroke: style.stroke, z: style.z };
}

/**
 * Reads the partial field set of an update. Keys outside {@link MutableFields}
 * are ignored; a known key holding an invalid value rejects the whole update.
 */
function readFields(v: unknown): Partial<MutableFields> | undefined {
  if (!isRecord(v)) {
    return undefined;
  }
  const fields: MutableUpdate = {};
  for (const key of NUMERIC_FIELDS) {
    const raw = v[key];
    if (raw !== undefined) {
      const value = readNumber(raw);
      if (value === undefined) {
        return undefined;
      }
      fields[key] = value;
    }
  }
  for (const key of COLOUR_FIELDS) {
    const raw = v[key];
    if (raw !== undefined) {
      const value = readColour(raw);
      if (value === undefined) {
        return undefined;
      }
      fields[key] = value;
    }
  }
  return fields;
}

/**
 * Validates an untrusted value as a document operation.
 *
 * The result is rebuilt field by field from whitelisted keys: unknown keys
 * (including `__proto__`, `constructor` and `prototype`) are dropped, and the
 * input is never copied or spread. Limits: ids are at most 64 characters
 * (an op id is `<replica>:<lamport>`, so it may be longer by the suffix);
 * numbers are finite with magnitude at most 1e6; strokes have at most 2000
 * points; colours are lowercase `#rrggbb`; lamport is a non-negative safe integer.
 *
 * Never throws, whatever `x` is.
 *
 * @returns The validated operation, or `null` if `x` is not a valid operation.
 */
export function validateOp(x: unknown): Op | null {
  if (!isRecord(x)) {
    return null;
  }
  const stamp = readStamp(x.stamp);
  if (stamp === undefined || x.id !== opId(stamp)) {
    return null;
  }
  const id = opId(stamp);
  switch (x.type) {
    case "create": {
      const shape = readShapeInit(x.shape);
      return shape === undefined ? null : { type: "create", id, stamp, shape };
    }
    case "update": {
      const shapeId = readString(x.shapeId, SHAPE_ID_PATTERN);
      const fields = readFields(x.fields);
      return shapeId === undefined || fields === undefined
        ? null
        : { type: "update", id, stamp, shapeId, fields };
    }
    case "delete": {
      const shapeId = readString(x.shapeId, SHAPE_ID_PATTERN);
      return shapeId === undefined ? null : { type: "delete", id, stamp, shapeId };
    }
    default:
      return null;
  }
}
