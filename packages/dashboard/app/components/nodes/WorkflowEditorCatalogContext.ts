import { createContext, useContext } from "react";
import type { NodeSummaryCatalogs } from "./node-summary";

/** Carries the prefetched models/agents/skills catalogs down to the rendered
 *  node cards so NodeShell can resolve config ids to display names via
 *  nodeConfigSummary. Provided inside the ReactFlow tree by WorkflowNodeEditor;
 *  defaults to empty so cards still render (raw-id fallback, KTD-6) when no
 *  provider is present (e.g. isolated component tests). */
export const WorkflowEditorCatalogContext = createContext<NodeSummaryCatalogs>({});

export function useWorkflowEditorCatalogs(): NodeSummaryCatalogs {
  return useContext(WorkflowEditorCatalogContext);
}
