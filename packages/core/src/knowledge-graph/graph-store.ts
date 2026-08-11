import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { deserializeArtifacts, serializeGraph, serializeManifest } from "./graph-serialization.js";
import { edgeId, fileNodeId, KnowledgeGraphError, moduleCanonicalPath, moduleNodeId, type GraphEdge, type GraphManifest, type GraphNode, type KnowledgeGraph } from "./graph-types.js";

/*
FNXC:KnowledgeGraph 2026-08-10-10:00:
The graph is review-visible and committable, while .fusion is ignored, so artifacts live under
.fusion-knowledge/graph. FR-29/FR-34 capability bundles do not have a format yet and are deferred.
*/
export const DEFAULT_KNOWLEDGE_GRAPH_DIR = ".fusion-knowledge/graph";
export type RecoveryReason="missing-artifact"|"invalid-artifact"|"version-mismatch"|"inconsistent-artifact"|"forced";
export type ArtifactLoadResult={ok:true;graph:KnowledgeGraph;manifest:GraphManifest;recoveryReason:null}|{ok:false;recoveryReason:RecoveryReason};
export function resolveKnowledgeGraphDir(projectRoot:string, configured?:string):string { const root=resolve(projectRoot), target=resolve(root,configured||DEFAULT_KNOWLEDGE_GRAPH_DIR), rel=relative(root,target); if(isAbsolute(rel)||rel===".."||rel.startsWith(`..${sep}`)) throw new KnowledgeGraphError("Knowledge graph directory escapes project root");return target; }
function isMissing(error:unknown){return (error as NodeJS.ErrnoException).code==="ENOENT";}
function consistent(graph: KnowledgeGraph, manifest: GraphManifest): boolean {
  const allFileNodes = graph.nodes.filter(node => node.owner === "file" && node.kind === "file");
  const fileNodes = new Map(allFileNodes.map(node => [node.ownerPath, node]));
  /*
  FNXC:KnowledgeGraph 2026-08-10-12:06:
  A Map alone hides a second, differently-id'd file root with the same ownership path. Reject it
  so a malformed artifact always takes the safe full-rebuild path instead of reusing rogue nodes.
  */
  if (allFileNodes.length !== fileNodes.size || fileNodes.size !== Object.keys(manifest.files).length) return false;
  if ([...fileNodes].some(([path, node]) => node.id !== `file:${path}` || !manifest.files[path])) return false;
  if (graph.nodes.some(node => node.owner === "file" && !manifest.files[node.ownerPath])) return false;

  // Artifact JSON is an untrusted incremental cache. Checking only ownerPath permits a corrupt
  // symbol/doc/rationale id (or a cross-file source anchor) to survive every no-op rebuild.
  const expectedNodeId = (node: GraphNode): string | undefined => {
    switch (node.kind) {
      case "file": return `file:${node.ownerPath}`;
      case "module": return `module:${node.ownerPath}`;
      case "symbol": return node.id.startsWith(`symbol:${node.ownerPath}#`) ? node.id : undefined;
      case "doc-concept": return node.id.startsWith(`doc:${node.ownerPath}#`) ? node.id : undefined;
      case "rationale": return node.id.startsWith(`rationale:${node.ownerPath}#`) ? node.id : undefined;
    }
  };
  /*
  FNXC:KnowledgeGraph 2026-08-10-12:38:
  Persisted artifacts are an untrusted incremental cache. Validate ownership classes as well as ids:
  only module facts are derived, and derived edges are module-scoped contains edges. Otherwise a
  malformed cache can survive an incremental reuse path with a node that pruning can never own.
  */
  const moduleFiles = allFileNodes
    .map(node => node.ownerPath)
    .filter(path => /\.tsx?$/.test(path));
  const hasSyntheticMarker = (item: GraphNode | GraphEdge) => "syntheticSource" in item.attributes;
  const isSyntheticAnchor = (item: GraphNode | GraphEdge, path: string) => item.attributes.syntheticSource === "true"
    && item.source.path === path && item.source.line === 1 && item.source.column === 1;
  /*
  FNXC:KnowledgeGraph 2026-08-10-12:48:
  A persisted graph is an untrusted incremental cache, so synthetic anchors must be validated before
  reuse. File/module facts and module-scoped edges have no parsed text position; accepting a fake
  location or a synthetic marker on a real symbol/comment edge would preserve false provenance.
  */
  if (graph.nodes.some(node => {
    if (expectedNodeId(node) !== node.id) return true;
    if (node.kind === "file") return node.owner !== "file" || !isSyntheticAnchor(node, node.ownerPath);
    if (node.kind === "module") return node.owner !== "derived"
      || !isSyntheticAnchor(node, moduleCanonicalPath(node.ownerPath, moduleFiles));
    return node.owner !== "file" || node.source.path !== node.ownerPath || hasSyntheticMarker(node);
  })) return false;
  if (graph.edges.some(edge => {
    if (edge.id !== edgeId(edge.kind, edge.from, edge.to)) return true;
    if (edge.owner === "derived") return edge.kind !== "contains"
      || edge.from !== moduleNodeId(edge.ownerPath)
      || !isSyntheticAnchor(edge, moduleCanonicalPath(edge.ownerPath, moduleFiles));
    /*
    FNXC:KnowledgeGraph 2026-08-10-12:56:
    Documentation hierarchy is file-owned but links a heading to its child heading. Only import
    references must originate at the owning file node; rejecting the hierarchy would force a full
    rebuild of every otherwise-valid graph artifact.
    */
    return edge.source.path !== edge.ownerPath || hasSyntheticMarker(edge)
      || ((edge.kind === "imports" || edge.kind === "re-exports") && edge.from !== fileNodeId(edge.ownerPath));
  })) return false;

  const ids = new Set<string>();
  for (const node of graph.nodes) {
    if (ids.has(node.id)) return false;
    ids.add(node.id);
  }
  const edgeIds = new Set<string>();
  for (const edge of graph.edges) {
    if (edgeIds.has(edge.id)) return false;
    edgeIds.add(edge.id);
  }
  return !graph.edges
    .filter(edge => edge.owner !== "derived" && edge.kind !== "imports" && edge.kind !== "re-exports")
    .some(edge => !manifest.files[edge.ownerPath] || !ids.has(edge.from) || !ids.has(edge.to));
}
export async function loadArtifacts(graphDir:string, logger:(message:string)=>void=()=>{}):Promise<ArtifactLoadResult>{const paths=["nodes.json","edges.json","manifest.json"].map(x=>resolve(graphDir,x));let text:string[];try{text=await Promise.all(paths.map(p=>readFile(p,"utf8")));}catch(error){if(isMissing(error))return{ok:false,recoveryReason:"missing-artifact"};throw new KnowledgeGraphError(`Unable to read knowledge graph artifacts: ${error instanceof Error?error.message:String(error)}`);}const decoded=deserializeArtifacts(text[0]!,text[1]!,text[2]!);if(!decoded.ok){logger(`Knowledge graph artifact recovery: ${decoded.reason}`);return{ok:false,recoveryReason:decoded.reason};}if(!consistent(decoded.graph,decoded.manifest)){logger("Knowledge graph artifact recovery: inconsistent-artifact");return{ok:false,recoveryReason:"inconsistent-artifact"};}return{ok:true,graph:decoded.graph,manifest:decoded.manifest,recoveryReason:null};}
async function writeIfChanged(path:string, content:string):Promise<boolean>{try{if(await readFile(path,"utf8")===content)return false;}catch(error){if(!isMissing(error))throw error;}await mkdir(dirname(path),{recursive:true});const temp=`${path}.${randomUUID()}.tmp`;try{await writeFile(temp,content,"utf8");await rename(temp,path);return true;}catch(error){await unlink(temp).catch(()=>{});throw error;}}
/** Manifest is last: a torn write can only force a safe full rebuild, never validate unwritten nodes. */
export async function writeArtifacts(graphDir:string,graph:KnowledgeGraph,manifest:GraphManifest):Promise<{nodes:boolean;edges:boolean;manifest:boolean;changed:boolean}>{const bytes=serializeGraph(graph),nodes=await writeIfChanged(resolve(graphDir,"nodes.json"),bytes.nodes),edges=await writeIfChanged(resolve(graphDir,"edges.json"),bytes.edges),manifestChanged=await writeIfChanged(resolve(graphDir,"manifest.json"),serializeManifest(manifest));return{nodes,edges,manifest:manifestChanged,changed:nodes||edges||manifestChanged};}
