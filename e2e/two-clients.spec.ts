import { randomBytes } from "node:crypto";
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";

/** A shape as the web client reports it through `window.__ccDebug.shapes()`. */
interface ShapeView {
  readonly id: string;
  readonly kind: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

declare global {
  interface Window {
    __ccDebug?: { shapes: () => ShapeView[] };
  }
}

/** Longest wait for a change made in one browser to appear in the other. */
const SYNC_TIMEOUT_MS = 10_000;

/** Display names are fixed per browser context so that assertions can name them. */
const ALICE = "Alice";
const BOB = "Bob";

/** A position in page coordinates, in CSS pixels. */
interface Point {
  readonly x: number;
  readonly y: number;
}

/** A browser context and its only page, joined to the same room. */
interface Peer {
  readonly context: BrowserContext;
  readonly page: Page;
}

/** Opens a fresh context whose tab is called `name`, then loads the room. */
async function openPeer(browser: Browser, room: string, name: string): Promise<Peer> {
  const context = await browser.newContext();
  await context.addInitScript((displayName: string) => {
    window.sessionStorage.setItem("collab-canvas.name", displayName);
  }, name);
  const page = await context.newPage();
  await page.goto(`/#room=${room}`);
  return { context, page };
}

/** Converts a point given relative to the canvas into page coordinates. */
async function onCanvas(page: Page, x: number, y: number): Promise<Point> {
  const box = await page.getByTestId("canvas").boundingBox();
  if (box === null) {
    throw new Error("The canvas is not visible");
  }
  return { x: box.x + x, y: box.y + y };
}

/** Moves the pointer over the canvas, without pressing a button. */
async function hover(page: Page, x: number, y: number): Promise<void> {
  const point = await onCanvas(page, x, y);
  await page.mouse.move(point.x, point.y);
}

/** Chooses a tool with a pointer click on its toolbar button and checks it is pressed. */
async function chooseTool(page: Page, testId: "tool-rect" | "tool-select"): Promise<void> {
  const button = page.getByTestId(testId);
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
}

/** Presses at `from`, drags to `to` in several steps and releases. */
async function drag(page: Page, from: Point, to: Point): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
}

/** Every shape the page currently shows, in the client's own order. */
function shapesOf(page: Page): Promise<ShapeView[]> {
  return page.evaluate(() => window.__ccDebug?.shapes() ?? []);
}

/** The entries of the presence panel: this tab first, then its peers. */
function presenceEntries(page: Page): Locator {
  return page.getByTestId("presence-list").locator("li");
}

test("two browsers in one room converge on drawing, moving and presence", async ({ browser }) => {
  const room = `e2e-${randomBytes(6).toString("hex")}`;
  const alice = await openPeer(browser, room, ALICE);
  const bob = await openPeer(browser, room, BOB);
  try {
    const a = alice.page;
    const b = bob.page;

    await test.step("both tabs are online before anything is drawn", async () => {
      await expect(a.getByTestId("connection-status")).toHaveText("online", {
        timeout: SYNC_TIMEOUT_MS,
      });
      await expect(b.getByTestId("connection-status")).toHaveText("online", {
        timeout: SYNC_TIMEOUT_MS,
      });
    });

    await test.step("each page lists the other person after a pointer move", async () => {
      await hover(a, 100, 100);
      await hover(b, 120, 120);
      await expect(presenceEntries(a)).toHaveText([`${ALICE} (you)`, BOB], {
        timeout: SYNC_TIMEOUT_MS,
      });
      await expect(presenceEntries(b)).toHaveText([`${BOB} (you)`, ALICE], {
        timeout: SYNC_TIMEOUT_MS,
      });
    });

    await test.step("A draws a rectangle that B sees", async () => {
      await chooseTool(a, "tool-rect");
      await drag(a, await onCanvas(a, 200, 200), await onCanvas(a, 400, 320));
      await expect
        .poll(() => shapesOf(b), { timeout: SYNC_TIMEOUT_MS })
        .toMatchObject([{ kind: "rect" }]);
    });

    await test.step("B moves the rectangle and A sees the new position", async () => {
      const [before] = await shapesOf(b);
      if (before === undefined) {
        throw new Error("B has no shape to move");
      }
      await chooseTool(b, "tool-select");
      await drag(b, await onCanvas(b, 300, 260), await onCanvas(b, 380, 300));
      const [moved] = await shapesOf(b);
      if (moved === undefined) {
        throw new Error("B lost the shape while moving it");
      }
      expect(moved.x).not.toBe(before.x);
      await expect
        .poll(async () => (await shapesOf(a))[0]?.x, { timeout: SYNC_TIMEOUT_MS })
        .toBe(moved.x);
    });

    await test.step("both documents settle to the same shape list", async () => {
      const settled = await shapesOf(b);
      expect(settled).toHaveLength(1);
      await expect.poll(() => shapesOf(a), { timeout: SYNC_TIMEOUT_MS }).toEqual(settled);
    });
  } finally {
    await alice.context.close();
    await bob.context.close();
  }
});
