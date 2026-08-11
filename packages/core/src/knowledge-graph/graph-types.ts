import { basename, posix } from "node:path";

/*
FNXC:KnowledgeGraph 2026-08-10-10:00:
FN-8921 establishes a deterministic, committable structure graph for the memory epic. Part 1 records
only parser-extracted facts; inferred edges, embeddings, MCP tools, and capability bundles are deferred.
*/
/*
FNXC:KnowledgeGraph 2026-08-10-12:24:
Schema version 2 records edge identities as their kind and already-canonical node ids joined by pipes.
Re-escaping whole node ids changed structural `#` separators and produced a different persisted grammar.
*/
export const KNOWLEDGE_GRAPH_SCHEMA_VERSION = 2;
export const KNOWLEDGE_GRAPH_EXTRACTOR_VERSION = 1;
export type EdgeProvenance = "extracted" | "inferred";
export type GraphOwner = "file" | "derived";
export type GraphNodeKind = "file" | "module" | "symbol" | "doc-concept" | "rationale";
export type SymbolKind = "function" | "class" | "interface" | "type-alias" | "enum" | "variable" | "namespace" | "alias";
export type EdgeKind = "contains" | "imports" | "re-exports";
export interface SourceLocation { path: string; line: number; column: number }
export interface GraphNode { id: string; kind: GraphNodeKind; name: string; owner: GraphOwner; ownerPath: string; source: SourceLocation; attributes: Record<string,string> }
export interface GraphEdge { id: string; kind: EdgeKind; from: string; to: string; provenance: EdgeProvenance; owner: GraphOwner; ownerPath: string; source: SourceLocation; attributes: Record<string,string> }
export interface KnowledgeGraph { schemaVersion: number; nodes: GraphNode[]; edges: GraphEdge[] }
export interface ImportRef { kind: "imports" | "re-exports"; specifier: string; candidates: string[]; line: number; column: number; typeOnly: boolean }
export interface GraphManifestEntry { hash: string; importRefs?: ImportRef[] }
export interface GraphManifest { schemaVersion: number; extractorVersion: number; files: Record<string, GraphManifestEntry> }
export type TypeScriptExtractor = (input: ExtractorInput) => ExtractorOutput;
export type MarkdownExtractor = (input: ExtractorInput) => ExtractorOutput;
export type FnxcExtractor = (input: ExtractorInput) => ExtractorOutput;
export interface ExtractorDependencies { typescript?: TypeScriptExtractor; markdown?: MarkdownExtractor; fnxc?: FnxcExtractor }
export interface ExtractorInput { relPath: string; content: string; fileNodeId: string }
export interface ExtractorOutput { nodes: GraphNode[]; edges: GraphEdge[]; importRefs: ImportRef[] }
/** Only invalid caller paths, impossible internal duplicate invariants, and load IO faults may throw this error; source content never may. */
export class KnowledgeGraphError extends Error { constructor(message: string) { super(message); this.name = "KnowledgeGraphError"; } }
/** Normalize ids to repo-relative POSIX paths and reject caller paths which can escape the repository. */
export function normalizeRelPath(value: string): string { const normalized=value.replace(/\\/g,"/"); if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").includes("..")) throw new KnowledgeGraphError(`Invalid relative path: ${value}`); const result=posix.normalize(normalized).replace(/^\.\//,"").replace(/\/$/,""); if (!result || result==="." || result.startsWith("../")) throw new KnowledgeGraphError(`Invalid relative path: ${value}`); return result; }
export function escapeIdSegment(value: string): string { return value.replace(/[%#@~|\n]/g, c => ({"%":"%25","#":"%23","@":"%40","~":"%7E","|":"%7C","\n":"%0A"})[c]!); }
export const fileNodeId=(path:string)=>`file:${normalizeRelPath(path)}`;
export const moduleNodeId=(path:string)=>`module:${normalizeRelPath(path)}`;
export const symbolNodeId=(path:string,name:string)=>`symbol:${normalizeRelPath(path)}#${escapeIdSegment(name)}`;
export const docConceptNodeId=(path:string,slug:string,index:number)=>`doc:${normalizeRelPath(path)}#${escapeIdSegment(slug)}~${index}`;
export const rationaleNodeId=(path:string,area:string,stamp:string,index:number)=>`rationale:${normalizeRelPath(path)}#${escapeIdSegment(area)}@${escapeIdSegment(stamp)}~${index}`;
/**
 * FNXC:KnowledgeGraph 2026-08-10-12:24:
 * Compose the persisted edge identity as `<kind>|<from-node-id>|<to-node-id>`.
 * Node ids have already escaped their variable segments, including `|`; escaping a complete node id
 * here would rewrite structural separators such as `#` and make persisted ids diverge from the contract.
 */
export const edgeId=(kind:EdgeKind,from:string,to:string)=>`${kind}|${from}|${to}`;
export function moduleCanonicalPath(dir:string, files: readonly string[]): string { const d=normalizeRelPath(dir); return files.includes(`${d}/index.ts`)?`${d}/index.ts`:files.includes(`${d}/index.tsx`)?`${d}/index.tsx`:d; }
/** Collapse every same-file symbol duplicate in source-position order, including malformed redeclarations. */
export function collapseDuplicateSymbolNodes(nodes: GraphNode[]): GraphNode[] { const groups=new Map<string,GraphNode[]>(); for(const n of nodes){if(n.kind!=="symbol"){groups.set(`${n.id}\0${groups.size}`, [n]);continue;} const a=groups.get(n.id)??[];a.push(n);groups.set(n.id,a);} const out:GraphNode[]=[];for(const list of groups.values()){list.sort((a,b)=>a.source.path.localeCompare(b.source.path)||a.source.line-b.source.line||a.source.column-b.source.column); const first=list[0]!; if(first.kind!=="symbol"){out.push(first);continue;} const kinds=[...new Set(list.map(x=>x.attributes.symbolKind).filter(Boolean))].sort(); const attributes: Record<string, string>={...first.attributes,declarationCount:String(list.length)}; if(kinds.length>1) attributes.symbolKinds=kinds.join(","); else delete attributes.symbolKinds; out.push({...first,attributes});} return out.sort((a,b)=>a.id.localeCompare(b.id)); }
export function assertNoInternalDuplicateNodes(nodes: GraphNode[]): void { const seen=new Map<string,GraphNode>(); for(const node of nodes){const prior=seen.get(node.id); if(prior && (prior.kind!==node.kind || prior.ownerPath!==node.ownerPath)) throw new KnowledgeGraphError(`Internal duplicate node invariant: ${node.id}`); seen.set(node.id,node);} }
export const moduleName=(dir:string)=>basename(dir);
