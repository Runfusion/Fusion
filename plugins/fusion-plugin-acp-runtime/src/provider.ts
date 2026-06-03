// ACP connection layer: spawn → ClientSideConnection → initialize handshake.
//
// U2 establishes the transport and completes the `initialize` handshake with
// integer protocol-version negotiation (KTD2) and a readiness timeout. Session
// driving (`session/new`, `session/prompt`, cancel, load) is U3 — this unit only
// exposes the live `conn` on the returned handle so later units can drive it.
//
// Security posture (KTD6): filesystem client capabilities are advertised ONLY
// when the caller's `advertiseFs` toggle is true — never hardcoded. Teardown is
// registry-SIGKILL-authoritative (KTD4a): `dispose()` force-kills the child via
// the process registry; that kill is the no-orphan guarantee, not a graceful
// round-trip.

import { Readable, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Agent,
  type Client,
  type ContentBlock,
  type RequestPermissionResponse,
  type StopReason,
} from "@agentclientprotocol/sdk";
import { spawnAgent, captureStderr, forceKill, unregisterProcess } from "./process-manager.js";
import { createEventBridge } from "./event-bridge.js";
import { resolvePermission } from "./control-handler.js";
import { boundIdentifier } from "./sanitize.js";
import type { AcpCallbacks, PermissionGate } from "./types.js";

/** Default bound for the `initialize` handshake. */
export const DEFAULT_INITIALIZE_TIMEOUT_MS = 30_000;

/** Thrown when the agent negotiates an integer protocol version we don't support. */
export class IncompatibleProtocolError extends Error {
  readonly code = "incompatible_protocol" as const;
  constructor(
    readonly agentProtocolVersion: number,
    readonly expected: number = PROTOCOL_VERSION,
  ) {
    super(
      `ACP agent negotiated incompatible protocol version ${agentProtocolVersion} (client supports ${expected})`,
    );
    this.name = "IncompatibleProtocolError";
  }
}

/** Thrown when the `initialize` handshake does not complete within the bound. */
export class HandshakeTimeoutError extends Error {
  readonly code = "handshake_timeout" as const;
  constructor(readonly timeoutMs: number) {
    super(`ACP initialize handshake timed out after ${timeoutMs}ms`);
    this.name = "HandshakeTimeoutError";
  }
}

/**
 * Minimal default client handler. Later units (U3/U4/U5/U7) supply the real one
 * that bridges `session/update` into Fusion callbacks and routes permission
 * requests through the action gate. The default cancels every permission request
 * (never auto-allows an untrusted agent) and ignores updates.
 */
export function createDefaultClientHandler(): Client {
  return {
    async sessionUpdate() {
      // no-op until the U4 event bridge is wired
    },
    async requestPermission() {
      return { outcome: { outcome: "cancelled" } };
    },
  };
}

/** A bridging client handler plus a drain control for its in-flight permissions. */
export interface BridgingClientHandler {
  /** The ACP `Client` impl handed to `ClientSideConnection`. */
  handler: Client;
  /**
   * Resolve every in-flight `requestPermission` with `{ cancelled }` and mark the
   * handler cancelled so any request arriving afterward is answered cancelled
   * immediately (U5 cancel-drain — KTD4a). Idempotent.
   */
  cancelPending(): void;
}

/**
 * The real client handler (U4 + U5): bridges every `session/update` notification
 * into the engine callbacks, AND answers `session/request_permission` through the
 * per-category action gate (U5 — the SECURITY FLOOR).
 *
 * Permission requests are routed to `resolvePermission`, which classifies each
 * call per-category against the live `gate` and selects `allow_once` only (never
 * `*_always`). When no `gate` is supplied the resolver default-denies.
 *
 * Cancel-drain (KTD4a / Risk: in-flight permission deadlock): every pending
 * `requestPermission` promise is tracked; `cancelPending()` resolves them all
 * with `{ cancelled }`. A request that arrives AFTER cancel is answered
 * `{ cancelled }` immediately so the agent never blocks on teardown.
 */
export function createBridgingClientHandler(
  callbacks: AcpCallbacks,
  gate?: PermissionGate,
): BridgingClientHandler {
  const bridge = createEventBridge(callbacks);

  const cancelledResponse: RequestPermissionResponse = {
    outcome: { outcome: "cancelled" },
  };

  let cancelled = false;
  // Each entry resolves its pending requestPermission with a cancelled outcome.
  const pending = new Set<(response: RequestPermissionResponse) => void>();

  function cancelPending(): void {
    cancelled = true;
    for (const resolveCancelled of [...pending]) {
      resolveCancelled(cancelledResponse);
    }
    pending.clear();
  }

  const handler: Client = {
    async sessionUpdate(params) {
      bridge.handleSessionUpdate(params.update);
    },
    async requestPermission(params): Promise<RequestPermissionResponse> {
      // A request arriving after cancel is answered cancelled immediately.
      if (cancelled) return cancelledResponse;

      // Race the real gate resolution against a cancel-drain so an in-flight
      // request is answered the moment teardown drains it (never deadlocks).
      return await new Promise<RequestPermissionResponse>((resolve) => {
        let settled = false;
        const finish = (response: RequestPermissionResponse) => {
          if (settled) return;
          settled = true;
          pending.delete(drain);
          resolve(response);
        };
        const drain = (response: RequestPermissionResponse) => finish(response);
        pending.add(drain);

        resolvePermission(params.toolCall, params.options, gate).then(
          (response) => finish(response),
          // resolvePermission never rejects, but stay safe: deny-by-cancel.
          () => finish(cancelledResponse),
        );
      });
    },
  };

  return { handler, cancelPending };
}

export interface AcpConnection {
  /** Live ACP connection — later units drive session/new, prompt, cancel, load. */
  conn: ClientSideConnection;
  child: ChildProcess;
  agentCapabilities?: unknown;
  /** Auth methods the agent advertised; non-empty means auth is required. */
  authMethods: Array<{ id: string }>;
  /** Current redacted stderr buffer. */
  stderr(): string;
  /** Force-kill the agent via the registry (KTD4a — SIGKILL is authoritative). */
  dispose(): void;
}

export interface ConnectOptions {
  binaryPath: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  clientHandler?: Client;
  /** Advertise fs capabilities ONLY where the toggle is true (KTD6). */
  advertiseFs: { read: boolean; write: boolean };
  initializeTimeoutMs?: number;
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Spawn the agent, establish a `ClientSideConnection` over its stdio, and
 * complete the `initialize` handshake under a timeout.
 *
 * Throws `HandshakeTimeoutError` on timeout, `IncompatibleProtocolError` when
 * the negotiated integer protocol version mismatches — in both cases the
 * subprocess is force-killed before throwing (no orphans, KTD4a). On `initialize`
 * the fs capability flags are gated by `advertiseFs` and never hardcoded (KTD6).
 */
export async function connect(opts: ConnectOptions): Promise<AcpConnection> {
  const timeoutMs = opts.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS;
  const child = spawnAgent({
    binaryPath: opts.binaryPath,
    args: opts.args,
    cwd: opts.cwd,
    env: opts.env,
  });
  const stderr = captureStderr(child);

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    forceKill(child);
    unregisterProcess(child);
  };

  // If the binary is missing, spawn emits "error" asynchronously. Surface that
  // as a rejection of the handshake rather than an unhandled event-loop error.
  let spawnError: Error | undefined;
  const spawnErrored = new Promise<never>((_resolve, reject) => {
    child.once("error", (err: Error) => {
      spawnError = err;
      reject(err);
    });
  });
  // Avoid an unhandled rejection if the handshake resolves/throws first.
  spawnErrored.catch(() => undefined);

  // output = the agent's stdin; input = the agent's stdout.
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin!) as unknown as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
  );

  const handler = opts.clientHandler ?? createDefaultClientHandler();
  const conn = new ClientSideConnection((_agent: Agent) => handler, stream);

  let initResult: Awaited<ReturnType<ClientSideConnection["initialize"]>>;
  try {
    initResult = await Promise.race([
      withTimeout(
        conn.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {
            fs: {
              readTextFile: opts.advertiseFs.read === true,
              writeTextFile: opts.advertiseFs.write === true,
            },
          },
        }),
        timeoutMs,
        () => new HandshakeTimeoutError(timeoutMs),
      ),
      spawnErrored,
    ]);
  } catch (err) {
    dispose();
    if (spawnError && err === spawnError) throw spawnError;
    throw err;
  }

  // Compare the negotiated integer protocol version; do NOT assume the agent
  // errors first (KTD2).
  if (initResult.protocolVersion !== PROTOCOL_VERSION) {
    dispose();
    throw new IncompatibleProtocolError(initResult.protocolVersion);
  }

  const authMethods = Array.isArray(initResult.authMethods)
    ? initResult.authMethods.map((m) => ({ id: m.id }))
    : [];

  return {
    conn,
    child,
    agentCapabilities: initResult.agentCapabilities,
    authMethods,
    stderr,
    dispose,
  };
}

// --- U3: session driving on top of connect() -------------------------------
//
// These helpers wrap the `ClientSideConnection` session methods so the runtime
// adapter drives one shape (open → prompt → cancel/resume) without touching SDK
// types directly. v1 always sends an empty `mcpServers` (KTD5).

/** Narrow view of the agent capabilities we read for resume routing. */
interface AgentCapabilitiesView {
  loadSession?: boolean;
}

function readsLoadSession(connection: AcpConnection): boolean {
  const caps = connection.agentCapabilities as AgentCapabilitiesView | undefined;
  return caps?.loadSession === true;
}

export interface NewAcpSessionResult {
  sessionId: string;
  /** Initial session mode state, when the agent reports one. */
  modes?: unknown;
}

/**
 * Open a fresh ACP session via `session/new`. Always passes an empty
 * `mcpServers` (KTD5 — Fusion custom-tool forwarding is deferred).
 */
export async function newAcpSession(
  connection: AcpConnection,
  opts: { cwd: string },
): Promise<NewAcpSessionResult> {
  const res = await connection.conn.newSession({ cwd: opts.cwd, mcpServers: [] });
  // `sessionId` is agent-supplied/untrusted (U6/Risk S7): bound its length and
  // strip path separators / NUL bytes before it is stored on the session or
  // could ever touch a resume-file path.
  return { sessionId: boundIdentifier(res.sessionId), modes: res.modes ?? undefined };
}

/**
 * Send a prompt turn via `session/prompt` and return the terminal `stopReason`.
 *
 * The SDK prompt promise resolves only AFTER every `session/update` for the turn
 * has been delivered to the client handler — so resolving here is the correct
 * "turn complete" signal (no extra draining required).
 */
export async function promptAcpSession(
  connection: AcpConnection,
  sessionId: string,
  blocks: ContentBlock[],
): Promise<StopReason> {
  const res = await connection.conn.prompt({ sessionId, prompt: blocks });
  return res.stopReason;
}

/**
 * Best-effort cancel of the active turn via the `session/cancel` notification.
 *
 * This is fire-and-forget (no ack in the protocol). Errors are swallowed — it
 * runs during teardown where the registry SIGKILL is the authoritative guarantee
 * (KTD4a).
 */
export async function cancelAcpSession(
  connection: AcpConnection,
  sessionId: string,
): Promise<void> {
  try {
    await connection.conn.cancel({ sessionId });
  } catch {
    // fire-and-forget; teardown's SIGKILL is authoritative
  }
}

/**
 * Resume a session. Prefers `session/load` (history replay) when the agent
 * advertised the `loadSession` capability; otherwise falls back to opening a
 * fresh `session/new`. There is no separate `resume` method in this SDK build —
 * `loadSession` IS the resume path.
 */
export async function loadAcpSession(
  connection: AcpConnection,
  opts: { sessionId: string; cwd: string },
): Promise<NewAcpSessionResult> {
  if (readsLoadSession(connection)) {
    // Bound the (agent-originated) resume id before it is used as a protocol /
    // potential path component (U6/Risk S7).
    const safeId = boundIdentifier(opts.sessionId);
    const res = await connection.conn.loadSession({
      sessionId: safeId,
      cwd: opts.cwd,
      mcpServers: [],
    });
    return { sessionId: safeId, modes: res.modes ?? undefined };
  }
  return newAcpSession(connection, { cwd: opts.cwd });
}
