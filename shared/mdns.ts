import { Bonjour } from "bonjour-service";
import type { Socket } from "node:dgram";
import type { EventEmitter } from "node:events";

export interface MdnsOptions {
  port?: number;
  ip?: string;
  bind?: string | false;
  multicast?: boolean;
  socket?: Socket;
}

export function createBonjour(onError: (error: unknown) => void, options?: MdnsOptions): Bonjour {
  const client = new Bonjour(options, onError);
  // bonjour-service's callback covers query responses, while socket errors are
  // emitted by its multicast-dns transport. Keep this dependency detail here.
  const transport = (client as unknown as { server: { mdns: EventEmitter } }).server.mdns;
  transport.on("error", onError);
  const destroy = client.destroy.bind(client);
  client.destroy = callback => {
    try { destroy(callback); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ERR_SOCKET_DGRAM_NOT_RUNNING") throw error;
      callback?.();
    }
  };
  return client;
}
