import { Clock, compareStamps, type Stamp } from "./clock.js";
import {
  opId,
  stampFromOpId,
  type CreateOp,
  type DeleteOp,
  type DocSnapshot,
  type MutableFields,
  type Op,
  type Point,
  type Register,
  type Shape,
  type ShapeInit,
  type ShapeRecord,
  type UpdateOp,
} from "./ops.js";

/** Orders two strings by UTF-16 code unit. */
function compareIds(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

function copyPoints(points: readonly Point[]): Point[] {
  return points.map((p) => ({ x: p.x, y: p.y }));
}

function copyInit(init: ShapeInit): ShapeInit {
  return init.kind === "stroke" ? { ...init, points: copyPoints(init.points) } : { ...init };
}

function copyRegister<T>(reg: Register<T> | null, copy: (v: T) => T = (v) => v): Register<T> | null {
  return reg === null ? null : { value: copy(reg.value), stamp: reg.stamp };
}

function copyRecord(r: ShapeRecord): ShapeRecord {
  return {
    id: r.id,
    kind: copyRegister(r.kind),
    x: copyRegister(r.x),
    y: copyRegister(r.y),
    w: copyRegister(r.w),
    h: copyRegister(r.h),
    points: copyRegister(r.points, copyPoints),
    fill: copyRegister(r.fill),
    stroke: copyRegister(r.stroke),
    z: copyRegister(r.z),
    deleted: copyRegister(r.deleted),
  };
}

function emptyRecord(id: string): ShapeRecord {
  return {
    id,
    kind: null,
    x: null,
    y: null,
    w: null,
    h: null,
    points: null,
    fill: null,
    stroke: null,
    z: null,
    deleted: null,
  };
}

/** Writes `value` unless the register already holds a stamp greater than `stamp`. */
function write<T>(reg: Register<T> | null, value: T, stamp: Stamp): Register<T> {
  if (reg !== null && compareStamps(stamp, reg.stamp) <= 0) {
    return reg;
  }
  return { value, stamp };
}

/** Like {@link write}, but an absent value leaves the register untouched. */
function writeIfDefined<T>(
  reg: Register<T> | null,
  value: T | undefined,
  stamp: Stamp,
): Register<T> | null {
  return value === undefined ? reg : write(reg, value, stamp);
}

function applyCreate(rec: ShapeRecord, op: CreateOp): ShapeRecord {
  const { shape, stamp } = op;
  const styled = {
    ...rec,
    kind: write(rec.kind, shape.kind, stamp),
    fill: write(rec.fill, shape.fill, stamp),
    stroke: write(rec.stroke, shape.stroke, stamp),
    z: write(rec.z, shape.z, stamp),
  };
  if (shape.kind === "stroke") {
    return { ...styled, points: write(rec.points, copyPoints(shape.points), stamp) };
  }
  return {
    ...styled,
    x: write(rec.x, shape.x, stamp),
    y: write(rec.y, shape.y, stamp),
    w: write(rec.w, shape.w, stamp),
    h: write(rec.h, shape.h, stamp),
  };
}

function applyUpdate(rec: ShapeRecord, op: UpdateOp): ShapeRecord {
  const { fields, stamp } = op;
  return {
    ...rec,
    x: writeIfDefined(rec.x, fields.x, stamp),
    y: writeIfDefined(rec.y, fields.y, stamp),
    w: writeIfDefined(rec.w, fields.w, stamp),
    h: writeIfDefined(rec.h, fields.h, stamp),
    fill: writeIfDefined(rec.fill, fields.fill, stamp),
    stroke: writeIfDefined(rec.stroke, fields.stroke, stamp),
    z: writeIfDefined(rec.z, fields.z, stamp),
  };
}

function applyDelete(rec: ShapeRecord, op: DeleteOp): ShapeRecord {
  return { ...rec, deleted: write<true>(rec.deleted, true, op.stamp) };
}

/** Projects a record onto a visible shape, or returns `null` if it is not visible. */
function toShape(rec: ShapeRecord): Shape | null {
  if (rec.kind === null || rec.deleted !== null) {
    return null;
  }
  if (rec.fill === null || rec.stroke === null || rec.z === null) {
    return null;
  }
  const kind = rec.kind.value;
  const style = { id: rec.id, fill: rec.fill.value, stroke: rec.stroke.value, z: rec.z.value };
  if (kind === "stroke") {
    if (rec.points === null) {
      return null;
    }
    return { ...style, kind, points: copyPoints(rec.points.value) };
  }
  if (rec.x === null || rec.y === null || rec.w === null || rec.h === null) {
    return null;
  }
  return { ...style, kind, x: rec.x.value, y: rec.y.value, w: rec.w.value, h: rec.h.value };
}

/**
 * A shape document replica. Every shape is a set of last-writer-wins
 * registers, so replicas that apply the same operations in any order, and
 * any number of times, converge to the same state.
 *
 * Local edits are produced by {@link Doc.createShape}, {@link Doc.updateShape}
 * and {@link Doc.deleteShape}; each one is returned so it can be sent to other
 * replicas, and is applied locally through {@link Doc.apply}.
 */
export class Doc {
  readonly #clock: Clock;
  readonly #shapes = new Map<string, ShapeRecord>();
  readonly #seen = new Set<string>();

  /**
   * @param replica Identifier of this replica; see {@link Clock}.
   * @throws {RangeError} If `replica` is not a valid replica id.
   */
  constructor(replica: string) {
    this.#clock = new Clock(replica);
  }

  /**
   * Creates a shape. Its id is the id of the returned operation.
   */
  createShape(init: ShapeInit): CreateOp {
    const stamp = this.#clock.tick();
    const op: CreateOp = { type: "create", id: opId(stamp), stamp, shape: copyInit(init) };
    this.apply(op);
    return op;
  }

  /**
   * Sets the given fields of a shape. Fields not present are left unchanged.
   * The shape need not be known yet; see {@link Doc.apply}.
   */
  updateShape(id: string, fields: Partial<MutableFields>): UpdateOp {
    const stamp = this.#clock.tick();
    const op: UpdateOp = {
      type: "update",
      id: opId(stamp),
      stamp,
      shapeId: id,
      fields: { ...fields },
    };
    this.apply(op);
    return op;
  }

  /**
   * Deletes a shape. The deletion is permanent: later operations on the shape
   * do not make it visible again.
   */
  deleteShape(id: string): DeleteOp {
    const stamp = this.#clock.tick();
    const op: DeleteOp = { type: "delete", id: opId(stamp), stamp, shapeId: id };
    this.apply(op);
    return op;
  }

  /**
   * Applies an operation received locally or from another replica. The clock
   * observes its stamp so that later local stamps sort after it.
   *
   * @returns `false` if an operation with the same id was already applied,
   *   in which case the document is unchanged.
   * @throws {RangeError} If the stamp's lamport value is not a safe integer.
   */
  apply(op: Op): boolean {
    if (this.#seen.has(op.id)) {
      return false;
    }
    this.#clock.observe(op.stamp);
    this.#seen.add(op.id);
    switch (op.type) {
      case "create":
        this.#shapes.set(op.id, applyCreate(this.#record(op.id), op));
        break;
      case "update":
        this.#shapes.set(op.shapeId, applyUpdate(this.#record(op.shapeId), op));
        break;
      case "delete":
        this.#shapes.set(op.shapeId, applyDelete(this.#record(op.shapeId), op));
        break;
    }
    return true;
  }

  /**
   * The shapes that are created and not deleted, sorted by `z` and then by id.
   */
  visibleShapes(): Shape[] {
    const shapes: Shape[] = [];
    for (const rec of this.#shapes.values()) {
      const shape = toShape(rec);
      if (shape !== null) {
        shapes.push(shape);
      }
    }
    return shapes.sort((a, b) => {
      if (a.z === b.z) {
        return compareIds(a.id, b.id);
      }
      return a.z < b.z ? -1 : 1;
    });
  }

  /**
   * A canonical copy of the full document state, including tombstones and
   * the set of applied op ids. Two replicas that applied the same operations
   * return equal snapshots.
   */
  snapshot(): DocSnapshot {
    const shapes = [...this.#shapes.values()]
      .sort((a, b) => compareIds(a.id, b.id))
      .map(copyRecord);
    return { shapes, seen: [...this.#seen].sort(compareIds) };
  }

  /**
   * Restores a document from a snapshot taken by {@link Doc.snapshot}. The
   * clock is advanced past every stamp in the snapshot, so new local stamps
   * never collide with recorded ones.
   *
   * @throws {RangeError} If `replica` is invalid or a `seen` id is malformed.
   */
  static fromSnapshot(replica: string, s: DocSnapshot): Doc {
    const doc = new Doc(replica);
    for (const id of s.seen) {
      doc.#clock.observe(stampFromOpId(id));
      doc.#seen.add(id);
    }
    for (const rec of s.shapes) {
      doc.#shapes.set(rec.id, copyRecord(rec));
    }
    return doc;
  }

  #record(id: string): ShapeRecord {
    return this.#shapes.get(id) ?? emptyRecord(id);
  }
}
