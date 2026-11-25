import { Doc, type DocSnapshot, type Op } from "@collab-canvas/crdt";
import { encodeServerFrame, type ClientPresenceFrame } from "./protocol.js";
import type { Store } from "./store.js";

/** Replica id of the server's own document. The server applies ops but never authors them. */
const SERVER_REPLICA = "server";

/** A connection that receives frames while it is a member of a room. */
export interface RoomMember {
  /** Replica id the member joined with. Unique within its room. */
  readonly replica: string;
  /** Delivers one frame that is already encoded as JSON text. */
  deliver(text: string): void;
}

/** Outcome of {@link Room.join}. */
export type JoinResult = "joined" | "full" | "duplicate";

/**
 * One collaborative room: an in-memory replica of its document and the members
 * connected to it. The server only relays and records; it never authors operations.
 *
 * A room can be dropped from memory when its last member leaves, because every
 * accepted operation is persisted before it is broadcast and {@link Room.load}
 * rebuilds the same state from the store.
 */
export class Room {
  readonly name: string;
  readonly #doc: Doc;
  readonly #store: Store;
  readonly #maxMembers: number;
  readonly #members = new Map<string, RoomMember>();

  private constructor(name: string, doc: Doc, store: Store, maxMembers: number) {
    this.name = name;
    this.#doc = doc;
    this.#store = store;
    this.#maxMembers = maxMembers;
  }

  /**
   * Rebuilds room `name` from `store`: the latest snapshot, if there is one,
   * followed by the operations recorded after it.
   * @throws if the stored snapshot cannot be parsed or restored.
   */
  static load(name: string, store: Store, maxMembers: number): Room {
    const loaded = store.load(name);
    const doc =
      loaded.snapshot === null
        ? new Doc(SERVER_REPLICA)
        : Doc.fromSnapshot(SERVER_REPLICA, JSON.parse(loaded.snapshot.json) as DocSnapshot);
    for (const op of loaded.ops) {
      doc.apply(op);
    }
    return new Room(name, doc, store, maxMembers);
  }

  /** Number of members currently in the room. */
  get size(): number {
    return this.#members.size;
  }

  /**
   * Adds `member` and sends it the current state. The welcome frame carries the
   * full snapshot of the document, so `ops` is always empty.
   * @returns `"duplicate"` if the replica is already a member, `"full"` if the room
   *   is at capacity, otherwise `"joined"`. Nothing is sent on a rejected join.
   */
  join(member: RoomMember): JoinResult {
    if (this.#members.has(member.replica)) {
      return "duplicate";
    }
    if (this.#members.size >= this.#maxMembers) {
      return "full";
    }
    this.#members.set(member.replica, member);
    member.deliver(encodeServerFrame({ type: "welcome", snapshot: this.#doc.snapshot(), ops: [] }));
    return "joined";
  }

  /** Removes the member with `replica` and tells the remaining members it left. */
  leave(replica: string): void {
    if (this.#members.delete(replica)) {
      this.#broadcast(encodeServerFrame({ type: "leave", replica }));
    }
  }

  /**
   * Accepts an operation from the member `replica`: persists it, applies it, and
   * broadcasts it to every other member. Snapshots are written at the store's
   * interval. An operation already recorded, in this room or another one, is dropped
   * without a broadcast.
   */
  submitOp(replica: string, op: Op): void {
    // The store's unique op id also rejects an op recorded in another room. Appending
    // first means such an op is never applied here without being persisted.
    if (!this.#store.appendOp(this.name, op)) {
      return;
    }
    this.#doc.apply(op);
    const seq = this.#store.lastSeq(this.name);
    if (this.#store.shouldSnapshot(seq)) {
      this.#store.saveSnapshot(this.name, seq, JSON.stringify(this.#doc.snapshot()));
    }
    this.#broadcast(encodeServerFrame({ type: "op", op }), replica);
  }

  /** Relays a cursor update to every member except `replica`, tagged with its sender. */
  relayPresence(replica: string, frame: ClientPresenceFrame): void {
    this.#broadcast(
      encodeServerFrame({
        type: "presence",
        replica,
        x: frame.x,
        y: frame.y,
        name: frame.name,
        color: frame.color,
      }),
      replica,
    );
  }

  #broadcast(text: string, except?: string): void {
    for (const [replica, member] of this.#members) {
      if (replica !== except) {
        member.deliver(text);
      }
    }
  }
}
