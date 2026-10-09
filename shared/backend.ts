export const RELAY_PRODUCT = "gpt-relay";
export const BACKEND_API_VERSION = 1;
export const DISCOVERY_TYPE = "gpt-relay";

export interface ServerInfo {
  product: typeof RELAY_PRODUCT;
  serverId: string;
  name: string;
  version: string;
  apiVersion: number;
}

export interface Backend {
  baseUrl: string;
  serverId?: string;
  name: string;
  version: string;
  legacy?: boolean;
}

export class BackendError extends Error {
  constructor(public code: string, message: string, public candidates?: Backend[]) {
    super(message);
  }
}
