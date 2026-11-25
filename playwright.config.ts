import os from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const APP_URL = "http://127.0.0.1:5173";

/**
 * The end-to-end suite drives the real web client and WebSocket server. Its database
 * lives in the system temporary directory, never in the repository, so every run
 * starts from an empty op log.
 */
const e2eDbPath = path.join(os.tmpdir(), `collab-canvas-e2e-${process.pid}.db`);

/**
 * A Chromium binary given by `PW_CHROMIUM` replaces the one Playwright would download.
 * Left unset, Playwright uses its own default browser.
 */
const chromiumPath = process.env.PW_CHROMIUM;

export default defineConfig({
  testDir: "e2e",
  testMatch: "*.spec.ts",
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  timeout: 60_000,
  use: {
    baseURL: APP_URL,
    trace: "off",
    launchOptions: chromiumPath ? { executablePath: chromiumPath } : {},
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // `npm run dev` starts the WebSocket server on 8787 and the Vite client on 5173.
  webServer: {
    command: "npm run dev",
    url: APP_URL,
    reuseExistingServer: true,
    timeout: 120_000,
    env: { DB_PATH: e2eDbPath },
  },
});
