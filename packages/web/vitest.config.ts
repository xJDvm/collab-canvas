import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only run source tests; never the compiled copies emitted by `tsc -b` into dist/.
    include: ["test/**/*.test.ts"],
  },
});
