import { describe, it, expect } from "vitest";
import type { NodeInfo } from "../../api";
import { getSelectableRuntimeNodes, shouldShowRuntimeNodeSelector } from "../setupWizardNodes";

/*
FNXC:SetupWizard 2026-07-10-11:00:
First-run review: the wizard's Runtime Node dropdown showed both the built-in "Local node" default and
a registered local node record as "local (local)". These tests pin the dedupe rule: local-type node
records never appear as options, and the selector only exists when a non-local node is registered.
*/

function buildNode(overrides: Partial<NodeInfo> & Pick<NodeInfo, "id" | "type">): NodeInfo {
  return {
    name: overrides.id,
    status: "online",
    maxConcurrent: 2,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as NodeInfo;
}

describe("setupWizardNodes", () => {
  it("filters registered local-type nodes out of the selectable list", () => {
    const nodes = [
      buildNode({ id: "local-1", type: "local" }),
      buildNode({ id: "remote-1", type: "remote" }),
    ];

    expect(getSelectableRuntimeNodes(nodes).map((node) => node.id)).toEqual(["remote-1"]);
  });

  it("hides the selector when only local nodes exist (single-local-node install)", () => {
    expect(shouldShowRuntimeNodeSelector([buildNode({ id: "local-1", type: "local" })])).toBe(false);
    expect(shouldShowRuntimeNodeSelector([])).toBe(false);
  });

  it("shows the selector when at least one non-local node exists", () => {
    const nodes = [
      buildNode({ id: "local-1", type: "local" }),
      buildNode({ id: "remote-1", type: "remote" }),
    ];
    expect(shouldShowRuntimeNodeSelector(nodes)).toBe(true);
  });
});
