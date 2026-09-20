/*
 * Runtime-readable declaration shared by the Node watchdog wrapper and the TypeScript scenario
 * table. Keep this data-only so the wrapper never loads the production engine to validate evidence.
 */
export const PIPELINE_SCENARIO_MANIFEST = [
  ["S01", ["builtin:coding-ideas", "builtin:coding-ideas-v2"]],
  ["S02", ["builtin:coding"]],
  ["S03", ["builtin:coding-ideas"]],
  ["S04", ["builtin:coding"], ["revise-twice"]],
  ["S05", ["builtin:coding-ideas", "builtin:coding-ideas-v2", "builtin:coding"], ["revise-twice"]],
  ["S06", ["builtin:coding"]],
  ["S07", ["builtin:coding-ideas", "builtin:coding-ideas-v2"]],
  ["S08", ["builtin:coding"]],
  ["S09", ["builtin:coding"]],
  ["S10", ["builtin:coding"]],
  ["S11", ["builtin:coding-ideas"], ["absent", "vanished-mid-step"]],
  ["S12", ["builtin:coding"]],
  ["S13", ["builtin:coding-ideas"]],
  ["S14", ["builtin:coding-ideas"]],
  ["S15", ["builtin:coding-ideas"]],
  ["S16", ["builtin:coding"]],
  ["S17", ["builtin:coding-ideas", "builtin:coding-ideas-v2", "builtin:coding"], ["planning", "execution", "review", "merge-in-flight", "post-merge"]],
  ["S18", ["builtin:coding-ideas"]],
  ["S19", ["builtin:coding-ideas", "builtin:coding"]],
  ["S20", ["builtin:coding"]],
  ["S21", ["builtin:coding"], undefined],
].map(([id, workflows, variants]) => ({ id, workflows, ...(variants ? { variants } : {}) }));

export function expectedPipelineInvocations() {
  return PIPELINE_SCENARIO_MANIFEST.flatMap(({ id, workflows, variants }) =>
    workflows.flatMap((workflowId) => (variants ?? [undefined]).map((variant) => ({ id, workflowId, ...(variant ? { variant } : {}) }))),
  );
}
