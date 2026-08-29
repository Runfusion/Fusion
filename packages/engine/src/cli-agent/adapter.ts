/**
 * CliAgentAdapter interface and registry (CLI Agent Executor, U2).
 *
 * An adapter teaches the engine how to drive one CLI coding agent (Claude Code,
 * Codex, Droid, Pi, or a generic PTY fallback) inside an engine-owned PTY. The
 * adapter is pure policy — it declares *how* to launch, *how* to recognize
 * readiness, *how* to format an injected prompt, *how* to resume — while the
 * CliSessionManager owns the actual node-pty process lifecycle.
 *
 * Design notes (KTD):
 * - Engine-owned abstraction, NOT an AgentRuntime plugin: the runtime contract
 *   is API-shaped and cannot model a PTY stream / co-driving / resume.
 * - Adapters declare honest capability flags so surfaces can render tier
 *   differences (a generic adapter with everything disabled behaves like the
 *   heuristic tier).
 * - The env builder follows the ACP hardening convention: NEVER inherit
 *   `process.env` wholesale; copy only an explicit allowlist.
 */

import type { CliAutonomyPosture } from "@fusion/core";

// ── Capability flags ──────────────────────────────────────────────────────

/** Where an adapter sources a structured transcript, if at all. */
export type TranscriptSource =
  /** Native hook events (e.g. Claude Code Stop/Notification payloads). */
  | "hooks"
  /** A JSONL transcript / rollout file tailed from disk. */
  | "jsonl"
  /** A per-session JSONL file tailed from disk for both telemetry + transcript (Pi). */
  | "session-jsonl"
  /** A native machine-readable event stream (e.g. `--mode json`). */
  | "event-stream"
  /** No structured transcript — raw terminal only (generic tier). */
  | "none";

/**
 * Honest, per-adapter declaration of which signals it detects natively. The UI
 * and pipeline read these to decide how much to trust the adapter (native done
 * advances the pipeline; absent native done falls back to a confirm-to-advance
 * affordance).
 */
export interface CliAdapterCapabilities {
  /** Adapter emits a positive, native "turn complete / done" signal. */
  nativeDone: boolean;
  /** Adapter emits a native waiting-on-input (permission / question) signal. */
  nativeWaiting: boolean;
  /** Where the structured transcript comes from. */
  transcriptSource: TranscriptSource;
  /** Adapter can resume a previous native session by id. */
  supportsResume: boolean;
}

// ── Launch + env builders ─────────────────────────────────────────────────

/** Operator/adapter launch settings resolved before spawn. */
export interface CliAdapterLaunchSettings {
  /**
   * Override for the binary to invoke. When absent the adapter's default
   * command is used.
   */
  command?: string;
  /** Extra args appended after the adapter's computed base args. */
  extraArgs?: readonly string[];
  /**
   * Adapter-specific free-form settings (model name, profile, etc.). Kept open
   * so adapters evolve without changing this interface.
   */
  [key: string]: unknown;
}

/** A fully resolved launch invocation produced by an adapter. */
export interface CliLaunchSpec {
  /** Executable to spawn. */
  command: string;
  /** Argument vector. */
  args: string[];
}

/**
 * Context handed to adapter builder hooks. The autonomy posture lets an adapter
 * append privileged flags (e.g. `--dangerously-skip-permissions`) only when the
 * posture explicitly permits it — the visible-posture contract (origin R21).
 */
export interface CliAdapterLaunchContext {
  settings: CliAdapterLaunchSettings;
  posture: CliAutonomyPosture | null;
}

/** Context for building a resume invocation. */
export interface CliAdapterResumeContext extends CliAdapterLaunchContext {
  /** The native session id captured from the prior run. */
  nativeSessionId: string;
}

// ── Readiness + injection ─────────────────────────────────────────────────

/**
 * Stateful readiness detector. The session manager feeds it ANSI-bearing output
 * chunks (as text) until it returns true once; readiness gates the first
 * injection. Implementations should be tolerant of partial chunks.
 */
export interface CliReadinessDetector {
  /**
   * Observe an output chunk. Returns true once the child is ready to receive a
   * prompt. May be called repeatedly; once it has returned true the manager
   * stops calling it.
   */
  observe(chunk: string): boolean;
}

/** Outcome of formatting an injection for the wire. */
export interface CliInjectionFormat {
  /** The exact bytes to write to the PTY. */
  payload: string;
}

/**
 * Telemetry wiring hook. Called once at spawn so an adapter can register log
 * tailers / hook endpoints with whatever telemetry sink the engine provides
 * (the concrete hub lands in U3). The returned disposer is invoked at teardown.
 *
 * U2 keeps this intentionally minimal — adapters in U4/U5 flesh out the wiring.
 */
export type CliTelemetryWiring = (ctx: {
  sessionId: string;
  worktreePath: string | null;
}) => (() => void) | void;

// ── The adapter interface ─────────────────────────────────────────────────

/**
 * Per-adapter declaration of the argument markers that signify *elevated*
 * (bypass-permissions / full-auto) autonomy (CLI Agent Executor, U15). The
 * autonomy elevation detector scans the FULLY RESOLVED argv for these so an
 * elevation smuggled through extra-args (not the autonomy field) is still
 * caught. Generic env-pattern detection is shared across all adapters and lives
 * in `autonomy.ts`; this only declares the adapter-specific argv side.
 */
export interface CliAdapterElevationMarkers {
  /**
   * Exact-match argv tokens that always denote elevation (e.g.
   * `--dangerously-skip-permissions`).
   */
  readonly exactArgs?: readonly string[];
  /**
   * Regexes tested against each resolved argv token (e.g. Codex's
   * `-c approval_policy=...` override, droid `--auto high`). A match denotes
   * elevation. Authors keep these conservative — false positives gate launches.
   */
  readonly argPatterns?: readonly RegExp[];
  /**
   * Optional predicate over the whole resolved argv for multi-token markers
   * (e.g. `--auto` followed by `high`). Returns the matched token(s) to report.
   */
  readonly matchArgv?: (argv: readonly string[]) => string[];
}

export interface CliAgentAdapter {
  /** Stable identifier (e.g. "claude-code", "codex", "generic"). */
  readonly id: string;
  /** Human-readable name for UI surfaces. */
  readonly name: string;
  /** Capability flags — read honestly by the pipeline and UI. */
  readonly capabilities: CliAdapterCapabilities;
  /**
   * Default binary the adapter invokes when no command override is set (U15).
   * Surfaced so the elevation detector can treat a *different* command override
   * as privileged without reaching into the adapter's private constants.
   */
  readonly defaultCommand?: string;
  /**
   * Adapter-specific elevated-autonomy argv markers (U15). When omitted the
   * detector relies on the shared generic env-pattern set only.
   */
  readonly elevationMarkers?: CliAdapterElevationMarkers;

  /** Build the launch command/args from settings + autonomy posture. */
  buildLaunch(ctx: CliAdapterLaunchContext): CliLaunchSpec;

  /**
   * Build the spawn env allowlist: the list of `process.env` keys this adapter
   * is permitted to forward to the child. NEVER an inherit-everything posture.
   * The session manager copies ONLY these keys.
   */
  buildEnvAllowlist(ctx: CliAdapterLaunchContext): string[];

  /** Create a fresh readiness detector for a new session. */
  createReadinessDetector(): CliReadinessDetector;

  /**
   * Format an injected (engine- or composer-composed) prompt for the wire.
   *
   * @param text The raw text to inject.
   * @param opts.bracketedPasteActive Whether the child has negotiated bracketed
   *   paste (`\x1b[?2004h` observed and not since disabled). The session manager
   *   passes the live value; security-critical neutralization of the raw path is
   *   handled by the manager, not here — this hook only decides paste-wrapping
   *   and trailing-submit semantics.
   */
  formatInjection(text: string, opts: { bracketedPasteActive: boolean }): CliInjectionFormat;

  /** Build the resume invocation for a captured native session id. */
  buildResume?(ctx: CliAdapterResumeContext): CliLaunchSpec;

  /** Optional telemetry wiring, invoked once at spawn. */
  wireTelemetry?: CliTelemetryWiring;
}

// ── Registry ───────────────────────────────────────────────────────────────

/**
 * Error thrown when an adapter id is requested but not registered.
 */
export class UnknownCliAdapterError extends Error {
  readonly code = "UNKNOWN_CLI_ADAPTER";
  constructor(public readonly adapterId: string) {
    super(`No CLI agent adapter registered for id: ${adapterId}`);
    this.name = "UnknownCliAdapterError";
  }
}

/**
 * Error thrown when registering an adapter whose id is already taken.
 */
export class DuplicateCliAdapterError extends Error {
  readonly code = "DUPLICATE_CLI_ADAPTER";
  constructor(public readonly adapterId: string) {
    super(`A CLI agent adapter is already registered for id: ${adapterId}`);
    this.name = "DuplicateCliAdapterError";
  }
}

/**
 * In-memory registry mapping adapter id → adapter. The bundled adapters (U4/U5/
 * U6) register themselves into the default registry; tests construct isolated
 * registries.
 */
export class CliAdapterRegistry {
  private readonly adapters = new Map<string, CliAgentAdapter>();

  /** Register an adapter. Throws on duplicate id. */
  register(adapter: CliAgentAdapter): void {
    if (this.adapters.has(adapter.id)) {
      throw new DuplicateCliAdapterError(adapter.id);
    }
    this.adapters.set(adapter.id, adapter);
  }

  /** Get an adapter by id. Throws UnknownCliAdapterError if absent. */
  get(id: string): CliAgentAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) {
      throw new UnknownCliAdapterError(id);
    }
    return adapter;
  }

  /** Look up an adapter by id without throwing. */
  tryGet(id: string): CliAgentAdapter | undefined {
    return this.adapters.get(id);
  }

  /** Whether an adapter id is registered. */
  has(id: string): boolean {
    return this.adapters.has(id);
  }

  /** All registered adapter ids. */
  ids(): string[] {
    return [...this.adapters.keys()];
  }

  /** All registered adapters. */
  all(): CliAgentAdapter[] {
    return [...this.adapters.values()];
  }
}

/** The default process-wide registry the bundled adapters register into. */
export const defaultCliAdapterRegistry = new CliAdapterRegistry();
