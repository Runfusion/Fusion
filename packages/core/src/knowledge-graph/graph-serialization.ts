import {
  KNOWLEDGE_GRAPH_EXTRACTOR_VERSION,
  KNOWLEDGE_GRAPH_SCHEMA_VERSION,
  type EdgeKind,
  type GraphEdge,
  type GraphManifest,
  type GraphManifestEntry,
  type GraphNode,
  type GraphNodeKind,
  type GraphOwner,
  type ImportRef,
  type KnowledgeGraph,
  normalizeRelPath,
} from "./graph-types.js";

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    /*
    FNXC:KnowledgeGraph 2026-08-10-11:38:
    Artifact roots are self-describing, so schemaVersion remains the first serialized key while
    nested maps stay recursively sorted for byte-stable commits.
    */
    const schema = entries.find(([key]) => key === "schemaVersion");
    const rootOrdered = schema ? [schema, ...entries.filter(([key]) => key !== "schemaVersion")] : entries;
    return Object.fromEntries(rootOrdered.map(([key, entry]) => [key, ordered(entry)]));
  }
  return value;
}

export const canonicalJson = (value: unknown) => `${JSON.stringify(ordered(value), null, 2)}\n`;

export function serializeGraph(graph: KnowledgeGraph): { nodes: string; edges: string } {
  return {
    nodes: canonicalJson({ schemaVersion: KNOWLEDGE_GRAPH_SCHEMA_VERSION, nodes: [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id)) }),
    edges: canonicalJson({ schemaVersion: KNOWLEDGE_GRAPH_SCHEMA_VERSION, edges: [...graph.edges].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)) }),
  };
}

export const serializeManifest = (manifest: GraphManifest) => canonicalJson({
  schemaVersion: KNOWLEDGE_GRAPH_SCHEMA_VERSION,
  extractorVersion: KNOWLEDGE_GRAPH_EXTRACTOR_VERSION,
  files: manifest.files,
});

const owners = new Set<GraphOwner>(["file", "derived"]);
const nodeKinds = new Set<GraphNodeKind>(["file", "module", "symbol", "doc-concept", "rationale"]);
const edgeKinds = new Set<EdgeKind>(["contains", "imports", "re-exports"]);
const hasStringMap = (value: unknown): value is Record<string, string> => !!value && typeof value === "object" && !Array.isArray(value) && Object.values(value).every(entry => typeof entry === "string");
const validPath = (value: unknown) => {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    /*
    FNXC:KnowledgeGraph 2026-08-10-12:06:
    Persisted identities must already be canonical; normalizing on load could silently reuse a
    foreign owner rather than triggering the full-rebuild recovery path.
    */
    return normalizeRelPath(value) === value;
  } catch {
    return false;
  }
};
const validSource = (value: unknown) => !!value && typeof value === "object" && validPath((value as GraphNode["source"]).path) && Number.isInteger((value as GraphNode["source"]).line) && (value as GraphNode["source"]).line >= 1 && Number.isInteger((value as GraphNode["source"]).column) && (value as GraphNode["source"]).column >= 1;

function validNode(value: unknown): value is GraphNode {
  if (!value || typeof value !== "object") return false;
  const node = value as GraphNode;
  return typeof node.id === "string" && node.id.length > 0 && nodeKinds.has(node.kind) && typeof node.name === "string"
    && owners.has(node.owner) && validPath(node.ownerPath) && validSource(node.source) && hasStringMap(node.attributes);
}

function validEdge(value: unknown): value is GraphEdge {
  if (!value || typeof value !== "object") return false;
  const edge = value as GraphEdge;
  return typeof edge.id === "string" && edge.id.length > 0 && edgeKinds.has(edge.kind) && typeof edge.from === "string" && typeof edge.to === "string"
    && (edge.provenance === "extracted" || edge.provenance === "inferred") && owners.has(edge.owner) && validPath(edge.ownerPath)
    && validSource(edge.source) && hasStringMap(edge.attributes);
}

function validImportRef(value: unknown): value is ImportRef {
  if (!value || typeof value !== "object") return false;
  const ref = value as ImportRef;
  return (ref.kind === "imports" || ref.kind === "re-exports") && typeof ref.specifier === "string" && Array.isArray(ref.candidates)
    && ref.candidates.every(validPath) && Number.isInteger(ref.line) && ref.line >= 1 && Number.isInteger(ref.column) && ref.column >= 1 && typeof ref.typeOnly === "boolean";
}

function validManifestEntry(value: unknown): value is GraphManifestEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as GraphManifestEntry;
  return typeof entry.hash === "string" && /^[a-f0-9]{64}$/.test(entry.hash)
    && (entry.importRefs === undefined || (Array.isArray(entry.importRefs) && entry.importRefs.every(validImportRef)));
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

function validManifest(value: unknown): value is GraphManifest {
  if (!value || typeof value !== "object") return false;
  const manifest = value as GraphManifest;
  return hasExactKeys(manifest, ["schemaVersion", "extractorVersion", "files"])
    && manifest.schemaVersion === KNOWLEDGE_GRAPH_SCHEMA_VERSION && manifest.extractorVersion === KNOWLEDGE_GRAPH_EXTRACTOR_VERSION
    && !!manifest.files && typeof manifest.files === "object" && !Array.isArray(manifest.files)
    && Object.entries(manifest.files).every(([path, entry]) => validPath(path) && validManifestEntry(entry));
}

/** Invalid persisted shapes return a recovery result; corrupted artifacts never become trusted graph state. */
export function deserializeArtifacts(nodesText: string, edgesText: string, manifestText: string): { ok: true; graph: KnowledgeGraph; manifest: GraphManifest } | { ok: false; reason: "invalid-artifact" | "version-mismatch" } {
  try {
    const nodesPayload: unknown = JSON.parse(nodesText);
    const edgesPayload: unknown = JSON.parse(edgesText);
    const manifestPayload: unknown = JSON.parse(manifestText);
    // A missing version is a malformed payload, not an older compatible artifact. Reserve the
    // version-mismatch recovery reason for otherwise-shaped payloads that explicitly declare a
    // different version, so operators can distinguish corruption from an intentional upgrade.
    const versionMismatch = [nodesPayload, edgesPayload, manifestPayload].some(value => !!value && typeof value === "object"
      && "schemaVersion" in value && (value as { schemaVersion?: unknown }).schemaVersion !== KNOWLEDGE_GRAPH_SCHEMA_VERSION)
      || !!manifestPayload && typeof manifestPayload === "object" && "extractorVersion" in manifestPayload
        && (manifestPayload as { extractorVersion?: unknown }).extractorVersion !== KNOWLEDGE_GRAPH_EXTRACTOR_VERSION;
    if (versionMismatch) return { ok: false, reason: "version-mismatch" };
    if (!nodesPayload || typeof nodesPayload !== "object" || !edgesPayload || typeof edgesPayload !== "object"
      || !hasExactKeys(nodesPayload, ["schemaVersion", "nodes"]) || !hasExactKeys(edgesPayload, ["schemaVersion", "edges"])
      || !Array.isArray((nodesPayload as { nodes?: unknown }).nodes) || !Array.isArray((edgesPayload as { edges?: unknown }).edges)
      || !(nodesPayload as { nodes: unknown[] }).nodes.every(validNode) || !(edgesPayload as { edges: unknown[] }).edges.every(validEdge) || !validManifest(manifestPayload)) {
      return { ok: false, reason: "invalid-artifact" };
    }
    return { ok: true, graph: { schemaVersion: KNOWLEDGE_GRAPH_SCHEMA_VERSION, nodes: (nodesPayload as { nodes: GraphNode[] }).nodes, edges: (edgesPayload as { edges: GraphEdge[] }).edges }, manifest: manifestPayload };
  } catch {
    return { ok: false, reason: "invalid-artifact" };
  }
}
