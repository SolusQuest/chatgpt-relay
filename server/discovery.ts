import type { Bonjour } from "bonjour-service";
import { createBonjour } from "../shared/mdns.js";
import { DISCOVERY_TYPE, type ServerInfo } from "../shared/backend.js";
import { registerLocal } from "../shared/local-registry.js";

export function announceServer(identity: ServerInfo, host: string, port: number,
  createClient: (onError: (error: unknown) => void) => Bonjour = createBonjour): () => void {
  const address = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
  const baseUrl = `http://${address.includes(":") ? `[${address}]` : address}:${port}`;
  const unregister = registerLocal({ baseUrl, serverId: identity.serverId, pid: process.pid });
  const loopback = host === "localhost" || host === "::1" || host.startsWith("127.");
  let bonjour: Bonjour | undefined;
  if (!loopback && process.env.GPT_RELAY_DISCOVERY !== "0") {
    try {
      bonjour = createClient((error: unknown) => console.error("[discovery]", error));
      const service = bonjour.publish({ name: `gpt-relay-${identity.serverId}`, type: DISCOVERY_TYPE,
        // bonjour-service otherwise publishes every interface's A/AAAA records
        // under os.hostname(), conflicting with the OS's own mDNS responder.
        // Own a separate, stable host name instead of claiming the system name.
        host: `gpt-relay-${identity.serverId}.local`,
        protocol: "tcp", port,
        txt: { serverId: identity.serverId, apiVersion: String(identity.apiVersion), version: identity.version } });
      service.on("error", error => console.error("[discovery]", error));
    } catch (error) { console.error("[discovery] LAN announcement unavailable:", error); }
  }
  return () => { unregister(); bonjour?.unpublishAll(() => bonjour?.destroy()); };
}
