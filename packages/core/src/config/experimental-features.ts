import type { Settings } from "../types.js";

const LEGACY_EXPERIMENTAL_FEATURE_ALIASES: Record<string, string> = {
  devServer: "devServerView",
};

/*
FNXC:WorkflowSettings 2026-06-22-18:00:
workflowGraphExecutor and workflowColumns graduated from Experimental. Runtime graph execution and workflow-defined columns are always on; stale persisted values are ignored by runtime helpers instead of acting as kill switches.

FNXC:WorkflowSettings 2026-06-23-21:55:
workflowInterpreterDualObserve is no longer user-controllable in Settings. Treat stale persisted true values as inert so upgraded users do not keep running hidden diagnostic shadow observation with no visible off switch.
*/
/*
FNXC:WorkflowPostMerge 2026-06-26-14:00:
U7b/U7c cutover — `graphNativePostMerge` is DEFAULT-ON and the graph is the SOLE owner of
post-merge execution: a successful merge lets traversal continue to post-merge graph nodes
(optional-group nodes wired off a merge-region success, plus the plain post-merge nodes that
follow a `seam:"merge"` prompt node — e.g. compound-engineering's `document` step). U7c
DELETED the legacy merger post-merge execution path entirely (`runPostMergeWorkflowSteps` /
`hasEnabledPostMergeWorkflowSteps` and the worktree/prompt/script helpers are gone), so there
is no legacy fallback: post-merge work runs exactly once via the graph. The flag still gates
the graph's post-merge nodes (workflow-graph-executor.ts) but no longer toggles a merger path.
*/
const DEFAULT_ON_EXPERIMENTAL_FEATURES = new Set<string>(["graphNativePostMerge"]);
const RETIRED_EXPERIMENTAL_FEATURES = new Set<string>([
  "workflowInterpreterDualObserve",
]);

/*
FNXC:WorkflowPostMerge 2026-06-26-15:30:
Post-merge workflow steps run GRAPH-NATIVE behind this DEFAULT-ON experimental flag
(see DEFAULT_ON_EXPERIMENTAL_FEATURES above). With the flag ON (the default — present in
DEFAULT_ON_EXPERIMENTAL_FEATURES so `isExperimentalFeatureEnabled` returns true unless an
explicit `false` opts out), the graph executor lets traversal continue past a SUCCESSFUL
merge to any post-merge optional-group node reachable from the merge region, running it via
the same optional-group execution+recording path (phase:"post-merge", non-blocking
failures). The graph is the SOLE owner of post-merge execution: U7c deleted the legacy
merger post-merge path entirely, so there is no legacy-table fallback — post-merge work runs
exactly once via the graph. An explicit `graphNativePostMerge: false` opts out and leaves the
merge-region collapsed (merge-attempt success routes straight to `end`). Mirrors the
WORKFLOW_INTERPRETER_DUAL_OBSERVE_FLAG read plumbing (named constant +
`isExperimentalFeatureEnabled`).
*/
export const GRAPH_NATIVE_POST_MERGE_FLAG = "graphNativePostMerge" as const;

export function isExperimentalFeatureEnabled(
  settings: Pick<Settings, "experimentalFeatures"> | undefined,
  key: string,
): boolean {
  const features = settings?.experimentalFeatures;
  const canonicalKey = LEGACY_EXPERIMENTAL_FEATURE_ALIASES[key] ?? key;
  if (RETIRED_EXPERIMENTAL_FEATURES.has(canonicalKey)) return false;
  if (features?.[canonicalKey] === false) return false;
  if (features?.[canonicalKey] === true) return true;

  for (const [legacyKey, aliasCanonical] of Object.entries(LEGACY_EXPERIMENTAL_FEATURE_ALIASES)) {
    if (aliasCanonical === canonicalKey && features?.[legacyKey] === true) {
      return true;
    }
  }

  if (DEFAULT_ON_EXPERIMENTAL_FEATURES.has(canonicalKey)) return true;

  return false;
}
