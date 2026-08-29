/**
 * CLI-agent autonomy posture resolution + elevation approval gate (U15).
 *
 * The autonomy approval gate's central invariant: **elevation expressed through
 * ANY channel must be caught.** Operators can request bypass-permissions-style
 * autonomy through four distinct settings channels:
 *
 *   1. the autonomy field        (`nodeConfig.cliAutonomy.autoApprove`, or the
 *                                  settings `autonomyMode: "elevated"`),
 *   2. extra args                (`--dangerously-skip-permissions` smuggled in),
 *   3. env additions             (`*_DANGEROUS*` / `*_SKIP_PERMISSIONS*` vars),
 *   4. a command override        (pointing the binary at an arbitrary path).
 *
 * A posture chip derived from the autonomy *field alone* would be false-safe
 * when elevation rides one of the other channels. So `resolveEffectivePosture`
 * derives the posture from the **fully resolved argv + env** — it asks the
 * adapter to build the actual launch invocation (which already folds in the
 * posture flags, extra args, and command override), then scans that argv plus
 * the env additions against the adapter's declared elevation markers and a
 * shared generic env-pattern set. A non-default command override is itself
 * privileged.
 *
 * Any resolved elevation requires a stored per-project approval (mirroring the
 * raw workflow-CLI-command approval precedent). `assertAutonomyApproved` throws
 * a typed `CliAutonomyNotApprovedError` when elevation is present but no
 * approval is recorded for the project — the caller surfaces this as a launch
 * failure, never a stall.
 *
 * Pure engine policy: no HTTP, no DB. The approval lookup is injected as a
 * small async predicate so the dashboard can back it with the project store.
 */

import type { CliAutonomyPosture } from "@fusion/core";
import type {
  CliAgentAdapter,
  CliAdapterLaunchSettings,
} from "./adapter.js";

// ── Adapter capability tiers (U15 node-editor labels) ───────────────────────

/** UI tier label derived honestly from an adapter's capability flags. */
export type CliAdapterTier = "native" | "hybrid" | "generic";

/**
 * Derive the tier label the node editor renders (native / hybrid / generic) from
 * an adapter's honest capability flags:
 *  - native: a native done signal AND a structured transcript (hooks/jsonl/…).
 *  - hybrid: SOME native signal (done or waiting) but a weaker transcript story.
 *  - generic: no native signals at all (the heuristic tier).
 */
export function tierForCapabilities(caps: {
  nativeDone: boolean;
  nativeWaiting: boolean;
  transcriptSource: string;
}): CliAdapterTier {
  if (caps.nativeDone && caps.transcriptSource !== "none") return "native";
  if (caps.nativeDone || caps.nativeWaiting) return "hybrid";
  return "generic";
}

// ── Settings shape (mirrors @fusion/core CliAgentSettings) ──────────────────

/** Per-adapter operator launch settings consumed by posture resolution. */
export interface CliAgentResolveSettings {
  commandOverride?: string;
  extraArgs?: readonly string[];
  autonomyMode?: "default" | "elevated";
  envAdditions?: readonly string[];
}

/** The cli-agent slice of a workflow node's config relevant to posture. */
export interface CliAgentNodeConfig {
  cliAutonomy?: CliAutonomyPosture | null;
}

// ── Effective posture ───────────────────────────────────────────────────────

/** A single resolved elevation marker, for chip rendering + audit. */
export interface CliElevationFlag {
  /** Which settings channel surfaced the elevation. */
  channel: "autonomy" | "args" | "env" | "command";
  /** The concrete marker (argv token, env var name, or command path). */
  marker: string;
}

/**
 * The effective autonomy posture for a launch, derived from the resolved argv +
 * env (NOT the autonomy field alone). This is what the posture chip renders and
 * what is denormalized onto the session record at spawn.
 */
export interface EffectivePosture {
  /** Adapter the posture was resolved against. */
  adapterId: string;
  /** Coarse mode: `elevated` iff any elevation marker was detected. */
  mode: "default" | "elevated";
  /** Whether the resolved invocation is elevated through any channel. */
  elevated: boolean;
  /** Every detected elevation marker (across all channels). */
  flags: CliElevationFlag[];
}

// ── Generic env-pattern detection (shared across all adapters) ──────────────

/**
 * Env-var name patterns that toggle autonomy/permission bypass for SOME CLI.
 * Applied to every adapter's env additions regardless of adapter-declared
 * markers — a bypass-toggling env var is elevation no matter which CLI reads it.
 */
export const GENERIC_ELEVATION_ENV_PATTERNS: readonly RegExp[] = Object.freeze([
  /_DANGEROUS/i,
  /DANGEROUS_/i,
  /SKIP_PERMISSIONS?/i,
  /BYPASS_(APPROVALS?|PERMISSIONS?|SANDBOX)/i,
  /AUTO_APPROVE/i,
  /YOLO/i,
  /FULL_AUTO/i,
]);

function envIsElevating(name: string): boolean {
  return GENERIC_ELEVATION_ENV_PATTERNS.some((re) => re.test(name));
}

// ── Posture resolution ──────────────────────────────────────────────────────

export interface ResolveEffectivePostureArgs {
  /** The adapter the session will be driven by. */
  adapter: CliAgentAdapter;
  /** Per-adapter operator settings (from GlobalSettings.cliAgents). */
  settings?: CliAgentResolveSettings | null;
  /** The cli-agent node config (carries the autonomy field). */
  nodeConfig?: CliAgentNodeConfig | null;
}

/**
 * Build the adapter launch settings the manager would use, folding the operator
 * settings + the autonomy field into the shape `buildLaunch` consumes. Keeping
 * this here (not in the manager) lets posture resolution scan the EXACT argv the
 * child would receive without spawning.
 */
function buildLaunchSettings(
  settings: CliAgentResolveSettings | null | undefined,
): CliAdapterLaunchSettings {
  const out: CliAdapterLaunchSettings = {};
  if (settings?.commandOverride) out.command = settings.commandOverride;
  if (settings?.extraArgs && settings.extraArgs.length > 0) {
    out.extraArgs = [...settings.extraArgs];
  }
  return out;
}

/**
 * Map the resolved autonomy intent onto the posture the adapter's `buildLaunch`
 * keys off (it reads `posture.autoApprove`). Elevation intent comes from EITHER
 * the node autonomy field OR `autonomyMode: "elevated"`.
 */
function resolveIntentPosture(
  settings: CliAgentResolveSettings | null | undefined,
  nodeConfig: CliAgentNodeConfig | null | undefined,
): { posture: CliAutonomyPosture | null; fromField: boolean } {
  const fieldAutoApprove = nodeConfig?.cliAutonomy?.autoApprove === true;
  const modeElevated = settings?.autonomyMode === "elevated";
  const autoApprove = fieldAutoApprove || modeElevated;
  const base = nodeConfig?.cliAutonomy ?? null;
  if (!autoApprove) {
    return { posture: base, fromField: false };
  }
  return { posture: { ...(base ?? {}), autoApprove: true }, fromField: true };
}

/** Whether a token matches the adapter's declared argv elevation markers. */
function argvElevationHits(
  adapter: CliAgentAdapter,
  argv: readonly string[],
): string[] {
  const markers = adapter.elevationMarkers;
  if (!markers) return [];
  const hits = new Set<string>();
  const exact = new Set(markers.exactArgs ?? []);
  for (const tok of argv) {
    if (exact.has(tok)) hits.add(tok);
    for (const re of markers.argPatterns ?? []) {
      if (re.test(tok)) {
        hits.add(tok);
        break;
      }
    }
  }
  for (const m of markers.matchArgv?.(argv) ?? []) hits.add(m);
  return [...hits];
}

/**
 * Resolve the effective autonomy posture from the fully resolved argv + env.
 * Pure; never throws. The gate decision is made by `assertAutonomyApproved`.
 */
export function resolveEffectivePosture(
  args: ResolveEffectivePostureArgs,
): EffectivePosture {
  const { adapter } = args;
  const settings = args.settings ?? null;
  const nodeConfig = args.nodeConfig ?? null;

  const { posture } = resolveIntentPosture(settings, nodeConfig);
  const launchSettings = buildLaunchSettings(settings);

  // Build the EXACT argv the child would receive (folds posture flags + extra
  // args + command override). A buildLaunch failure (e.g. generic with no
  // command) degrades to scanning the operator-supplied channels directly.
  let resolvedArgv: string[] = [];
  let resolvedCommand: string | undefined;
  try {
    const spec = adapter.buildLaunch({ settings: launchSettings, posture });
    resolvedArgv = spec.args;
    resolvedCommand = spec.command;
  } catch {
    resolvedArgv = [...(settings?.extraArgs ?? [])];
    resolvedCommand = settings?.commandOverride;
  }

  const flags: CliElevationFlag[] = [];

  // Channel: argv (covers the autonomy field AND extra args — both land in argv).
  for (const marker of argvElevationHits(adapter, resolvedArgv)) {
    flags.push({ channel: "args", marker });
  }

  // Channel: command override to a non-default path is privileged.
  if (
    typeof resolvedCommand === "string" &&
    settings?.commandOverride &&
    typeof adapter.defaultCommand === "string" &&
    resolvedCommand !== adapter.defaultCommand
  ) {
    flags.push({ channel: "command", marker: resolvedCommand });
  }

  // Channel: env additions that toggle autonomy/bypass.
  for (const name of settings?.envAdditions ?? []) {
    if (envIsElevating(name)) flags.push({ channel: "env", marker: name });
  }

  // If elevation was requested ONLY via the field but the adapter emitted no
  // recognizable argv marker (e.g. an adapter that elevates with no flag), still
  // record the intent so the gate is never bypassed by an unmarked adapter.
  const intentElevated =
    nodeConfig?.cliAutonomy?.autoApprove === true ||
    settings?.autonomyMode === "elevated";
  if (intentElevated && flags.length === 0) {
    flags.push({ channel: "autonomy", marker: "autoApprove" });
  }

  const elevated = flags.length > 0;
  return {
    adapterId: adapter.id,
    mode: elevated ? "elevated" : "default",
    elevated,
    flags,
  };
}

// ── Approval gate ────────────────────────────────────────────────────────────

/** Typed launch error: elevation requested without a stored project approval. */
export class CliAutonomyNotApprovedError extends Error {
  readonly code = "CLI_AUTONOMY_NOT_APPROVED";
  constructor(
    public readonly adapterId: string,
    public readonly projectId: string,
    public readonly flags: CliElevationFlag[],
  ) {
    const markers = flags.map((f) => `${f.channel}:${f.marker}`).join(", ");
    super(
      `Elevated CLI autonomy for adapter "${adapterId}" requires approval for ` +
        `project "${projectId}" before launch (unapproved elevation: ${markers})`,
    );
    this.name = "CliAutonomyNotApprovedError";
  }
}

/** Predicate the dashboard backs with the project store's approval list. */
export type AutonomyApprovalLookup = (args: {
  projectId: string;
  adapterId: string;
}) => boolean | Promise<boolean>;

export interface AssertAutonomyApprovedArgs extends ResolveEffectivePostureArgs {
  /** Project the launch belongs to (approvals are per-project). */
  projectId: string;
  /** Whether the project has approved elevated autonomy for this adapter. */
  isApproved: AutonomyApprovalLookup;
}

/**
 * Resolve the effective posture and enforce the approval gate. Returns the
 * resolved posture (to denormalize onto the session record) when the launch is
 * permitted. Throws `CliAutonomyNotApprovedError` when the resolved posture is
 * elevated and no per-project approval is recorded.
 */
export async function assertAutonomyApproved(
  args: AssertAutonomyApprovedArgs,
): Promise<EffectivePosture> {
  const posture = resolveEffectivePosture(args);
  if (!posture.elevated) return posture;
  const approved = await args.isApproved({
    projectId: args.projectId,
    adapterId: args.adapter.id,
  });
  if (!approved) {
    throw new CliAutonomyNotApprovedError(
      args.adapter.id,
      args.projectId,
      posture.flags,
    );
  }
  return posture;
}
