import { DatabaseSync, type StatementSync } from "node:sqlite";
import { validateOp, type Op } from "@collab-canvas/crdt";

/** Default number of operations between two snapshots of the same room. */
export const DEFAULT_SNAPSHOT_EVERY = 500;

/** Options accepted by {@link Store}. */
export interface StoreOptions {
  /** Operations per room between snapshot points. Must be a positive integer. */
  readonly snapshotEvery?: number;
}

/** A stored document snapshot and the sequence number of the last op it covers. */
export interface StoredSnapshot {
  readonly seq: number;
  readonly json: string;
}

/** Everything needed to rebuild a room: its latest snapshot and the ops after it. */
export interface LoadedRoom {
  readonly snapshot: StoredSnapshot | null;
  /** Valid ops with a sequence number greater than the snapshot's, in seq order. */
  readonly ops: Op[];
  /** Rows after the snapshot that failed validation and were left out of `ops`. */
  readonly skipped: number;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS ops (
    room TEXT NOT NULL,
    seq INTEGER NOT NULL,
    id TEXT NOT NULL,
    json TEXT NOT NULL,
    PRIMARY KEY (room, seq),
    UNIQUE (room, id)
  );
  CREATE TABLE IF NOT EXISTS snapshots (
    room TEXT NOT NULL,
    seq INTEGER NOT NULL,
    json TEXT NOT NULL,
    PRIMARY KEY (room, seq)
  );
`;

/**
 * Durable per-room operation log with periodic snapshots, backed by `node:sqlite`.
 *
 * Sequence numbers start at 1 and are dense per room. Every statement is prepared
 * once and bound with parameters; no SQL text is built from values.
 */
export class Store {
  readonly #db: DatabaseSync;
  readonly #snapshotEvery: number;
  readonly #insertOp: StatementSync;
  readonly #lastSeq: StatementSync;
  readonly #latestSnapshot: StatementSync;
  readonly #insertSnapshot: StatementSync;
  readonly #opsAfter: StatementSync;

  /**
   * Opens (or creates) the database at `path`. Use `":memory:"` for a transient store.
   * @throws RangeError if `snapshotEvery` is not a positive safe integer.
   */
  constructor(path: string, options: StoreOptions = {}) {
    const snapshotEvery = options.snapshotEvery ?? DEFAULT_SNAPSHOT_EVERY;
    if (!Number.isSafeInteger(snapshotEvery) || snapshotEvery < 1) {
      throw new RangeError(`snapshotEvery must be a positive integer, got ${snapshotEvery}`);
    }
    this.#snapshotEvery = snapshotEvery;
    this.#db = new DatabaseSync(path);
    try {
      if (path !== ":memory:") {
        this.#db.exec("PRAGMA journal_mode = WAL");
      }
      this.#db.exec(SCHEMA);
      // The sequence is assigned inside the INSERT itself, so the read and the write
      // are one atomic statement. An op id already stored in this room is ignored and
      // reported as 0 changes. The same id in another room is stored independently.
      this.#insertOp = this.#db.prepare(
        "INSERT OR IGNORE INTO ops (room, seq, id, json) " +
          "SELECT ?1, COALESCE(MAX(seq), 0) + 1, ?2, ?3 FROM ops WHERE room = ?1",
      );
      this.#lastSeq = this.#db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM ops WHERE room = ?");
      this.#latestSnapshot = this.#db.prepare(
        "SELECT seq, json FROM snapshots WHERE room = ? ORDER BY seq DESC LIMIT 1",
      );
      this.#insertSnapshot = this.#db.prepare(
        "INSERT OR REPLACE INTO snapshots (room, seq, json) VALUES (?, ?, ?)",
      );
      this.#opsAfter = this.#db.prepare("SELECT seq, json FROM ops WHERE room = ? AND seq > ? ORDER BY seq");
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  /**
   * Appends `op` to `room` with the next sequence number.
   * @returns `false` if an operation with the same id is already stored in `room`
   *   (nothing changes). The same id in another room is not a duplicate.
   */
  appendOp(room: string, op: Op): boolean {
    const result = this.#insertOp.run(room, op.id, JSON.stringify(op));
    return Number(result.changes) === 1;
  }

  /** Sequence number of the newest operation in `room`, or 0 if the room has no ops. */
  lastSeq(room: string): number {
    const row = this.#lastSeq.get(room);
    return typeof row?.seq === "number" ? row.seq : 0;
  }

  /** Whether a snapshot is due after the operation with sequence number `seq`. */
  shouldSnapshot(seq: number): boolean {
    return seq % this.#snapshotEvery === 0;
  }

  /**
   * Stores the serialised document state of `room` as of operation `seq`.
   * Saving the same `seq` twice replaces the earlier snapshot.
   * @throws RangeError if `seq` is not a non-negative safe integer.
   */
  saveSnapshot(room: string, seq: number, json: string): void {
    if (!Number.isSafeInteger(seq) || seq < 0) {
      throw new RangeError(`seq must be a non-negative integer, got ${seq}`);
    }
    this.#insertSnapshot.run(room, seq, json);
  }

  /**
   * Loads the latest snapshot of `room` and the operations recorded after it.
   * Rows that do not parse or fail {@link validateOp} are counted in `skipped`
   * instead of raising, so one corrupted row cannot take the room down.
   */
  load(room: string): LoadedRoom {
    const snapshot = readSnapshot(this.#latestSnapshot.get(room));
    const after = snapshot?.seq ?? 0;
    const ops: Op[] = [];
    let skipped = 0;
    for (const row of this.#opsAfter.all(room, after)) {
      const op = typeof row.json === "string" ? parseOp(row.json) : null;
      if (op === null) {
        skipped++;
      } else {
        ops.push(op);
      }
    }
    return { snapshot, ops, skipped };
  }

  /** Closes the database. The store must not be used afterwards. */
  close(): void {
    this.#db.close();
  }
}

function readSnapshot(row: Record<string, unknown> | undefined): StoredSnapshot | null {
  if (row === undefined || typeof row.seq !== "number" || typeof row.json !== "string") {
    return null;
  }
  return { seq: row.seq, json: row.json };
}

function parseOp(json: string): Op | null {
  try {
    return validateOp(JSON.parse(json));
  } catch {
    return null;
  }
}
