import type { GraphData, GraphPosition } from "./types.js";

export interface LayoutOptions {
  nodeWidth?: number;
  nodeHeight?: number;
  horizontalGap?: number;
  verticalGap?: number;
  orientation?: "vertical" | "horizontal";
  /**
   * Optional measured per-node heights (in px). Used by both orientations to avoid
   * overlaps; nodes without a measurement fall back to `nodeHeight`.
   */
  measuredHeights?: ReadonlyMap<string, number>;
}

const DEFAULT_LAYOUT_OPTIONS: Omit<Required<LayoutOptions>, "measuredHeights"> = {
  nodeWidth: 280,
  nodeHeight: 100,
  horizontalGap: 40,
  verticalGap: 80,
  orientation: "vertical",
};

export function computeAutoLayout(
  graphData: GraphData,
  options?: LayoutOptions,
): Map<string, GraphPosition> {
  const settings = { ...DEFAULT_LAYOUT_OPTIONS, ...options };
  const nodeIds = graphData.nodes.map((node) => node.task.id);
  if (nodeIds.length === 0) return new Map();

  const dependentsByDependency = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const id of nodeIds) {
    inDegree.set(id, 0);
    dependentsByDependency.set(id, []);
  }

  for (const edge of graphData.edges) {
    if (!inDegree.has(edge.source) || !inDegree.has(edge.target)) continue;
    dependentsByDependency.get(edge.target)?.push(edge.source);
    inDegree.set(edge.source, (inDegree.get(edge.source) ?? 0) + 1);
  }

  const queue = nodeIds.filter((id) => (inDegree.get(id) ?? 0) === 0);
  const topologicalOrder: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    topologicalOrder.push(current);
    for (const dependent of dependentsByDependency.get(current) ?? []) {
      const nextInDegree = (inDegree.get(dependent) ?? 0) - 1;
      inDegree.set(dependent, nextInDegree);
      if (nextInDegree === 0) queue.push(dependent);
    }
  }

  for (const id of nodeIds) {
    if (!topologicalOrder.includes(id)) topologicalOrder.push(id);
  }

  const depthByNode = new Map<string, number>();
  for (const id of topologicalOrder) {
    const parents = graphData.edges.filter((edge) => edge.source === id).map((edge) => edge.target);
    let depth = 0;
    for (const parent of parents) {
      depth = Math.max(depth, (depthByNode.get(parent) ?? 0) + 1);
    }
    depthByNode.set(id, depth);
  }

  const layers = new Map<number, string[]>();
  for (const id of nodeIds) {
    const depth = depthByNode.get(id) ?? 0;
    const layer = layers.get(depth) ?? [];
    layer.push(id);
    layers.set(depth, layer);
  }

  const positions = new Map<string, GraphPosition>();
  const sortedDepths = Array.from(layers.keys()).sort((a, b) => a - b);

  const rowOffsetByDepth = new Map<number, number>();
  if (settings.orientation === "vertical") {
    let currentOffset = 0;
    for (const depth of sortedDepths) {
      rowOffsetByDepth.set(depth, currentOffset);
      const layer = layers.get(depth) ?? [];
      const layerHeight = Math.max(
        settings.nodeHeight,
        ...layer.map((id) => settings.measuredHeights?.get(id) ?? settings.nodeHeight),
      );
      currentOffset += layerHeight + settings.verticalGap;
    }
  }

  for (const depth of sortedDepths) {
    const layer = layers.get(depth) ?? [];
    layer.sort();
    const isHorizontal = settings.orientation === "horizontal";

    if (isHorizontal) {
      const totalHeight =
        layer.reduce((sum, id) => sum + (settings.measuredHeights?.get(id) ?? settings.nodeHeight), 0) +
        Math.max(0, layer.length - 1) * settings.verticalGap;
      const startOffset = -totalHeight / 2;
      const x = depth * (settings.nodeWidth + settings.horizontalGap);
      let cursorY = startOffset;

      for (const id of layer) {
        positions.set(id, { x, y: cursorY });
        cursorY += (settings.measuredHeights?.get(id) ?? settings.nodeHeight) + settings.verticalGap;
      }
      continue;
    }

    const layerSpan = layer.length * settings.nodeWidth + Math.max(0, layer.length - 1) * settings.horizontalGap;
    const startOffset = -layerSpan / 2;

    layer.forEach((id, index) => {
      const x = startOffset + index * (settings.nodeWidth + settings.horizontalGap);
      const y = rowOffsetByDepth.get(depth) ?? depth * (settings.nodeHeight + settings.verticalGap);
      positions.set(id, { x, y });
    });
  }

  return positions;
}
