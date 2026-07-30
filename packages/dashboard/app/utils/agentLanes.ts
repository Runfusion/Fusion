/*
FNXC:WorkflowLifecycleColumns 2026-07-30-18:40 (U11 census hygiene — dashboard):

`"triage"` NAMES TWO UNRELATED THINGS in this codebase: a board COLUMN and an AGENT
LANE. The lifecycle-column census matches the word, so the lane comparisons show up
on the work list alongside genuine guards — and converting them would be actively
wrong, not merely unnecessary. The lane that writes specs keeps its name whatever a
board calls its planning column; resolving it from a workflow IR would make agent
log rendering and model attribution depend on board configuration.

Five dashboard sites compare `entry.agent` / `role` against this lane:
`TaskChatTab` (marker parsing and explicit-model lookup), `useTasks` (planner
activity), `effective-model-resolution` (engine marker attribution), and
`AgentLogViewer` (the log's lane label).

Naming it is the fix: a reference to `PLANNING_AGENT_LANE` is visibly a lane, a bare
`=== "triage"` is not. Same treatment already applied to `tool-availability` and
`skill-resolver` in the engine (#2619).
*/

/** The agent lane that performs specification. NOT a board column id. */
export const PLANNING_AGENT_LANE = "triage";

/** True when an agent-log entry was produced by the planning lane. */
export function isPlanningAgentLane(agent: string | undefined): boolean {
  return agent === PLANNING_AGENT_LANE;
}
