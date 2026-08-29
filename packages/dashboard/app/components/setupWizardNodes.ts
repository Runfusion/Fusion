import type { NodeInfo } from "../api";

/*
FNXC:SetupWizard 2026-07-10-11:00:
First-run review (project registration, Advanced settings): the Runtime Node dropdown showed two
near-identical options — the built-in "Local node" default option (empty value = run on this machine)
PLUS a registered local node record rendered as "local (local)". A single-local-node install must show
exactly one local choice, so:
- registered nodes of type "local" are filtered out of the option list (the built-in default option
  already represents them; registering with an empty nodeId runs locally), and
- the selector is hidden entirely when there is no non-local node to pick — a choice with one option
  is noise during first-run setup.
Kept as a pure module so the dedupe rule is unit-testable without rendering the wizard.
*/

/** Nodes that are meaningful to offer in the Runtime Node dropdown (everything except local-type records). */
export function getSelectableRuntimeNodes(nodes: NodeInfo[]): NodeInfo[] {
  return nodes.filter((node) => node.type !== "local");
}

/** The Runtime Node selector is only shown when there is at least one non-local node to choose. */
export function shouldShowRuntimeNodeSelector(nodes: NodeInfo[]): boolean {
  return getSelectableRuntimeNodes(nodes).length > 0;
}
