import { describe, expect, it } from "vitest";
import type { OrgTreeNode } from "../../api";
import {
  estimateOrgChartWidth,
  isOrgChartLayoutPreference,
  resolveOrgChartLayoutMode,
} from "../agentsOrgChartLayout";

function makeNode(id: string, children: OrgTreeNode[] = []): OrgTreeNode {
  return {
    agent: {
      id,
      name: id,
      role: "executor",
      state: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {},
    },
    children,
  };
}

describe("agentsOrgChartLayout", () => {
  it("returns horizontal when estimated width fits", () => {
    const tree = [makeNode("root", [makeNode("child")])];
    const width = estimateOrgChartWidth(tree);
    expect(resolveOrgChartLayoutMode({ tree, availableWidth: width + 1 })).toBe("horizontal");
  });

  it("returns vertical when estimated width exceeds available width", () => {
    const tree = [
      makeNode("root", [
        makeNode("a", [makeNode("a1"), makeNode("a2")]),
        makeNode("b", [makeNode("b1"), makeNode("b2")]),
      ]),
      makeNode("root-2", [makeNode("c"), makeNode("d")]),
    ];
    expect(resolveOrgChartLayoutMode({ tree, availableWidth: 400 })).toBe("vertical");
  });

  it("stays horizontal for single-root trees and zero-width measurement", () => {
    const tree = [makeNode("solo", [makeNode("child-1"), makeNode("child-2")])];
    expect(resolveOrgChartLayoutMode({ tree, availableWidth: 0 })).toBe("horizontal");
    expect(resolveOrgChartLayoutMode({ tree, availableWidth: 120 })).toBe("horizontal");
  });

  it("forces horizontal when preference is horizontal", () => {
    const tree = [
      makeNode("root", [
        makeNode("a", [makeNode("a1"), makeNode("a2")]),
        makeNode("b", [makeNode("b1"), makeNode("b2")]),
      ]),
      makeNode("root-2", [makeNode("c"), makeNode("d")]),
    ];
    expect(resolveOrgChartLayoutMode({ tree, availableWidth: 400, preference: "horizontal" })).toBe("horizontal");
  });

  it("forces vertical when preference is vertical", () => {
    const tree = [makeNode("root", [makeNode("child")])];
    const width = estimateOrgChartWidth(tree);
    expect(resolveOrgChartLayoutMode({ tree, availableWidth: width + 1, preference: "vertical" })).toBe("vertical");
  });

  it("treats auto preference the same as omission", () => {
    const tree = [
      makeNode("root", [
        makeNode("a", [makeNode("a1"), makeNode("a2")]),
        makeNode("b", [makeNode("b1"), makeNode("b2")]),
      ]),
      makeNode("root-2", [makeNode("c"), makeNode("d")]),
    ];

    expect(resolveOrgChartLayoutMode({ tree, availableWidth: 400, preference: "auto" })).toBe(
      resolveOrgChartLayoutMode({ tree, availableWidth: 400 }),
    );
  });

  it("uses compact mobile dimensions for auto mode near mobile breakpoint", () => {
    const tree = [
      makeNode("root", [
        makeNode("a", [makeNode("a1"), makeNode("a2")]),
        makeNode("b", [makeNode("b1"), makeNode("b2")]),
      ]),
    ];

    expect(estimateOrgChartWidth(tree, 700)).toBe(680);
    expect(resolveOrgChartLayoutMode({ tree, availableWidth: 700 })).toBe("horizontal");
  });
});

describe("isOrgChartLayoutPreference", () => {
  it("accepts valid preference values", () => {
    expect(isOrgChartLayoutPreference("auto")).toBe(true);
    expect(isOrgChartLayoutPreference("horizontal")).toBe(true);
    expect(isOrgChartLayoutPreference("vertical")).toBe(true);
  });

  it("rejects invalid preference values", () => {
    expect(isOrgChartLayoutPreference(null)).toBe(false);
    expect(isOrgChartLayoutPreference("")).toBe(false);
    expect(isOrgChartLayoutPreference("auto-fit")).toBe(false);
  });
});
