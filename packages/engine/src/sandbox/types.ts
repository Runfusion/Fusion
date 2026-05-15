export interface SandboxPolicy {
  allowNetwork: boolean;
  /** @future Backends with filesystem isolation will enforce this. */
  allowedReadPaths?: string[];
  /** @future Backends with filesystem isolation will enforce this. */
  allowedWritePaths?: string[];
  env?: NodeJS.ProcessEnv;
}

export interface SandboxRunOptions {
  cwd: string;
  timeoutMs: number;
  maxBuffer: number;
  shell?: string | boolean;
  env?: NodeJS.ProcessEnv;
  encoding?: BufferEncoding;
  signal?: AbortSignal;
}

export interface SandboxRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  bufferExceeded: boolean;
  spawnError?: Error;
}

export interface SandboxCapabilities {
  id: "native" | "sandbox-exec" | "bubblewrap" | "firejail" | "docker" | "podman" | "custom";
  supportsNetworkPolicy: boolean;
  supportsFilesystemPolicy: boolean;
  platform: NodeJS.Platform[] | "any";
}

export interface SandboxBackend {
  /** Hot-path capability descriptor for backend selection/routing. */
  capabilities(): SandboxCapabilities;
  /** Prepare backend state for a policy. Must be idempotent. */
  prepare(policy: SandboxPolicy): Promise<void>;
  /** Execute a command in the backend's environment. */
  run(command: string, options: SandboxRunOptions): Promise<SandboxRunResult>;
  /** Best-effort cleanup hook for backend-owned resources. */
  dispose(): Promise<void>;
}
