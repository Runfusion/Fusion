export type DevServerId = string & { readonly __brand: unique symbol };

export function createDevServerId(id: string): DevServerId {
  return id as DevServerId;
}

export type DevServerStatus = "stopped" | "starting" | "running" | "failed" | "stopping";

export interface DevServerConfig {
  id: DevServerId;
  name: string;
  command: string;
  cwd: string;
  env?: Record<string, string>;
  autoStart?: boolean;
}

export interface DevServerRuntime {
  pid: number;
  startedAt: string;
  exitCode?: number;
  previewUrl?: string;
}

export interface DevServerLogEntry {
  timestamp: string;
  stream: "stdout" | "stderr";
  text: string;
}

export interface DevServerSession {
  config: DevServerConfig;
  status: DevServerStatus;
  runtime?: DevServerRuntime;
  previewUrl?: string;
  logHistory: DevServerLogEntry[];
}

export const MAX_LOG_ENTRIES = 500;

export type DevServerSessionMap = Map<string, DevServerSession>;
