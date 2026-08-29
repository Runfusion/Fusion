import type { Task } from "@fusion/core";

export interface GraphPosition {
  x: number;
  y: number;
}

export interface GraphNode {
  task: Task;
  position?: GraphPosition;
}

export interface GraphEdge {
  source: string;
  target: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}
