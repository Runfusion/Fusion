/**
 * Generic stage registry (KTD6).
 *
 * A single map takes each stage → `{ skillId, artifact location/glob,
 * presentation metadata }`. The orchestrator needs `skillId` +
 * `artifactLocation` to launch a stage and write its `complete` output (R10);
 * the dashboard needs `icon` + `label` (+ optional `artifactGlob`) to list and
 * render the launcher (R4). Adding a stage is a data entry in this map — no new
 * route, store, or screen code. "Which stages render richly vs. fall back to
 * chat" is measured by the U6 skill-interaction audit, not assumed here.
 */

export interface CeStageDefinition {
  /** Stage id (stable, kebab-case). */
  stageId: string;
  /**
   * Explicit pipeline ordinal. Pipeline progression (nextStageAfter) sorts by
   * THIS value, NOT by registry/Map insertion order — so a stage registered out
   * of order, or inserted mid-pipeline later, advances correctly. Lower runs
   * earlier; values need not be contiguous (gaps leave room to insert between).
   */
  order: number;
  /** Whether this launchable stage participates in automatic progression. Defaults to true. */
  participatesInPipeline?: boolean;
  /** Bundled skill the orchestrator loads for this stage. */
  skillId: string;
  /**
   * Conventional artifact location for this stage's `complete` output,
   * project-root-relative. When the path ends in `/` the orchestrator writes a
   * timestamped file inside that directory; otherwise it writes that exact file.
   */
  artifactLocation: string;
  /**
   * lucide-react icon name for the launcher tile (a string, resolved to a
   * component in the dashboard so the registry stays a pure-data module with no
   * React import). Must match an export of `lucide-react`.
   */
  icon: string;
  /** Human label for the launcher tile. */
  label: string;
  /**
   * Optional glob (project-root-relative) describing where this stage's
   * artifacts live for hub discovery. Defaults are derived from
   * `artifactLocation` when omitted.
   */
  artifactGlob?: string;
}

/**
 * The first registration slice. Locations mirror where the real ce-* skills
 * write today (STRATEGY.md, docs/ideation/, docs/plans/, docs/work/).
 * Icons are lucide-react export names.
 */
const STAGE_DEFINITIONS: CeStageDefinition[] = [
  {
    stageId: "strategy",
    order: 100,
    participatesInPipeline: false,
    skillId: "ce-strategy",
    artifactLocation: "STRATEGY.md",
    icon: "Compass",
    label: "Strategy",
    artifactGlob: "STRATEGY.md",
  },
  {
    stageId: "ideate",
    order: 200,
    participatesInPipeline: false,
    skillId: "ce-ideate",
    artifactLocation: "docs/ideation/",
    icon: "Lightbulb",
    label: "Ideate",
    artifactGlob: "docs/ideation/**/*.md",
  },
  {
    /*
     * FNXC:CompoundEngineering 2026-06-27-00:21:
     * Brainstorm and plan keep separate Fusion stage IDs and bundled skill IDs for session, pipeline, and board back-compat, but CE v3.15.0 aliases their durable artifact to one unified docs/plans plan. ce-brainstorm writes the requirements-only unified plan that ce-plan later enriches in place to implementation-ready.
     */
    stageId: "brainstorm",
    order: 300,
    skillId: "ce-brainstorm",
    artifactLocation: "docs/plans/",
    icon: "Sparkles",
    label: "Brainstorm",
    artifactGlob: "docs/plans/**/*.md",
  },
  {
    stageId: "plan",
    order: 400,
    skillId: "ce-plan",
    artifactLocation: "docs/plans/",
    icon: "ListChecks",
    label: "Plan",
    artifactGlob: "docs/plans/**/*.md",
  },
  {
    // The work stage (U7). Its `ce-work` skill drives execution and, on
    // `complete`, carries a derived task list that the orchestrator lands on the
    // board (tagged CE-originated + recorded as pipeline links). The artifact is
    // the work log / summary for this stage.
    stageId: "work",
    order: 500,
    skillId: "ce-work",
    artifactLocation: "docs/work/",
    icon: "Hammer",
    label: "Work",
    artifactGlob: "docs/work/**/*.md",
  },
  {
    /*
     * FNXC:CompoundEngineeringPipeline 2026-07-11-00:02:
     * The upstream ce-work skill already owns implementation, phase-boundary simplification, and code review. Compound is the next distinct durable stage, saving reusable learnings after delivery instead of ending the user journey at Work.
     */
    stageId: "compound",
    order: 600,
    skillId: "ce-compound",
    artifactLocation: "docs/solutions/",
    icon: "BookOpenCheck",
    label: "Compound",
    artifactGlob: "docs/solutions/**/*.md",
  },
  {
    /*
     * FNXC:CompoundEngineeringPipeline 2026-07-10-22:52:
     * Debug is manually launchable but does not participate in automatic Strategy -> Ideate -> Brainstorm -> Plan -> Work -> Compound progression. Compound is the terminal automatic stage.
     */
    stageId: "debug",
    order: 700,
    participatesInPipeline: false,
    skillId: "ce-debug",
    artifactLocation: "docs/debug/",
    icon: "Bug",
    label: "Debug",
    artifactGlob: "docs/debug/**/*.md",
  },
];

const REGISTRY = new Map<string, CeStageDefinition>(STAGE_DEFINITIONS.map((s) => [s.stageId, s]));

export function getStage(stageId: string): CeStageDefinition | undefined {
  return REGISTRY.get(stageId);
}

/**
 * All registered stages sorted by their explicit `order` ordinal (NOT Map
 * insertion order). Ties break by `stageId` for a stable, deterministic order.
 */
export function listStages(): CeStageDefinition[] {
  return [...REGISTRY.values()].sort((a, b) => a.order - b.order || a.stageId.localeCompare(b.stageId));
}

/** Automatic stages only; manual utility stages remain available through listStages/getStage. */
export function listPipelineStages(): CeStageDefinition[] {
  return listStages().filter((stage) => stage.participatesInPipeline !== false);
}

/**
 * Register an additional stage at runtime (used by tests to prove "adding a
 * stage requires only data"). Production stages live in STAGE_DEFINITIONS.
 */
export function registerStage(def: CeStageDefinition): void {
  REGISTRY.set(def.stageId, def);
}

/**
 * Remove a runtime-registered stage. Production stages from STAGE_DEFINITIONS are
 * protected (no-op) so tests can't accidentally drop a built-in stage. Used by
 * tests to keep the shared global registry clean across cases.
 */
export function unregisterStage(stageId: string): void {
  if (STAGE_DEFINITIONS.some((s) => s.stageId === stageId)) return;
  REGISTRY.delete(stageId);
}
