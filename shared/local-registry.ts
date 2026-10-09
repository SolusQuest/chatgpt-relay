import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const registryDir = () => process.env.GPT_RELAY_REGISTRY_DIR ?? path.join(os.homedir(), ".gpt-relay", "servers");
export interface LocalRegistration { baseUrl: string; serverId: string; pid: number }

export function registerLocal(record: LocalRegistration): () => void {
  const directory = registryDir();
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${randomUUID()}.json`);
  fs.writeFileSync(file, JSON.stringify(record), { flag: "wx", mode: 0o600 });
  return () => { try { fs.unlinkSync(file); } catch { /* Already removed. */ } };
}

export function localRegistrations(): LocalRegistration[] {
  const directory = registryDir();
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter(file => file.endsWith(".json")).flatMap(file => {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(directory, file), "utf8"));
      return typeof record.baseUrl === "string" && typeof record.serverId === "string" &&
        Number.isSafeInteger(record.pid) ? [record as LocalRegistration] : [];
    } catch { return []; }
  });
}
