import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import os from "node:os";
import type { Db } from "./db.js";
import { BACKEND_API_VERSION, RELAY_PRODUCT, type ServerInfo } from "../shared/backend.js";

export function serverIdentity(db: Db): ServerInfo {
  db.exec("CREATE TABLE IF NOT EXISTS server_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.prepare("INSERT OR IGNORE INTO server_metadata(key,value) VALUES ('server_id',?)").run(randomUUID());
  const row = db.prepare("SELECT value FROM server_metadata WHERE key='server_id'").get() as { value: string };
  return { product: RELAY_PRODUCT, serverId: row.value, name: process.env.GPT_RELAY_NAME ?? os.hostname(),
    version: createRequire(import.meta.url)("../package.json").version, capabilities: { dispatchV2: true }, apiVersion: BACKEND_API_VERSION };
}
