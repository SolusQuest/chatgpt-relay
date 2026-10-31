export const RELAY_PRODUCT = "gpt-relay";
export const BACKEND_API_VERSION = 1;
export const DISCOVERY_TYPE = "gpt-relay";

export interface ServerInfo {
  product: typeof RELAY_PRODUCT;
  serverId: string;
  name: string;
  version: string;
  apiVersion: number;
  capabilities?: { dispatchV2: boolean };
}

export interface Backend {
  baseUrl: string;
  serverId?: string;
  name: string;
  version: string;
  legacy?: boolean;
}

export interface ProbeAttempt {
  timestamp: string;
  path: string;
  attempt: number;
  timeoutMs: number;
  elapsedMs: number;
  status?: number;
  outcome: "success" | "failure";
  retryable?: boolean;
  errors?: { name: string; message: string; code?: string; status?: number;
    syscall?: string; address?: string; port?: number }[];
}

export interface ProbeDiagnostics {
  probeId: string;
  baseUrl: string;
  elapsedMs: number;
  attempts: ProbeAttempt[];
  logFile?: string;
}

export class BackendError extends Error {
  constructor(public code: string, message: string, public candidates?: Backend[], public probe?: ProbeDiagnostics) {
    super(message);
  }
}
