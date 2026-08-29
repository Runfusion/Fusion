import type { OrgTreeNode } from "../api";

export type OrgChartLayoutMode = "horizontal" | "vertical";
export type OrgChartLayoutPreference = "auto" | "horizontal" | "vertical";

export const ORG_CHART_LAYOUT_STORAGE_KEY = "fn-agent-org-chart-layout";

export function isOrgChartLayoutPreference(value: unknown): value is OrgChartLayoutPreference {
  return value === "auto" || value === "horizontal" || value === "vertical";
}

export interface OrgChartLayoutInput {
  tree: OrgTreeNode[];
  availableWidth: number;
  preference?: OrgChartLayoutPreference;
}

interface OrgChartLayoutDimensions {
  nodeWidth: number;
  siblingGap: number;
  rootGap: number;
  chartPadding: number;
}

const MOBILE_BREAKPOINT_WIDTH = 768;

const DESKTOP_LAYOUT_DIMENSIONS: OrgChartLayoutDimensions = {
  nodeWidth: 220,
  siblingGap: 24,
  rootGap: 24,
  chartPadding: 24,
};

const MOBILE_LAYOUT_DIMENSIONS: OrgChartLayoutDimensions = {
  nodeWidth: 160,
  siblingGap: 8,
  rootGap: 8,
  chartPadding: 8,
};

function getLeafCount(node: OrgTreeNode): number {
  if (node.children.length === 0) {
    return 1;
  }
  return node.children.reduce((sum, child) => sum + getLeafCount(child), 0);
}

function resolveLayoutDimensions(availableWidth: number): OrgChartLayoutDimensions {
  return availableWidth <= MOBILE_BREAKPOINT_WIDTH
    ? MOBILE_LAYOUT_DIMENSIONS
    : DESKTOP_LAYOUT_DIMENSIONS;
}

function estimateSubtreeWidth(node: OrgTreeNode, dimensions: OrgChartLayoutDimensions): number {
  const leaves = getLeafCount(node);
  return leaves * dimensions.nodeWidth + Math.max(0, leaves - 1) * dimensions.siblingGap;
}

export function estimateOrgChartWidth(tree: OrgTreeNode[], availableWidth = Number.POSITIVE_INFINITY): number {
  const dimensions = resolveLayoutDimensions(availableWidth);
  if (tree.length === 0) {
    return dimensions.nodeWidth;
  }
  const rootWidths = tree.map((node) => estimateSubtreeWidth(node, dimensions));
  const totalRootsWidth = rootWidths.reduce((sum, width) => sum + width, 0);
  const rootGapWidth = Math.max(0, tree.length - 1) * dimensions.rootGap;
  return totalRootsWidth + rootGapWidth + dimensions.chartPadding * 2;
}

export function resolveOrgChartLayoutMode(input: OrgChartLayoutInput): OrgChartLayoutMode {
  const preference = input.preference ?? "auto";
  if (preference !== "auto") {
    return preference;
  }

  const safeAvailableWidth = Number.isFinite(input.availableWidth) && input.availableWidth > 0
    ? input.availableWidth
    : 0;

  if (safeAvailableWidth === 0 || input.tree.length <= 1) {
    return "horizontal";
  }

  const estimatedWidth = estimateOrgChartWidth(input.tree, safeAvailableWidth);
  return estimatedWidth > safeAvailableWidth ? "vertical" : "horizontal";
}
