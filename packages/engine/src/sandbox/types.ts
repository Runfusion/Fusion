export interface SandboxFallbackEvent {
  fromBackendId: SandboxCapabilities["id"];
  toBackendId: SandboxCapabilities["id"];
  reason: string;
}

export interface SandboxPolicy {
  allowNetwork: boolean;
  /** @future Backends with filesystem isolation will enforce this. */
  allowedReadPaths?: string[];
  /** @future Backends with filesystem isolation will enforce this. */
  allowedWritePaths?: string[];
  env?: NodeJS.ProcessEnv;
  onFallback?: (event: SandboxFallbackEvent) => void;
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

export interface SandboxRunStreamingOptions {
  cwd: string;
  timeout: number;
  maxBuffer: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

export type SandboxStreamingResult =
  | { outcome: "success"; stdout: string; stderr: string; bufferOverflow: boolean }
  | { outcome: "non-zero-exit"; stdout: string; stderr: string; exitCode: number | null; signal: NodeJS.Signals | null }
  | { outcome: "timeout"; stdout: string; stderr: string; timeoutMs: number }
  | { outcome: "aborted"; stdout: string; stderr: string; phase: "pre-start" | "mid-flight" }
  | { outcome: "spawn-error"; error: Error; stdout: string; stderr: string };

export interface SandboxCapabilities {
  id: "native" | "sandbox-exec" | "bubblewrap" | "firejail" | "docker" | "podman" | "custom";
  supportsNetworkPolicy: boolean;
  supportsFilesystemPolicy: boolean;
  supportsStreaming: boolean;
  platform: NodeJS.Platform[] | "any";
}

export interface SandboxBackend {
  /** Hot-path capability descriptor for backend selection/routing. */
  capabilities(): SandboxCapabilities;
  /** Prepare backend state for a policy. Must be idempotent. */
  prepare(policy: SandboxPolicy): Promise<void>;
  /** Execute a command in the backend's environment. */
  run(command: string, options: SandboxRunOptions): Promise<SandboxRunResult>;
  /**
   * Execute a spawn-shaped streaming command path.
   * Implementations must not throw for command-level outcomes (abort/timeout/non-zero);
   * return a structured result instead.
   */
  runStreaming(command: string, options: SandboxRunStreamingOptions): Promise<SandboxStreamingResult>;
  /** Best-effort cleanup hook for backend-owned resources. */
  dispose(): Promise<void>;
}
