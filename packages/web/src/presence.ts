import type { Point } from "@collab-canvas/crdt";
import type { Cursor } from "./render.js";

/** Smallest gap between two outgoing presence frames, in milliseconds: at most 30 per second. */
export const PRESENCE_INTERVAL_MS = Math.ceil(1000 / 30);

/** A peer whose cursor has not been updated for this long, in milliseconds, is dropped. */
export const CURSOR_TTL_MS = 10_000;

/** Largest number of Unicode code points in a display name. */
export const MAX_NAME_LENGTH = 32;

/**
 * How long to wait, in milliseconds, before a presence frame may be sent after
 * the last one at `lastSentAt` (`null` if none was sent). Zero means send now.
 * The result never exceeds {@link PRESENCE_INTERVAL_MS}, even if the clock went back.
 */
export function presenceDelay(lastSentAt: number | null, now: number): number {
  if (lastSentAt === null) {
    return 0;
  }
  const remaining = lastSentAt + PRESENCE_INTERVAL_MS - now;
  return Math.min(PRESENCE_INTERVAL_MS, Math.max(0, remaining));
}

/**
 * Limits outgoing presence to one frame per {@link PRESENCE_INTERVAL_MS}.
 * Intermediate positions are dropped: when the slot opens, the newest position
 * offered is sent.
 */
export class PresenceThrottle {
  readonly #send: (point: Point) => void;
  readonly #now: () => number;
  #lastSentAt: number | null = null;
  #latest: Point | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * @param send Called with the point to transmit.
   * @param now Clock in milliseconds; injected so tests can control time.
   */
  constructor(send: (point: Point) => void, now: () => number) {
    this.#send = send;
    this.#now = now;
  }

  /** Offers the newest pointer position. It is sent now or when the next slot opens. */
  offer(point: Point): void {
    this.#latest = point;
    if (this.#timer !== null) {
      return;
    }
    const delay = presenceDelay(this.#lastSentAt, this.#now());
    if (delay === 0) {
      this.#flush();
    } else {
      this.#timer = setTimeout(() => {
        this.#timer = null;
        this.#flush();
      }, delay);
    }
  }

  /** Discards the pending position and cancels the scheduled send. */
  cancel(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#latest = null;
  }

  #flush(): void {
    const point = this.#latest;
    if (point === null) {
      return;
    }
    this.#latest = null;
    this.#lastSentAt = this.#now();
    this.#send(point);
  }
}

interface TrackedCursor extends Cursor {
  readonly lastSeen: number;
}

/**
 * The cursors of peers in the room, keyed by replica. Times are passed in so
 * the table never reads a clock itself.
 */
export class CursorTable {
  readonly #cursors = new Map<string, TrackedCursor>();

  /** Stores the latest state of a peer's cursor, seen at `now`. */
  update(cursor: Cursor, now: number): void {
    this.#cursors.set(cursor.replica, {
      replica: cursor.replica,
      x: cursor.x,
      y: cursor.y,
      name: cursor.name,
      color: cursor.color,
      lastSeen: now,
    });
  }

  /** Forgets a peer. Returns `true` if it had a cursor. */
  remove(replica: string): boolean {
    return this.#cursors.delete(replica);
  }

  /** Drops every cursor silent for {@link CURSOR_TTL_MS}. Returns `true` if any was removed. */
  expire(now: number): boolean {
    let dropped = false;
    for (const [replica, cursor] of this.#cursors) {
      if (now - cursor.lastSeen >= CURSOR_TTL_MS) {
        this.#cursors.delete(replica);
        dropped = true;
      }
    }
    return dropped;
  }

  /** The cursors still live at `now`, in the order they first appeared. */
  list(now: number): Cursor[] {
    const live: Cursor[] = [];
    for (const cursor of this.#cursors.values()) {
      if (now - cursor.lastSeen < CURSOR_TTL_MS) {
        live.push({
          replica: cursor.replica,
          x: cursor.x,
          y: cursor.y,
          name: cursor.name,
          color: cursor.color,
        });
      }
    }
    return live;
  }

  /** Removes every cursor. */
  clear(): void {
    this.#cursors.clear();
  }
}
