import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
  readonly kind: string;
  readonly fill: string;
}

/** The debug hook as this spec reads it; the web client defines it in development builds. */
interface DebugWindow {
  readonly __ccDebug?: { readonly shapes: () => ShapeView[] };
}

/** Longest wait for a change made in one browser to appear in the other. */
const SYNC_TIMEOUT_MS = 10_000;

/** The README capture is a fixed 1280x800 viewport, rendered at 2x for sharp text. */
const CAPTURE_VIEWPORT = { width: 1280, height: 800 };
const CAPTURE_SCALE = 2;

/** Where the README image is written, relative to the repository root. */
const SCREENSHOT_PATH = fileURLToPath(new URL("../docs/screenshot.png", import.meta.url));

/** Display names are fixed per browser context so that assertions can name them. */
const ALICE = "Alice";
const BOB = "Bob";

/** Palette colour given to the rectangle that Alice recolours. */
const RECOLOUR = "#3b82f6";

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

/** Opens a context at the capture size whose tab is called `name`, then loads the room. */
async function openPeer(browser: Browser, room: string, name: string): Promise<Peer> {
  const context = await browser.newContext({
    viewport: CAPTURE_VIEWPORT,
    deviceScaleFactor: CAPTURE_SCALE,
  });
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

/** Chooses a tool with a pointer click on its toolbar button and checks it is pressed. */
async function chooseTool(
  page: Page,
  testId: "tool-rect" | "tool-ellipse" | "tool-pen" | "tool-select",
): Promise<void> {
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

/** Presses at the first point, moves through the others in steps and releases. */
async function stroke(page: Page, canvasPoints: readonly Point[]): Promise<void> {
  const points = await Promise.all(canvasPoints.map((p) => onCanvas(page, p.x, p.y)));
  const [first, ...rest] = points;
  if (first === undefined) {
    throw new Error("A stroke needs at least one point");
  }
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  for (const point of rest) {
    await page.mouse.move(point.x, point.y, { steps: 6 });
  }
  await page.mouse.up();
}

/** Every shape the page currently shows, in the client's own order. */
function shapesOf(page: Page): Promise<ShapeView[]> {
  return page.evaluate(() => (window as unknown as DebugWindow).__ccDebug?.shapes() ?? []);
}

/** The entries of the presence panel: this tab first, then its peers. */
function presenceEntries(page: Page): Locator {
  return page.getByTestId("presence-list").locator("li");
}

test("two users in one room, captured for the README", async ({ browser }) => {
  const room = `e2e-${randomBytes(6).toString("hex")}`;
  const alice = await openPeer(browser, room, ALICE);
  const bob = await openPeer(browser, room, BOB);
  try {
    const a = alice.page;
    const b = bob.page;

    await test.step("both tabs are online", async () => {
      await expect(a.getByTestId("connection-status")).toHaveText("online", {
        timeout: SYNC_TIMEOUT_MS,
      });
      await expect(b.getByTestId("connection-status")).toHaveText("online", {
        timeout: SYNC_TIMEOUT_MS,
      });
    });

    await test.step("Alice draws a rectangle and an ellipse", async () => {
      await chooseTool(a, "tool-rect");
      await drag(a, await onCanvas(a, 320, 200), await onCanvas(a, 560, 380));
      await chooseTool(a, "tool-ellipse");
      await drag(a, await onCanvas(a, 640, 200), await onCanvas(a, 900, 380));
    });

    await test.step("Bob draws a green pen stroke", async () => {
      await chooseTool(b, "tool-pen");
      await b.getByTestId("color-10b981").click();
      await stroke(b, [
        { x: 360, y: 520 },
        { x: 420, y: 460 },
        { x: 480, y: 540 },
        { x: 540, y: 480 },
        { x: 600, y: 560 },
        { x: 660, y: 500 },
      ]);
    });

    await test.step("Alice selects the rectangle and recolours it", async () => {
      await chooseTool(a, "tool-select");
      const centre = await onCanvas(a, 440, 290);
      await a.mouse.click(centre.x, centre.y);
      await a.getByTestId(`color-${RECOLOUR.slice(1)}`).click();
      const emptySpot = await onCanvas(a, 1000, 680);
      await a.mouse.click(emptySpot.x, emptySpot.y);
    });

    await test.step("both pages show the same three shapes", async () => {
      const expected = [
        { kind: "rect", fill: RECOLOUR },
        { kind: "ellipse" },
        { kind: "stroke" },
      ];
      await expect.poll(() => shapesOf(a), { timeout: SYNC_TIMEOUT_MS }).toMatchObject(expected);
      await expect.poll(() => shapesOf(b), { timeout: SYNC_TIMEOUT_MS }).toMatchObject(expected);
    });

    await test.step("both pointers rest on the canvas and each sees the other", async () => {
      const alicePointer = await onCanvas(a, 700, 620);
      const bobPointer = await onCanvas(b, 980, 540);
      await a.mouse.move(alicePointer.x, alicePointer.y, { steps: 4 });
      await b.mouse.move(bobPointer.x, bobPointer.y, { steps: 4 });
      await expect(presenceEntries(a)).toHaveText([`${ALICE} (you)`, BOB], {
        timeout: SYNC_TIMEOUT_MS,
      });
      await expect(presenceEntries(b)).toHaveText([`${BOB} (you)`, ALICE], {
        timeout: SYNC_TIMEOUT_MS,
      });
    });

    await test.step("capture the first page", async () => {
      mkdirSync(path.dirname(SCREENSHOT_PATH), { recursive: true });
      await a.screenshot({ path: SCREENSHOT_PATH });
    });
  } finally {
    await alice.context.close();
    await bob.context.close();
  }
});
