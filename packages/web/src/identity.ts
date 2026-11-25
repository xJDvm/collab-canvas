import { MAX_NAME_LENGTH } from "./presence.js";

/** Storage key under which the tab's display name is kept. */
const NAME_KEY = "collab-canvas.name";

/** Words that start a generated name. */
const ADJECTIVES = [
  "Brave",
  "Calm",
  "Clever",
  "Eager",
  "Gentle",
  "Jolly",
  "Keen",
  "Lively",
  "Merry",
  "Nimble",
  "Quiet",
  "Swift",
  "Witty",
  "Bold",
  "Bright",
  "Cosmic",
] as const;

/** Words that end a generated name. */
const NOUNS = [
  "Otter",
  "Falcon",
  "Panda",
  "Heron",
  "Lynx",
  "Badger",
  "Comet",
  "Maple",
  "Pebble",
  "Fox",
  "Koala",
  "Sparrow",
  "Tiger",
  "Whale",
  "Yak",
  "Owl",
] as const;

/** Colours that identify peers on the canvas. Each matches the server's colour pattern. */
export const PRESENCE_COLOURS = [
  "#ef4444",
  "#f59e0b",
  "#10b981",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#14b8a6",
  "#84cc16",
] as const;

/** Returns a whole number in `[0, bound)`. */
export type Random = (bound: number) => number;

/** Uniform random integer from the platform generator; used only for display names. */
export function randomBelow(bound: number): number {
  const [value = 0] = crypto.getRandomValues(new Uint32Array(1));
  return value % bound;
}

function pick<T>(items: readonly T[], random: Random): T {
  const item = items.at(random(items.length));
  if (item === undefined) {
    throw new RangeError("random index out of range");
  }
  return item;
}

/** A friendly name such as `Brave Otter 42`. Always within {@link MAX_NAME_LENGTH}. */
export function friendlyName(random: Random = randomBelow): string {
  const number = 10 + random(90);
  return `${pick(ADJECTIVES, random)} ${pick(NOUNS, random)} ${number}`;
}

/** Whether `value` can be used as a display name: 1 to {@link MAX_NAME_LENGTH} code points. */
export function isDisplayName(value: string): boolean {
  const length = [...value].length;
  return length >= 1 && length <= MAX_NAME_LENGTH;
}

/**
 * The display name of this tab. A name already stored in sessionStorage is
 * reused; otherwise one is generated and stored. When storage cannot be
 * reached (it is disabled, or it throws), a fresh name is returned and not stored.
 *
 * @param storage Returns the session storage, or throws if it is unavailable.
 */
export function sessionName(storage: () => Storage, random: Random = randomBelow): string {
  try {
    const kept = storage();
    const stored = kept.getItem(NAME_KEY);
    if (stored !== null && isDisplayName(stored)) {
      return stored;
    }
    const name = friendlyName(random);
    kept.setItem(NAME_KEY, name);
    return name;
  } catch {
    return friendlyName(random);
  }
}

/** The colour that identifies a peer with `name`. Stable for a given name. */
export function colourFor(name: string): (typeof PRESENCE_COLOURS)[number] {
  let sum = 0;
  for (const char of name) {
    sum += char.codePointAt(0) ?? 0;
  }
  return pick(PRESENCE_COLOURS, (bound) => sum % bound);
}
