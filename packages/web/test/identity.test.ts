import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  PRESENCE_COLOURS,
  colourFor,
  friendlyName,
  isDisplayName,
  sessionName,
} from "../src/identity.js";
import { MAX_NAME_LENGTH } from "../src/presence.js";

/** An in-memory Storage that holds string values. */
function memoryStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    get length() {
      return values.size;
    },
    clear: () => {
      values.clear();
    },
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => {
      values.delete(key);
    },
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

/** A random source that always returns the same index. */
const fixed = (index: number) => (bound: number) => index % bound;

describe("friendlyName", () => {
  it("builds adjective, noun and a two-digit number", () => {
    expect(friendlyName(fixed(0))).toBe("Brave Otter 10");
  });

  it("always fits the name limit and is a valid display name", () => {
    fc.assert(
      fc.property(fc.nat(), (seed) => {
        const name = friendlyName((bound) => seed % bound);
        expect(name.length).toBeLessThanOrEqual(MAX_NAME_LENGTH);
        expect(isDisplayName(name)).toBe(true);
      }),
    );
  });
});

describe("isDisplayName", () => {
  it("accepts 1 to 32 code points and rejects empty or longer names", () => {
    expect(isDisplayName("a")).toBe(true);
    expect(isDisplayName("a".repeat(32))).toBe(true);
    expect(isDisplayName("")).toBe(false);
    expect(isDisplayName("a".repeat(33))).toBe(false);
    expect(isDisplayName("😀".repeat(32))).toBe(true);
    expect(isDisplayName("😀".repeat(33))).toBe(false);
  });
});

describe("sessionName", () => {
  it("generates and stores a name when storage is empty", () => {
    const storage = memoryStorage();
    const name = sessionName(() => storage, fixed(3));
    expect(name).toBe(friendlyName(fixed(3)));
    expect(storage.getItem("collab-canvas.name")).toBe(name);
  });

  it("reuses the stored name on later calls", () => {
    const storage = memoryStorage();
    const first = sessionName(() => storage, fixed(1));
    const second = sessionName(() => storage, fixed(7));
    expect(second).toBe(first);
  });

  it("replaces a stored value that is not a valid name", () => {
    const storage = memoryStorage({ "collab-canvas.name": "" });
    const name = sessionName(() => storage, fixed(2));
    expect(name).toBe(friendlyName(fixed(2)));
    expect(storage.getItem("collab-canvas.name")).toBe(name);
  });

  it("falls back to a fresh name when the storage cannot be reached", () => {
    const name = sessionName(() => {
      throw new DOMException("denied", "SecurityError");
    }, fixed(4));
    expect(name).toBe(friendlyName(fixed(4)));
  });

  it("falls back to a fresh name when reading or writing throws", () => {
    const broken: Storage = {
      ...memoryStorage(),
      getItem: () => {
        throw new DOMException("quota", "QuotaExceededError");
      },
    };
    expect(sessionName(() => broken, fixed(5))).toBe(friendlyName(fixed(5)));
  });
});

describe("colourFor", () => {
  it("is stable for a name and always a presence colour", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (name) => {
        const colour = colourFor(name);
        expect(colour).toBe(colourFor(name));
        expect(PRESENCE_COLOURS).toContain(colour);
        expect(colour).toMatch(/^#[0-9a-f]{6}$/);
      }),
    );
  });
});
