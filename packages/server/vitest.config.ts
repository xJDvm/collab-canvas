import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Resolve the workspace CRDT from its sources; the package has no entry point of its own yet.
    alias: {
      "@collab-canvas/crdt": fileURLToPath(new URL("../crdt/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
});
