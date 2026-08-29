// Async readiness probe + failure taxonomy for the ACP runtime.
//
// Mirrors the droid-runtime async-probe convention (KTD4): never block the
// event loop, never throw into it — always resolve a typed status. The probe
// spawns the agent, completes (or fails) the `initialize` handshake under a
// timeout, and maps the outcome onto a small failure taxonomy so the UI can
// distinguish "binary missing" from "handshake stalled" from "needs auth".

import {
  connect,
  HandshakeTimeoutError,
  IncompatibleProtocolError,
  DEFAULT_INITIALIZE_TIMEOUT_MS,
} from "./provider.js";

export type AcpProbeReason =
  | "ok"
  | "missing_binary"
  | "spawn_error"
  | "handshake_timeout"
  | "incompatible_protocol"
  | "unauthenticated";

export interface AcpProbeStatus {
  ok: boolean;
  reason: AcpProbeReason;
  detail?: string;
  protocolVersion?: number;
  authRequired?: boolean;
}

export interface ProbeOptions {
  binaryPath: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

function isMissingBinary(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT";
}

/**
 * Probe whether the configured ACP agent is present and completes the handshake.
 *
 * Never rejects — resolves an `AcpProbeStatus`. Always tears the spawned process
 * down afterward (success or failure). Mapping:
 * - ENOENT spawn error           → `missing_binary`
 * - other spawn error            → `spawn_error`
 * - handshake timeout            → `handshake_timeout`
 * - mismatched protocol version  → `incompatible_protocol`
 * - non-empty authMethods        → `ok` with `authRequired: true`
 */
export async function probeAcpReadiness(opts: ProbeOptions): Promise<AcpProbeStatus> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS;
  let connection: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    connection = await connect({
      binaryPath: opts.binaryPath,
      args: opts.args,
      cwd: opts.cwd,
      env: opts.env,
      // Probe with fs capabilities OFF — readiness must not advertise anything
      // the real session might not (KTD6).
      advertiseFs: { read: false, write: false },
      initializeTimeoutMs: timeoutMs,
    });

    const authRequired = connection.authMethods.length > 0;
    return {
      ok: true,
      reason: "ok",
      authRequired,
    };
  } catch (err) {
    if (err instanceof HandshakeTimeoutError) {
      return { ok: false, reason: "handshake_timeout", detail: err.message };
    }
    if (err instanceof IncompatibleProtocolError) {
      return {
        ok: false,
        reason: "incompatible_protocol",
        detail: err.message,
        protocolVersion: err.agentProtocolVersion,
      };
    }
    if (isMissingBinary(err)) {
      return {
        ok: false,
        reason: "missing_binary",
        detail: `ACP agent binary not found: ${opts.binaryPath}`,
      };
    }
    return {
      ok: false,
      reason: "spawn_error",
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    connection?.dispose();
  }
}
