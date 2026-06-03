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
 * write today (STRATEGY.md, docs/ideation/, docs/brainstorms/, docs/plans/).
 * Icons are lucide-react export names.
 */
const STAGE_DEFINITIONS: CeStageDefinition[] = [
  {
    stageId: "strategy",
    skillId: "ce-strategy",
    artifactLocation: "STRATEGY.md",
    icon: "Compass",
    label: "Strategy",
    artifactGlob: "STRATEGY.md",
  },
  {
    stageId: "ideate",
    skillId: "ce-ideate",
    artifactLocation: "docs/ideation/",
    icon: "Lightbulb",
    label: "Ideate",
    artifactGlob: "docs/ideation/**/*.md",
  },
  {
    stageId: "brainstorm",
    skillId: "ce-brainstorm",
    artifactLocation: "docs/brainstorms/",
    icon: "Sparkles",
    label: "Brainstorm",
    artifactGlob: "docs/brainstorms/**/*.md",
  },
  {
    stageId: "plan",
    skillId: "ce-plan",
    artifactLocation: "docs/plans/",
    icon: "ListChecks",
    label: "Plan",
    artifactGlob: "docs/plans/**/*.md",
  },
];

const REGISTRY = new Map<string, CeStageDefinition>(STAGE_DEFINITIONS.map((s) => [s.stageId, s]));

export function getStage(stageId: string): CeStageDefinition | undefined {
  return REGISTRY.get(stageId);
}

export function listStages(): CeStageDefinition[] {
  return [...REGISTRY.values()];
}

/**
 * Register an additional stage at runtime (used by tests to prove "adding a
 * stage requires only data"). Production stages live in STAGE_DEFINITIONS.
 */
export function registerStage(def: CeStageDefinition): void {
  REGISTRY.set(def.stageId, def);
}
