import { loadConfig } from "./config.js";
import { createServer, type RunningServer } from "./server.js";
import { Store } from "./store.js";

async function shutdown(server: RunningServer, store: Store): Promise<void> {
  await server.close();
  store.close();
}

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new Store(config.dbPath);
  const server = await createServer({ config, store }).catch((error: unknown) => {
    store.close();
    throw error;
  });
  console.log(`listening on ${config.host}:${server.port}`);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      shutdown(server, store).then(
        () => {
          process.exit(0);
        },
        () => {
          process.exit(1);
        },
      );
    });
  }
}

main().catch((error: unknown) => {
  const reason = error instanceof Error ? error.message : "unknown error";
  console.error(`failed to start: ${reason}`);
  process.exitCode = 1;
});
