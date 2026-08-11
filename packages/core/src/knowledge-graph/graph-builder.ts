import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { deriveModules } from "./derive-modules.js";
import { discoverFiles, type FileDiscoveryOptions } from "./file-discovery.js";
import { extractFile } from "./extract-file.js";
import { fingerprintContent } from "./graph-manifest.js";
import {
  assertNoInternalDuplicateNodes,
  edgeId,
  fileNodeId,
  KNOWLEDGE_GRAPH_SCHEMA_VERSION,
  KNOWLEDGE_GRAPH_EXTRACTOR_VERSION,
  type ExtractorDependencies,
  type GraphEdge,
  type GraphManifest,
  type KnowledgeGraph,
} from "./graph-types.js";
import { selectImportTarget } from "./resolve-imports.js";
import { loadArtifacts, resolveKnowledgeGraphDir, writeArtifacts, type RecoveryReason } from "./graph-store.js";

export interface BuildKnowledgeGraphOptions {
  projectRoot: string;
  /** Defaults to the tracked artifact location under projectRoot. */
  graphDir?: string;
  force?: boolean;
  deps?: ExtractorDependencies;
  extractFile?: typeof extractFile;
  logger?: (message: string) => void;
  discovery?: FileDiscoveryOptions;
}

/**
 * Rebuild the content-pure file layer incrementally, then regenerate cross-file and derived facts.
 * Import edges are deliberately synthesized from persisted references on every run: an added or
 * removed target must not require parsing an otherwise unchanged importer.
 */
/*
FNXC:KnowledgeGraph 2026-08-10-11:07:
The programmatic builder defaults to the tracked graph location just like the CLI. Callers may
supply another contained directory for tests or project policy, but an omitted option must not
turn a normal build into an undefined-path I/O failure.
*/
export async function buildKnowledgeGraph(options: BuildKnowledgeGraphOptions) {
  const graphDir = resolveKnowledgeGraphDir(options.projectRoot, options.graphDir);
  const files = await discoverFiles(options.projectRoot, options.discovery);
  const prior = options.force
    ? { ok: false as const, recoveryReason: "forced" as RecoveryReason }
    : await loadArtifacts(graphDir, options.logger);
  const graph: KnowledgeGraph = prior.ok
    ? {
      schemaVersion: prior.graph.schemaVersion,
      nodes: prior.graph.nodes.filter(node => node.owner !== "derived"),
      edges: prior.graph.edges.filter(edge => edge.owner !== "derived" && edge.kind !== "imports" && edge.kind !== "re-exports"),
    }
    : { schemaVersion: KNOWLEDGE_GRAPH_SCHEMA_VERSION, nodes: [], edges: [] };
  const manifest: GraphManifest = prior.ok
    ? { ...prior.manifest, files: { ...prior.manifest.files } }
    : { schemaVersion: KNOWLEDGE_GRAPH_SCHEMA_VERSION, extractorVersion: KNOWLEDGE_GRAPH_EXTRACTOR_VERSION, files: {} };
  const oldPaths = new Set(Object.keys(manifest.files));
  let parsedFiles = 0;
  let reusedFiles = 0;
  let addedFiles = 0;

  for (const relPath of files) {
    const bytes = await readFile(resolve(options.projectRoot, relPath));
    const content = bytes.toString("utf8");
    const hash = fingerprintContent(bytes);
    const previous = manifest.files[relPath];
    if (prior.ok && previous?.hash === hash) {
      reusedFiles++;
      continue;
    }
    if (!previous) addedFiles++;
    parsedFiles++;
    graph.nodes = graph.nodes.filter(node => node.ownerPath !== relPath);
    graph.edges = graph.edges.filter(edge => edge.ownerPath !== relPath);
    const result = (options.extractFile ?? extractFile)({ relPath, content }, options.deps);
    graph.nodes.push(...result.nodes);
    graph.edges.push(...result.edges);
    manifest.files[relPath] = { hash, ...(result.importRefs.length > 0 ? { importRefs: result.importRefs } : {}) };
  }

  let deletedFiles = 0;
  for (const relPath of oldPaths) {
    if (files.includes(relPath)) continue;
    deletedFiles++;
    delete manifest.files[relPath];
    graph.nodes = graph.nodes.filter(node => node.ownerPath !== relPath);
    graph.edges = graph.edges.filter(edge => edge.ownerPath !== relPath);
  }

  const discovered = new Set(files);
  for (const relPath of files) {
    for (const reference of manifest.files[relPath]?.importRefs ?? []) {
      const target = selectImportTarget(reference.candidates, discovered);
      if (!target) continue;
      const edge: GraphEdge = {
        id: edgeId(reference.kind, fileNodeId(relPath), fileNodeId(target)),
        kind: reference.kind,
        from: fileNodeId(relPath),
        to: fileNodeId(target),
        provenance: "extracted",
        owner: "file",
        ownerPath: relPath,
        source: { path: relPath, line: reference.line, column: reference.column },
        attributes: { specifier: reference.specifier, ...(reference.typeOnly ? { typeOnly: "true" } : {}) },
      };
      if (!graph.edges.some(existing => existing.id === edge.id)) graph.edges.push(edge);
    }
  }

  const derived = deriveModules(graph.nodes);
  graph.nodes.push(...derived.nodes);
  graph.edges.push(...derived.edges);
  const nodeIds = new Set(graph.nodes.map(node => node.id));
  graph.edges = graph.edges.filter(edge => nodeIds.has(edge.from) && nodeIds.has(edge.to));

  // Validate the deliberately narrow internal-invariant throw surface before any defensive
  // normalization can hide a cross-kind or cross-owner collision. Same-owner symbol duplicates
  // are collapsed by extractFile, so source content cannot reach this check as a build failure.
  assertNoInternalDuplicateNodes(graph.nodes);
  graph.nodes.sort((left, right) => left.id.localeCompare(right.id));
  graph.edges.sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to) || left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id));
  const written = await writeArtifacts(graphDir, graph, manifest);

  return {
    graph,
    manifest,
    changed: written.changed,
    stats: {
      parsedFiles,
      reusedFiles,
      prunedFiles: deletedFiles,
      addedFiles,
      deletedFiles,
      synthesizedImportEdges: graph.edges.filter(edge => edge.kind === "imports" || edge.kind === "re-exports").length,
      derivedModuleCount: derived.nodes.length,
      recoveryReason: prior.ok ? null : prior.recoveryReason,
    },
  };
}
