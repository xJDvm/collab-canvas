/**
 * Token bucket that holds at most `capacity` tokens and refills at `ratePerSecond`.
 *
 * The caller supplies the time in milliseconds on a monotonic clock, which keeps the
 * bucket free of timers and easy to test. Time that goes backwards is ignored.
 */
export class TokenBucket {
  readonly #ratePerMs: number;
  readonly #capacity: number;
  #tokens: number;
  #updatedAt: number;

  /**
   * Creates a full bucket.
   * @param ratePerSecond Refill rate; must be a positive finite number.
   * @param capacity Maximum number of tokens; must be a finite number of at least 1.
   * @param now Current time in milliseconds.
   * @throws RangeError if `ratePerSecond` or `capacity` is out of range.
   */
  constructor(ratePerSecond: number, capacity: number, now: number) {
    if (!Number.isFinite(ratePerSecond) || ratePerSecond <= 0) {
      throw new RangeError(`ratePerSecond must be a positive number, got ${ratePerSecond}`);
    }
    if (!Number.isFinite(capacity) || capacity < 1) {
      throw new RangeError(`capacity must be at least 1, got ${capacity}`);
    }
    this.#ratePerMs = ratePerSecond / 1000;
    this.#capacity = capacity;
    this.#tokens = capacity;
    this.#updatedAt = now;
  }

  /**
   * Takes one token if one is available at time `now`.
   * @returns `true` if the action is allowed, `false` if the bucket is empty.
   */
  tryTake(now: number): boolean {
    if (now > this.#updatedAt) {
      const refill = (now - this.#updatedAt) * this.#ratePerMs;
      this.#tokens = Math.min(this.#capacity, this.#tokens + refill);
      this.#updatedAt = now;
    }
    if (this.#tokens < 1) {
      return false;
    }
    this.#tokens -= 1;
    return true;
  }
}
