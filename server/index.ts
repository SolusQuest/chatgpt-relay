// server/index.ts
// gpt-relay entry point: start the Express and node:sqlite HTTP relay.
import { loadConfig } from "./config.js";
import { createApp } from "./app.js";
import { announceServer } from "./discovery.js";

const config = loadConfig();
const { app, identity, closeDatabase, stopMaintenance } = createApp(config);
let stopAnnouncement: (() => void) | undefined;

const server = app.listen(config.port, config.host, () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.port;
  const host = typeof address === "object" && address ? address.address : config.host;
  stopAnnouncement = announceServer(identity, host, port);
  console.log(
    `gpt-relay listening on http://${config.host}:${port}`,
  );
  console.log(`  data dir: ${config.dataDir}`);
  console.log(`  db file:  ${config.dbFile}`);
});

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  stopAnnouncement?.();
  stopMaintenance();
  // Close held long polls before closing SQLite. Durable task state remains intact.
  server.closeAllConnections();
  server.close(() => { closeDatabase(); process.exitCode = 0; });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
