import type { ChildProcess } from "node:child_process";

export type TunnelProvider = "tailscale" | "cloudflare";

export type TunnelLifecycleState =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "failed";

export type TunnelErrorCode =
  | "invalid_config"
  | "already_running"
  | "already_stopped"
  | "start_failed"
  | "stop_failed"
  | "switch_failed"
  | "credential_missing"
  | "process_exit"
  | "readiness_timeout"
  | "signal_failed";

export interface TunnelError {
  code: TunnelErrorCode;
  message: string;
  at: string;
}

export interface TunnelStatusSnapshot {
  provider: TunnelProvider | null;
  state: TunnelLifecycleState;
  pid: number | null;
  startedAt: string | null;
  stoppedAt: string | null;
  url: string | null;
  lastError: TunnelError | null;
}

export interface ExternalTunnelInfo {
  provider: TunnelProvider;
  url: string | null;
  pid: number | null;
}

export type TunnelRestoreOutcome = "applied" | "skipped" | "failed";

export type TunnelRestoreReasonCode =
  | "not_attempted"
  | "remote_access_disabled"
  | "remember_last_running_disabled"
  | "no_prior_running_marker"
  | "provider_missing"
  | "provider_not_enabled"
  | "provider_not_configured"
  | "runtime_prerequisite_missing"
  | "restore_start_failed"
  | "restore_started";

export interface TunnelRestoreDiagnostics {
  outcome: TunnelRestoreOutcome;
  reason: TunnelRestoreReasonCode;
  at: string;
  provider: TunnelProvider | null;
  message?: string;
}

export type TunnelLogLevel = "info" | "warn" | "error";

export interface TunnelLogEntry {
  timestamp: string;
  provider: TunnelProvider | null;
  level: TunnelLogLevel;
  source: "manager" | "stdout" | "stderr";
  message: string;
}

export type TunnelStatusListener = (snapshot: TunnelStatusSnapshot) => void;

export type TunnelLogListener = (entry: TunnelLogEntry) => void;

export interface TunnelManager {
  getStatus(): TunnelStatusSnapshot;
  start(provider: TunnelProvider, config: TunnelProviderConfig): Promise<void>;
  stop(): Promise<void>;
  switchProvider(target: TunnelProvider, config: TunnelProviderConfig): Promise<void>;
  subscribeStatus(listener: TunnelStatusListener): () => void;
  subscribeLogs(listener: TunnelLogListener): () => void;
}

interface TunnelProviderConfigBase {
  provider: TunnelProvider;
  executablePath: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  readinessTimeoutMs?: number;
  stopTimeoutMs?: number;
  /**
   * Names of env vars that should always be masked in status/log output.
   * Values are sourced by the caller and MUST NOT be logged verbatim.
   */
  sensitiveEnvVars?: string[];
}

export interface TailscaleProviderConfig extends TunnelProviderConfigBase {
  provider: "tailscale";
  /**
   * Optional environment variable name holding an auth key/token reference.
   * The manager validates that it exists when provided, but never logs its value.
   */
  tokenEnvVar?: string;
}

export interface CloudflareProviderConfig extends TunnelProviderConfigBase {
  provider: "cloudflare";
  /**
   * Enables account-less Cloudflare quick tunnels (`cloudflared tunnel --url ...`).
   * In this mode, no token env var or credentials file is required.
   */
  quickTunnel?: boolean;
  /**
   * Optional environment variable name holding a Cloudflare token reference.
   * The manager validates that it exists when provided, but never logs its value.
   */
  tokenEnvVar?: string;
  /**
   * Optional path to Cloudflare credentials JSON used by cloudflared.
   */
  credentialsPath?: string;
}

export type TunnelProviderConfig = TailscaleProviderConfig | CloudflareProviderConfig;

export interface PreparedTunnelCommand {
  provider: TunnelProvider;
  command: string;
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  redactedPreview: string;
  sensitiveValues: string[];
  readinessTimeoutMs: number;
  stopTimeoutMs: number;
}

export interface TunnelReadinessEvent {
  ready: boolean;
  url?: string;
  reason?: string;
}

export type TunnelOutputStream = "stdout" | "stderr";

export interface TunnelProviderAdapter {
  provider: TunnelProvider;
  validateConfig(config: TunnelProviderConfig): void;
  buildCommand(config: TunnelProviderConfig): PreparedTunnelCommand;
  parseReadiness(line: string, stream: TunnelOutputStream): TunnelReadinessEvent | null;
}

export interface ManagedTunnelProcess {
  provider: TunnelProvider;
  child: ChildProcess;
  command: PreparedTunnelCommand;
}
