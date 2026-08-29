import { loadArtifacts, writeArtifacts } from "./graph-store.js";
import { edgeId, KnowledgeGraphError, type EdgeKind, type GraphEdge, type GraphNode } from "./graph-types.js";

/** An LLM may propose a relation, but cannot choose its persisted identity or provenance. */
export interface InferredEdgeProposal {
  kind: EdgeKind;
  from: string;
  to: string;
  attributes?: Record<string, string>;
}

export interface AddInferredEdgesResult {
  added: number;
  /** Re-proposals whose deterministic edge identity already exists. */
  deduped: number;
  /** Invalid proposals or proposals whose endpoint nodes/families cannot resolve. */
  droppedUnresolved: number;
}

function validProposal(value: unknown): value is InferredEdgeProposal {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proposal = value as Partial<InferredEdgeProposal>;
  return (proposal.kind === "relates-to" || proposal.kind === "rationale-supports")
    && typeof proposal.from === "string" && typeof proposal.to === "string"
    && (proposal.attributes === undefined || (!!proposal.attributes && typeof proposal.attributes === "object"
      && !Array.isArray(proposal.attributes) && Object.values(proposal.attributes).every(value => typeof value === "string")));
}

function isAllowedSemanticRelationship(proposal: InferredEdgeProposal, from: GraphNode, to: GraphNode): boolean {
  return (proposal.kind === "relates-to" && from.kind === "doc-concept" && to.kind === "doc-concept")
    || (proposal.kind === "rationale-supports" && from.kind === "rationale" && to.kind === "symbol");
}

function inferredEdge(proposal: InferredEdgeProposal, anchor: GraphNode): GraphEdge {
  return {
    id: edgeId(proposal.kind, proposal.from, proposal.to),
    kind: proposal.kind,
    from: proposal.from,
    to: proposal.to,
    provenance: "inferred",
    owner: anchor.owner,
    ownerPath: anchor.ownerPath,
    source: { ...anchor.source },
    attributes: { ...proposal.attributes },
  };
}

/**
 * FNXC:KnowledgeGraphInferredEdges 2026-08-11-10:56:
 * FN-8933 permits only concept-to-concept and rationale-to-symbol semantic relations between graph
 * nodes that already exist. This seam owns edge identity, source anchoring, and the inferred stamp,
 * so an LLM response cannot accidentally persist an extracted claim, fabricate a source location,
 * or escape the two allowed semantic families.
 *
 * FNXC:KnowledgeGraphInferredEdges 2026-08-11-11:26:
 * Audit consumers need retry-safe outcome truth: existing deterministic identities count as deduped,
 * while malformed or unresolvable proposals count as droppedUnresolved. Never collapse these states.
 */
export async function addInferredEdges(graphDir: string, proposals: readonly InferredEdgeProposal[]): Promise<AddInferredEdgesResult> {
  const loaded = await loadArtifacts(graphDir);
  if (!loaded.ok) throw new KnowledgeGraphError("Knowledge graph artifact is unavailable for inferred edges");

  const nodes = new Map(loaded.graph.nodes.map(node => [node.id, node]));
  const existing = new Map(loaded.graph.edges.map(edge => [edge.id, edge]));
  let added = 0;
  let deduped = 0;
  let droppedUnresolved = 0;

  for (const value of proposals) {
    if (!validProposal(value)) {
      droppedUnresolved++;
      continue;
    }
    const anchor = nodes.get(value.from);
    const target = nodes.get(value.to);
    if (!anchor || !target || !isAllowedSemanticRelationship(value, anchor, target)) {
      droppedUnresolved++;
      continue;
    }
    const edge = inferredEdge(value, anchor);
    if (existing.has(edge.id)) {
      deduped++;
      continue;
    }
    existing.set(edge.id, edge);
    added++;
  }

  if (added > 0) {
    await writeArtifacts(graphDir, {
      ...loaded.graph,
      edges: [...existing.values()],
    }, loaded.manifest);
  }
  return { added, deduped, droppedUnresolved };
}
