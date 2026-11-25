/**
 * A hybrid logical stamp that totally orders operations across replicas.
 *
 * Stamps are compared by `lamport` first and by `replica` second, so two
 * stamps are equal only when both fields are equal.
 */
export type Stamp = { readonly lamport: number; readonly replica: string };

const REPLICA_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Totally orders two stamps: by `lamport`, then by `replica` compared
 * lexicographically by UTF-16 code unit.
 *
 * @returns `-1` if `a` sorts before `b`, `1` if after, `0` if they are equal.
 */
export function compareStamps(a: Stamp, b: Stamp): number {
  if (a.lamport !== b.lamport) {
    return a.lamport < b.lamport ? -1 : 1;
  }
  if (a.replica === b.replica) {
    return 0;
  }
  return a.replica < b.replica ? -1 : 1;
}

/**
 * A Lamport clock owned by one replica.
 *
 * Every stamp it produces carries the replica id and a strictly increasing
 * `lamport` value, which is advanced past any stamp passed to {@link Clock.observe}.
 */
export class Clock {
  readonly #replica: string;
  #lamport = 0;

  /**
   * @param replica Identifier of the owning replica: 1 to 64 characters from
   *   `[A-Za-z0-9_-]`.
   * @throws {RangeError} If `replica` does not match that pattern.
   */
  constructor(replica: string) {
    if (!REPLICA_PATTERN.test(replica)) {
      throw new RangeError("replica must match ^[A-Za-z0-9_-]{1,64}$");
    }
    this.#replica = replica;
  }

  /**
   * Advances the clock and returns a new stamp for a local event.
   *
   * @throws {RangeError} If the next lamport value would exceed
   *   `Number.MAX_SAFE_INTEGER`.
   */
  tick(): Stamp {
    if (this.#lamport >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError("lamport clock overflow");
    }
    this.#lamport += 1;
    return { lamport: this.#lamport, replica: this.#replica };
  }

  /**
   * Merges a stamp received from another replica, so that the next local
   * stamp sorts after it.
   *
   * @throws {RangeError} If `s.lamport` is not a safe integer.
   */
  observe(s: Stamp): void {
    if (!Number.isSafeInteger(s.lamport)) {
      throw new RangeError("remote lamport must be a safe integer");
    }
    this.#lamport = Math.max(this.#lamport, s.lamport);
  }
}
