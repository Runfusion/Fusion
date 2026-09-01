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

/**
 * FNXC:RemoteAccess 2026-09-01-02:54:
 * PROOF that a funnel is actually serving right now, read from tailscaled's own serve config rather
 * than inferred from "tailscale is logged in" (which is all ExternalTunnelInfo's DNSName probe shows).
 * A relaunch after a supervised restart must adopt a surviving funnel instead of spawning a second
 * one: two `tailscale funnel` processes against one node conflict, the second exits 1 AND the first
 * one's config is cleared, which is precisely how remote access dies. Adoption therefore needs
 * evidence, and `proxyPort` is what lets the caller tell OUR funnel from somebody else's.
 */
export interface ActiveFunnelInfo {
  provider: "tailscale";
  url: string;
  /** Local port the funnel proxies to, when the serve config states one. */
  proxyPort: number | null;
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
  | "restore_started"
  /* FNXC:RemoteAccess 2026-09-01-02:54: a funnel proven to be serving our port was adopted instead of
     respawned — the transparent-restart outcome. */
  | "adopted_running_tunnel"
  /* FNXC:RemoteAccess 2026-09-01-02:54: a funnel is serving a DIFFERENT port. Starting ours would
     clear it, so restore refuses and reports rather than clobbering someone else's remote access. */
  | "external_funnel_conflict"
  /* FNXC:RemoteAccess 2026-08-31-07:08: restore ran while the tunnel was already up — an engine
     restart re-entering restore must leave a live tunnel untouched, not bounce it. */
  | "already_running";

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
