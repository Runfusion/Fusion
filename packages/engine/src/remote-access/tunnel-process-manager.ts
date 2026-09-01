import { EventEmitter } from "node:events";
import { exec, execFile, spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { promisify } from "node:util";
import { releaseSupervisedChild, superviseSpawn, type SupervisedChild } from "@fusion/core";
import { remoteTunnelLog } from "../logger.js";
import {
  getTunnelProviderAdapter,
  redactTunnelText,
} from "./provider-adapters.js";
import type {
  ActiveFunnelInfo,
  ManagedTunnelProcess,
  ExternalTunnelInfo,
  TunnelErrorCode,
  TunnelLogEntry,
  TunnelLogLevel,
  TunnelLogListener,
  TunnelManager,
  TunnelOutputStream,
  TunnelProvider,
  TunnelProviderConfig,
  TunnelStatusListener,
  TunnelStatusSnapshot,
} from "./types.js";

export interface TunnelProcessManagerOptions {
  maxLogEntries?: number;
  stopTimeoutMs?: number;
  restartBaseDelayMs?: number;
  restartMaxDelayMs?: number;
  autoRestart?: boolean;
  spawnImpl?: typeof spawn;
}

const DEFAULT_MAX_LOG_ENTRIES = 400;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const DEFAULT_RESTART_BASE_DELAY_MS = 1_000;
const DEFAULT_RESTART_MAX_DELAY_MS = 30_000;
const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

/** Shape of `tailscale serve status --json` that adoption depends on. Everything is optional: the
 * command prints an empty object when nothing is served. */
interface ServeConfigScope {
  AllowFunnel?: Record<string, boolean>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string } | undefined> }>;
  TCP?: Record<string, { TCPForward?: string } | undefined>;
}

/*
FNXC:RemoteAccess 2026-09-01-03:49:
`tailscale funnel <port>` runs a FOREGROUND session, and tailscaled files that session's config under
`Foreground.<session-id>` — NOT at the top level. Reading only the top level found nothing for the
tunnel Fusion actually spawns, so a funnel surviving a supervised restart was never adopted: the
status route reported `stopped` with `no_prior_running_marker` while traffic was demonstrably flowing
and the public URL served 200. Measured on the live container; the same reason `tailscale funnel
status` prints "No serve config" for a working funnel (it reports only the persistent config).

Top-level scopes are still read first so a backgrounded `tailscale funnel --bg` (persistent config)
keeps working; foreground sessions are then scanned in turn.
*/
interface ServeConfigJson extends ServeConfigScope {
  Foreground?: Record<string, ServeConfigScope | undefined>;
}

/** Every scope a funnel may be declared in, most-authoritative first. */
function serveConfigScopes(config: ServeConfigJson): ServeConfigScope[] {
  const foreground = Object.values(config.Foreground ?? {}).filter(
    (scope): scope is ServeConfigScope => Boolean(scope),
  );
  return [config, ...foreground];
}

class LineBuffer {
  private pending = "";

  push(chunk: string): string[] {
    this.pending += chunk;
    const lines = this.pending.split(/\r?\n/);
    this.pending = lines.pop() ?? "";
    return lines.map((line) => line.trim()).filter(Boolean);
  }

  flush(): string[] {
    const tail = this.pending.trim();
    this.pending = "";
    return tail ? [tail] : [];
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeError(input: unknown): Error {
  if (input instanceof Error) {
    return input;
  }
  return new Error(String(input));
}

function maskSensitive(message: string, processHandle: ManagedTunnelProcess | null): string {
  if (!processHandle) {
    return message;
  }
  return redactTunnelText(message, processHandle.command.sensitiveValues);
}

function killManagedProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  if (typeof child.pid !== "number") {
    return;
  }

  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to direct pid.
    }
  }

  try {
    process.kill(child.pid, signal);
  } catch {
    // Process may already be gone.
  }
}

function toStateError(code: TunnelErrorCode, err: unknown): { code: TunnelErrorCode; message: string; at: string } {
  const normalized = normalizeError(err);
  return {
    code,
    message: normalized.message,
    at: nowIso(),
  };
}

export class TunnelProcessManager extends EventEmitter implements TunnelManager {
  private readonly maxLogEntries: number;
  private readonly defaultStopTimeoutMs: number;
  private readonly restartBaseDelayMs: number;
  private readonly restartMaxDelayMs: number;
  private readonly autoRestart: boolean;
  private readonly spawnImpl: typeof spawn;

  private status: TunnelStatusSnapshot = {
    provider: null,
    state: "stopped",
    pid: null,
    startedAt: null,
    stoppedAt: null,
    url: null,
    lastError: null,
  };

  private logs: TunnelLogEntry[] = [];
  private readonly statusListeners = new Set<TunnelStatusListener>();
  private readonly logListeners = new Set<TunnelLogListener>();
  private processHandle: ManagedTunnelProcess | null = null;
  private supervisedHandle: SupervisedChild | null = null;
  /*
  FNXC:RemoteAccess 2026-09-01-02:54:
  True when this manager represents a funnel it did NOT spawn — one that survived a supervised restart
  and was adopted on relaunch. There is no child to signal, so stop() must reset the provider's own
  config instead; without this an operator "Stop remote access" after a restart would report stopped
  while the funnel kept serving.
  */
  private adopted = false;
  private readinessTimer: NodeJS.Timeout | null = null;
  private stopTimer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private operationChain: Promise<void> = Promise.resolve();
  private expectedStop = false;
  private activeStopPromise: Promise<void> | null = null;
  private desiredTunnel: { provider: TunnelProvider; config: TunnelProviderConfig } | null = null;
  private restartAttempt = 0;

  constructor(options: TunnelProcessManagerOptions = {}) {
    super();
    this.maxLogEntries = options.maxLogEntries ?? DEFAULT_MAX_LOG_ENTRIES;
    this.defaultStopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    this.restartBaseDelayMs = options.restartBaseDelayMs ?? DEFAULT_RESTART_BASE_DELAY_MS;
    this.restartMaxDelayMs = options.restartMaxDelayMs ?? DEFAULT_RESTART_MAX_DELAY_MS;
    this.autoRestart = options.autoRestart ?? true;
    this.spawnImpl = options.spawnImpl ?? spawn;
  }

  getStatus(): TunnelStatusSnapshot {
    return { ...this.status, lastError: this.status.lastError ? { ...this.status.lastError } : null };
  }

  subscribeStatus(listener: TunnelStatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.getStatus());
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  subscribeLogs(listener: TunnelLogListener): () => void {
    this.logListeners.add(listener);
    return () => {
      this.logListeners.delete(listener);
    };
  }

  async start(provider: TunnelProvider, config: TunnelProviderConfig): Promise<void> {
    return this.runExclusive(async () => {
      if (this.processHandle || this.status.state === "starting" || this.status.state === "running") {
        throw new Error("already_running:tunnel process is already active");
      }
      this.clearRestartTimer();
      this.desiredTunnel = { provider, config };
      try {
        await this.startInternal(provider, config);
      } catch (error) {
        this.desiredTunnel = null;
        throw error;
      }
    });
  }

  async stop(): Promise<void> {
    return this.runExclusive(async () => {
      this.desiredTunnel = null;
      this.restartAttempt = 0;
      this.clearRestartTimer();
      await this.stopInternal();
    });
  }

  async detectExternalFunnel(): Promise<ExternalTunnelInfo | null> {
    if (this.processHandle || this.status.state === "starting" || this.status.state === "running") {
      return null;
    }

    try {
      const { stdout } = await execFileAsync("tailscale", ["status", "--json"], { timeout: 3_000 });
      const data = JSON.parse(String(stdout)) as { Self?: { DNSName?: string } };
      const dnsName = data.Self?.DNSName?.replace(/\.$/, "");
      if (!dnsName) {
        return null;
      }

      return {
        provider: "tailscale",
        url: `https://${dnsName}/`,
        pid: null,
      };
    } catch {
      return null;
    }
  }

  async killExternalFunnel(): Promise<void> {
    const resetCommands: Array<{ command: string; args: string[] }> = [
      { command: "tailscale", args: ["serve", "reset"] },
      { command: "tailscale", args: ["funnel", "reset"] },
      { command: "tailscale", args: ["funnel", "off"] },
    ];

    for (const resetCommand of resetCommands) {
      try {
        await execFileAsync(resetCommand.command, resetCommand.args, { timeout: 5_000 });
        return;
      } catch {
        // continue to next strategy
      }
    }

    try {
      const { stdout } = await execAsync("pgrep -f \"tailscale funnel\"", { timeout: 5_000 });
      const pids = stdout
        .split(/\s+/)
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isInteger(value) && value > 0);

      await Promise.all(pids.map(async (pid) => {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // ignore if process already stopped
        }
      }));
    } catch {
      // tailscale may not be installed or no matching process may exist
    }
  }

  /**
   * FNXC:RemoteAccess 2026-09-01-02:54:
   * A SUPERVISED RESTART IS NOT A SHUTDOWN.
   *
   * Incident (twice on the operator's container): pressing "Restart" in Command Center — and the new
   * "Update from source" control, which ends in the same restart — silently killed remote access. The
   * dashboard exits with FUSION_RESTART_EXIT_CODE and the entrypoint's supervisor loop relaunches it,
   * so the tunnel teardown that was scoped to "process exit" now ran on every routine restart. The
   * container came back healthy while the public URL stayed dead.
   *
   * Release hands the funnel child over to the machine instead of killing it: it leaves the OS process
   * alone and only removes it from `superviseSpawn`'s parent-death kill registry, which would otherwise
   * SIGTERM its process group from the `process.on("exit")` hook. The child was spawned detached, so it
   * survives as its own process-group leader and is reparented to the supervisor.
   *
   * MEASURED CAVEAT (2026-09-01): a released child whose stdout is still our pipe dies if it WRITES
   * after we exit — the read end goes with us and the write takes EPIPE/SIGPIPE. A quiet child
   * survives indefinitely. Survival is therefore best-effort, and the restore path is built to be
   * correct either way: the running marker is persisted before release, the relaunch adopts a funnel
   * it can prove is serving, and respawns one when it cannot. Worst case is a few seconds of restore,
   * never the permanent dark URL this replaces.
   *
   * Returns true only when a live child was actually released.
   */
  releaseForSupervisedRestart(): boolean {
    const handle = this.processHandle;
    const supervised = this.supervisedHandle;
    if (!handle || !supervised) {
      return false;
    }
    if (this.status.state !== "running" && this.status.state !== "starting") {
      return false;
    }

    this.clearReadinessTimer();
    this.clearRestartTimer();
    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
    // No auto-restart bookkeeping can outlive this process, and the child must never be re-adopted by
    // a close handler that fires while we are exiting.
    this.desiredTunnel = null;
    this.expectedStop = false;
    handle.child.removeAllListeners("close");
    handle.child.removeAllListeners("error");

    const released = releaseSupervisedChild(supervised.pid);
    this.emitLog(
      released ? "info" : "warn",
      "manager",
      released
        ? `Releasing ${handle.provider} tunnel (pid=${handle.child.pid ?? "n/a"}) across a supervised restart — remote access must outlive the relaunch`
        : `Could not release ${handle.provider} tunnel (pid=${handle.child.pid ?? "n/a"}) from process supervision`,
    );

    handle.child.unref?.();
    this.processHandle = null;
    this.supervisedHandle = null;
    return released;
  }

  /**
   * FNXC:RemoteAccess 2026-09-01-02:54:
   * Take ownership of a funnel this process did not spawn (the one released by the process we are
   * replacing). Reported as `running` so the UI and the merge of engine restarts see continuity, with
   * `pid: null` because there is no child of ours behind it.
   */
  adoptRunningTunnel(provider: TunnelProvider, url: string | null): void {
    if (this.processHandle) {
      return;
    }
    this.adopted = true;
    this.desiredTunnel = null;
    this.updateStatus({
      provider,
      state: "running",
      pid: null,
      startedAt: nowIso(),
      stoppedAt: null,
      url,
      lastError: null,
    });
    this.emitLog("info", "manager", `Adopted an already-running ${provider} tunnel${url ? ` (${url})` : ""}`);
  }

  /**
   * FNXC:RemoteAccess 2026-09-01-02:54:
   * Ask tailscaled what it is ACTUALLY serving. `detectExternalFunnel` only proves the node is logged
   * in (it reads Self.DNSName), which is not evidence a funnel exists; adopting on that would report a
   * dead URL as running. The serve config names the funnel host and the local port it proxies to, so
   * the caller can tell our funnel from a foreign one before deciding to adopt or refuse.
   *
   * Bounded and failure-tolerant: any error means "cannot prove one", never a thrown restore.
   */
  async detectActiveFunnel(): Promise<ActiveFunnelInfo | null> {
    let stdout = "";
    try {
      const result = await execFileAsync("tailscale", ["serve", "status", "--json"], { timeout: 5_000 });
      stdout = String(result.stdout ?? "");
    } catch (error) {
      const failure = error as { stdout?: string };
      stdout = String(failure.stdout ?? "");
      if (!stdout.trim()) {
        return null;
      }
    }

    let config: ServeConfigJson;
    try {
      config = JSON.parse(stdout) as ServeConfigJson;
    } catch {
      return null;
    }

    let funnelHost: string | undefined;
    let host: string | undefined;
    let proxyPort: number | null = null;

    for (const scope of serveConfigScopes(config)) {
      const candidateHost = Object.entries(scope.AllowFunnel ?? {}).find(([, allowed]) => allowed === true)?.[0];
      if (!candidateHost) continue;
      const candidateName = candidateHost.split(":")[0];
      if (!candidateName) continue;

      let candidatePort: number | null = null;
      const handlers = scope.Web?.[candidateHost]?.Handlers ?? {};
      for (const handler of Object.values(handlers)) {
        const match = handler?.Proxy?.match(/:(\d+)(?:\/|$)/);
        if (match?.[1]) {
          candidatePort = Number(match[1]);
          break;
        }
      }
      if (candidatePort === null) {
        const tcpPort = Object.values(scope.TCP ?? {}).find((entry) => typeof entry?.TCPForward === "string")?.TCPForward;
        const tcpMatch = tcpPort?.match(/:(\d+)$/);
        if (tcpMatch?.[1]) {
          candidatePort = Number(tcpMatch[1]);
        }
      }

      funnelHost = candidateHost;
      host = candidateName;
      proxyPort = candidatePort;
      if (proxyPort !== null) break;
    }

    if (!funnelHost || !host) {
      return null;
    }

    return { provider: "tailscale", url: `https://${host}/`, proxyPort };
  }

  async switchProvider(target: TunnelProvider, config: TunnelProviderConfig): Promise<void> {
    return this.runExclusive(async () => {
      this.clearRestartTimer();
      this.desiredTunnel = { provider: target, config };
      const previousProvider = this.status.provider;
      if (this.processHandle) {
        await this.stopInternal();
      }

      try {
        await this.startInternal(target, config);
      } catch (error) {
        this.desiredTunnel = null;
        const stateError = toStateError("switch_failed", error);
        const redactedMessage = this.redactForProviderConfig(target, config, stateError.message);
        this.updateStatus({
          provider: target,
          state: "failed",
          pid: null,
          startedAt: null,
          stoppedAt: nowIso(),
          url: null,
          lastError: {
            ...stateError,
            message: redactedMessage,
          },
        });
        this.emitLog("error", "manager", `Provider switch failed (${previousProvider ?? "none"} -> ${target}): ${redactedMessage}`);
        throw error;
      }
    });
  }

  private redactForProviderConfig(provider: TunnelProvider, config: TunnelProviderConfig, message: string): string {
    try {
      const adapter = getTunnelProviderAdapter(provider);
      const command = adapter.buildCommand(config);
      return redactTunnelText(message, command.sensitiveValues);
    } catch {
      return message;
    }
  }

  private async runExclusive(operation: () => Promise<void>): Promise<void> {
    const next = this.operationChain.then(operation);
    this.operationChain = next.catch(() => undefined);
    return next;
  }

  private async startInternal(provider: TunnelProvider, config: TunnelProviderConfig): Promise<void> {
    const adapter = getTunnelProviderAdapter(provider);

    if (config.provider !== provider) {
      throw new Error(`invalid_config:provider mismatch (${config.provider} vs ${provider})`);
    }

    try {
      adapter.validateConfig(config);
    } catch (error) {
      const stateError = toStateError("invalid_config", error);
      this.updateStatus({
        provider,
        state: "failed",
        pid: null,
        startedAt: null,
        stoppedAt: nowIso(),
        url: null,
        lastError: stateError,
      });
      this.emitLog("error", "manager", `Configuration validation failed for ${provider}: ${stateError.message}`);
      throw error;
    }

    const command = adapter.buildCommand(config);

    this.updateStatus({
      provider,
      state: "starting",
      pid: null,
      startedAt: nowIso(),
      stoppedAt: null,
      url: null,
      lastError: null,
    });

    this.emitLog("info", "manager", `Starting ${provider} tunnel: ${command.redactedPreview}`);

    let supervised: ReturnType<typeof superviseSpawn>;
    try {
      supervised = superviseSpawn(command.command, command.args, {
        cwd: command.cwd,
        env: command.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        maxLifetimeMs: 24 * 60 * 60 * 1_000,
        spawnImpl: this.spawnImpl,
      });
    } catch (error) {
      const stateError = toStateError("start_failed", error);
      const redactedMessage = redactTunnelText(stateError.message, command.sensitiveValues);
      this.updateStatus({
        provider,
        state: "failed",
        pid: null,
        stoppedAt: nowIso(),
        url: null,
        lastError: { ...stateError, message: redactedMessage },
      });
      this.emitLog("error", "manager", `Spawn failure for ${provider}: ${redactedMessage}`);
      throw error;
    }
    const child = supervised.child;
    this.supervisedHandle = supervised;

    const managedHandle: ManagedTunnelProcess = {
      provider,
      child,
      command,
    };
    this.processHandle = managedHandle;
    this.adopted = false;
    this.expectedStop = false;

    this.updateStatus({ pid: child.pid ?? null });

    const stdoutBuffer = new LineBuffer();
    const stderrBuffer = new LineBuffer();

    const attachStream = (stream: Readable | null, source: TunnelOutputStream, buffer: LineBuffer) => {
      stream?.on("data", (chunk: Buffer | string) => {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        for (const line of buffer.push(text)) {
          this.handleOutputLine(source, line);
        }
      });
    };

    attachStream(child.stdout, "stdout", stdoutBuffer);
    attachStream(child.stderr, "stderr", stderrBuffer);

    child.once("error", (error) => {
      const maskedMessage = maskSensitive(normalizeError(error).message, managedHandle);
      this.emitLog("error", "manager", `Spawn failure for ${provider}: ${maskedMessage}`);
      this.handleUnexpectedExit(managedHandle, "start_failed", `Spawn failure: ${maskedMessage}`);
    });

    child.once("close", (code, signal) => {
      for (const line of stdoutBuffer.flush()) {
        this.handleOutputLine("stdout", line);
      }
      for (const line of stderrBuffer.flush()) {
        this.handleOutputLine("stderr", line);
      }

      if (this.processHandle !== managedHandle) {
        return;
      }

      const reason = signal ? `signal ${signal}` : `exit code ${code ?? 0}`;
      if (this.expectedStop) {
        this.emitLog("info", "manager", `Tunnel process stopped (${reason})`);
        this.finalizeStoppedState();
        return;
      }

      this.emitLog("error", "manager", `Tunnel process exited unexpectedly (${reason})`);
      this.handleUnexpectedExit(managedHandle, "process_exit", `Process exited unexpectedly (${reason})`);
    });

    this.readinessTimer = setTimeout(() => {
      if (this.status.state === "starting" && this.processHandle?.provider === provider) {
        this.emitLog("error", "manager", `Readiness timed out after ${command.readinessTimeoutMs}ms`);
        this.handleUnexpectedExit(managedHandle, "readiness_timeout", `Tunnel readiness timeout after ${command.readinessTimeoutMs}ms`);
        killManagedProcess(managedHandle.child, "SIGTERM");
      }
    }, command.readinessTimeoutMs);
    this.readinessTimer.unref?.();
  }

  private async stopInternal(): Promise<void> {
    if (!this.processHandle) {
      if (this.adopted) {
        // FNXC:RemoteAccess 2026-09-01-02:54: an adopted funnel has no child of ours; reset the
        // provider config so "stopped" in the UI means the public URL is actually dark.
        this.emitLog("info", "manager", "Stopping adopted tunnel (no owned child process) via provider reset");
        try {
          await this.killExternalFunnel();
        } catch (error) {
          this.emitLog("warn", "manager", `Adopted tunnel reset failed: ${normalizeError(error).message}`);
        }
        this.adopted = false;
      }
      this.updateStatus({
        provider: null,
        state: "stopped",
        pid: null,
        stoppedAt: nowIso(),
        url: null,
      });
      return;
    }

    if (this.activeStopPromise) {
      await this.activeStopPromise;
      return;
    }

    const currentHandle = this.processHandle;
    const stopTimeoutMs = currentHandle.command.stopTimeoutMs || this.defaultStopTimeoutMs;

    this.expectedStop = true;
    this.updateStatus({
      state: "stopping",
      provider: currentHandle.provider,
      pid: currentHandle.child.pid ?? null,
      lastError: null,
    });

    this.emitLog("info", "manager", `Stopping ${currentHandle.provider} tunnel (pid=${currentHandle.child.pid ?? "n/a"})`);

    this.activeStopPromise = new Promise<void>((resolve) => {
      const onClose = () => {
        currentHandle.child.removeListener("close", onClose);
        resolve();
      };

      currentHandle.child.once("close", onClose);
      killManagedProcess(currentHandle.child, "SIGTERM");

      this.stopTimer = setTimeout(() => {
        if (this.processHandle === currentHandle) {
          this.emitLog("warn", "manager", `Graceful stop timed out after ${stopTimeoutMs}ms, sending SIGKILL`);
          killManagedProcess(currentHandle.child, "SIGKILL");
        }
      }, stopTimeoutMs);
      this.stopTimer.unref?.();
    }).finally(() => {
      this.activeStopPromise = null;
      if (this.stopTimer) {
        clearTimeout(this.stopTimer);
        this.stopTimer = null;
      }
    });

    await this.activeStopPromise;
  }

  private handleOutputLine(source: TunnelOutputStream, rawLine: string): void {
    const processHandle = this.processHandle;
    const maskedLine = maskSensitive(rawLine, processHandle);
    this.emitLog("info", source, maskedLine);

    if (!processHandle || this.status.state !== "starting") {
      return;
    }

    const adapter = getTunnelProviderAdapter(processHandle.provider);
    const readiness = adapter.parseReadiness(maskedLine, source);
    if (!readiness?.ready) {
      return;
    }

    this.clearReadinessTimer();
    this.updateStatus({
      state: "running",
      provider: processHandle.provider,
      pid: processHandle.child.pid ?? null,
      url: readiness.url ?? this.status.url,
      startedAt: this.status.startedAt ?? nowIso(),
      lastError: null,
    });
    this.restartAttempt = 0;
    this.emitLog("info", "manager", `${processHandle.provider} tunnel is running`);
  }

  private handleUnexpectedExit(handle: ManagedTunnelProcess, code: TunnelErrorCode, message: string): void {
    if (this.processHandle !== handle) {
      return;
    }
    this.clearReadinessTimer();
    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }

    this.expectedStop = false;
    const provider = this.processHandle?.provider ?? this.status.provider;
    this.processHandle = null;
    this.supervisedHandle = null;

    this.updateStatus({
      provider,
      state: "failed",
      pid: null,
      stoppedAt: nowIso(),
      url: null,
      lastError: {
        code,
        message,
        at: nowIso(),
      },
    });
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (!this.autoRestart || !this.desiredTunnel || this.restartTimer) {
      return;
    }

    this.restartAttempt += 1;
    const delayMs = Math.min(
      this.restartBaseDelayMs * (2 ** Math.max(0, this.restartAttempt - 1)),
      this.restartMaxDelayMs,
    );
    const provider = this.desiredTunnel.provider;
    this.emitLog("warn", "manager", `Scheduling ${provider} tunnel restart in ${delayMs}ms (attempt ${this.restartAttempt})`);

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.runExclusive(async () => {
        const desired = this.desiredTunnel;
        if (!desired || this.processHandle) {
          return;
        }
        try {
          await this.startInternal(desired.provider, desired.config);
        } catch (error) {
          const message = this.redactForProviderConfig(
            desired.provider,
            desired.config,
            normalizeError(error).message,
          );
          this.emitLog("error", "manager", `Automatic ${desired.provider} tunnel restart failed: ${message}`);
          this.scheduleRestart();
        }
      }).catch((error: unknown) => {
        this.emitLog("error", "manager", `Automatic tunnel restart scheduling failed: ${normalizeError(error).message}`);
        this.scheduleRestart();
      });
    }, delayMs);
    this.restartTimer.unref?.();
  }

  private finalizeStoppedState(): void {
    this.clearReadinessTimer();
    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }

    this.expectedStop = false;
    this.processHandle = null;
    this.supervisedHandle = null;
    this.adopted = false;

    this.updateStatus({
      provider: null,
      state: "stopped",
      pid: null,
      stoppedAt: nowIso(),
      url: null,
      lastError: null,
    });
  }

  private clearReadinessTimer(): void {
    if (this.readinessTimer) {
      clearTimeout(this.readinessTimer);
      this.readinessTimer = null;
    }
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  private updateStatus(patch: Partial<TunnelStatusSnapshot>): void {
    this.status = {
      ...this.status,
      ...patch,
      lastError: patch.lastError === undefined ? this.status.lastError : patch.lastError,
    };

    const snapshot = this.getStatus();
    for (const listener of this.statusListeners) {
      listener(snapshot);
    }

    this.emit("status", snapshot);
  }

  private emitLog(level: TunnelLogLevel, source: TunnelLogEntry["source"], message: string): void {
    const safeMessage = maskSensitive(message, this.processHandle);
    const entry: TunnelLogEntry = {
      timestamp: nowIso(),
      provider: this.status.provider,
      level,
      source,
      message: safeMessage,
    };

    this.logs.push(entry);
    if (this.logs.length > this.maxLogEntries) {
      this.logs.splice(0, this.logs.length - this.maxLogEntries);
    }

    const logMethod = level === "error" ? "error" : level === "warn" ? "warn" : "log";
    remoteTunnelLog[logMethod](safeMessage);

    for (const listener of this.logListeners) {
      listener(entry);
    }

    this.emit("log", entry);
  }
}
