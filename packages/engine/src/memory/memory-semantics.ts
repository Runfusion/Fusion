import { queryNodes, resolveProjectDefaultModel, type GraphNode, type KnowledgeGraph, type TaskStore } from "@fusion/core";
import { createFnAgent, promptWithFallback } from "../pi.js";
import { resolveMcpServersForStore } from "../mcp/mcp-resolution.js";

export type SemanticProposal = { kind: "relates-to" | "rationale-supports"; from: string; to: string };
export type MemorySemanticsResult = { proposals: SemanticProposal[]; skipped?: "unchanged" | "malformed-response" | "no-candidates" };

const MAX_PROPOSALS = 24;
const MAX_CANDIDATES = 80;

/*
FNXC:MemoryKnowledgeGraph 2026-08-11-10:55:
FN-8933 confines model work to semantic relationships. Structural extraction remains deterministic
and LLM-free; this pass sends bounded identifiers only, accepts strict JSON only, and delegates every
accepted proposal to the core inferred-edge seam rather than constructing graph edges itself.
*/
const SEMANTICS_SYSTEM_PROMPT = `You infer only semantic graph links from candidate node identifiers. Return JSON only, no fences, as {"proposals":[{"kind":"relates-to","from":"id","to":"id"}]}. Allowed kinds: relates-to for concept↔concept and rationale-supports for rationale→symbol. Never emit contains, imports, re-exports, provenance, labels, or explanations. At most 24 proposals.`;

function parseProposal(value: unknown): SemanticProposal | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  if ((row.kind !== "relates-to" && row.kind !== "rationale-supports") || typeof row.from !== "string" || typeof row.to !== "string") return undefined;
  return { kind: row.kind, from: row.from, to: row.to };
}

export function parseMemorySemanticsResponse(text: string): MemorySemanticsResult {
  try {
    const decoded = JSON.parse(text) as { proposals?: unknown };
    if (!Array.isArray(decoded.proposals)) return { proposals: [], skipped: "malformed-response" };
    const proposals = decoded.proposals.map(parseProposal).filter((value): value is SemanticProposal => Boolean(value)).slice(0, MAX_PROPOSALS);
    return { proposals };
  } catch { return { proposals: [], skipped: "malformed-response" }; }
}

export function selectMemorySemanticCandidates(graph: KnowledgeGraph): GraphNode[] {
  const concepts = queryNodes(graph, { kinds: ["doc-concept"], limit: MAX_CANDIDATES });
  const rationales = queryNodes(graph, { kinds: ["rationale"], limit: MAX_CANDIDATES });
  const symbols = queryNodes(graph, { kinds: ["symbol"], limit: MAX_CANDIDATES });
  return [...concepts, ...rationales, ...symbols].sort((left, right) => left.id.localeCompare(right.id)).slice(0, MAX_CANDIDATES);
}

/** Runs the model only when graph material changed; unchanged ticks are provably model-free. */
export async function runMemorySemanticsPass(input: {
  graph: KnowledgeGraph;
  graphChanged: boolean;
  taskStore: TaskStore;
  agentId: string;
  rootDir: string;
  write: (proposals: SemanticProposal[]) => Promise<{ written: number; deduped: number; droppedUnresolved: number }>;
}): Promise<MemorySemanticsResult & { written?: number; deduped?: number; droppedUnresolved?: number }> {
  if (!input.graphChanged) return { proposals: [], skipped: "unchanged" };
  const candidates = selectMemorySemanticCandidates(input.graph);
  if (!candidates.length) return { proposals: [], skipped: "no-candidates" };
  let response = "";
  let model: { provider?: string; modelId?: string } = {};
  try { const resolved = resolveProjectDefaultModel(await input.taskStore.getSettings()); if (resolved.provider && resolved.modelId) model = { provider: resolved.provider, modelId: resolved.modelId }; } catch { /* runtime default is the established fallback */ }
  const { session } = await createFnAgent({ cwd: input.rootDir, systemPrompt: SEMANTICS_SYSTEM_PROMPT, tools: "readonly", ...(model.provider && model.modelId ? { defaultProvider: model.provider, defaultModelId: model.modelId } : {}), mcpServers: (await resolveMcpServersForStore(input.taskStore, { agentId: input.agentId })).servers, onText: (delta: string) => { response += delta; } });
  try {
    await promptWithFallback(session, JSON.stringify({ candidates: candidates.map((node) => ({ id: node.id, kind: node.kind, area: node.attributes.fnxcArea })) }));
    const state = session.state as { errorMessage?: string; error?: string };
    if (state.errorMessage ?? state.error) return { proposals: [], skipped: "malformed-response" };
  } finally { try { session.dispose(); } catch { /* best-effort */ } }
  const parsed = parseMemorySemanticsResponse(response);
  if (parsed.skipped) return parsed;
  const written = await input.write(parsed.proposals);
  return { ...parsed, ...written };
}
