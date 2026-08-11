[← Docs index](./README.md)

# Knowledge graph

`fn knowledge-graph build` creates a deterministic, committable structure graph for the FN-8920 memory epic. It is the embedding-free first layer: no LLM, vector recall, MCP API, inferred relationships, or capability bundle is included.

## Artifact and configuration

The default `knowledgeGraphDir` is `.fusion-knowledge/graph`, deliberately outside ignored `.fusion/`. It contains `nodes.json`, `edges.json`, and `manifest.json`; all use sorted, LF JSON. Nodes and edges are written before the manifest so a torn write safely triggers a full rebuild. The manifest records SHA-256 fingerprints and import references, enabling changed files only to be re-extracted and deleted file ownership to be pruned.

The artifact is not committed. As of 2026-08-10 `.fusion-knowledge/` is gitignored: the graph is deterministic and fully regenerable from source (the manifest's SHA-256 fingerprints drive incremental rebuilds), so tracking it preserves nothing a rebuild cannot reproduce, while costing ~85MB of irreversible, compounding history bloat on every clone and CI checkout — `edges.json` alone is 43MB, past GitHub's 50MB warning threshold. Regenerate it with `fn knowledge-graph build` rather than pulling it.

An operator who explicitly wants a snapshot in history can still force one with `git add -f .fusion-knowledge/graph`; prefer a rebuild.

## Model

Nodes are `file`, `module`, `symbol`, `doc-concept`, or `rationale`. Edges are `contains`, `imports`, and `re-exports`, and always include source, owner (`file` or `derived`), and provenance (`extracted` or reserved `inferred`). IDs are path-derived (`file:path`, `module:dir`, `symbol:path#name`, `doc:path#slug~index`, and `rationale:path#area@stamp~index`) with reserved separators percent-escaped.

TypeScript/TSX parsing is parser-only. Exported declarations become symbols; duplicate exports collapse to one earliest-position node with `declarationCount`, including invalid source. Syntax errors remain best-effort. `export *` records a re-export relationship but cannot expand names without a checker. Relative imports are resolved lexically using `.ts`, `.tsx`, and index candidates; package and tsconfig aliases are out of scope.

Discovery includes package `src`, package scripts, `scripts`, plugins, docs, root policy documents, and `packages/dashboard/app`, whose UI is outside `src`. Modules are derived from direct TypeScript files every build. `queryNodes`, `neighbors`, and `shortestPath` expose the in-process API and retain complete edge provenance.

FNXC rationale comes from TypeScript parser comment ranges and markdown HTML comments. Markdown fenced/indented code cannot open a rationale comment; once opened, a comment continues through indentation. Multiple stamped headers in one comment produce separate rationale nodes.

## Extraction and recovery contract

The dispatcher creates exactly one file node per discovered file. TypeScript and TSX are parsed with the TypeScript parser only; malformed source remains best-effort and never blocks a build. Symbol identity uses the exported name. Legal declaration merges and invalid redeclarations use the same deterministic collapse: the first source location and attributes win, while `declarationCount` and (when needed) `symbolKinds` preserve the fact of the collision. The only graph errors are invalid caller paths, an impossible internal cross-kind/owner collision, and artifact I/O failures.

File-owned facts are replaced only when that file hash changes. Module nodes and module containment are derived from the final file set every build. Import references are persisted in the manifest and import/re-export edges are synthesized every build, so adding or deleting a target never requires parsing an unchanged importer. Relative resolution tries `.ts`, `.tsx`, then index candidates; it intentionally does not resolve aliases, packages, or expand `export *` names.

Every real source position is recorded as a repository-relative path, line, and column. File and module-derived items use a `syntheticSource: "true"` attribute and a 1:1 anchor. Artifact payloads contain only content-derived values (including source FNXC stamps and hashes), never build time, host, or process metadata. Missing, malformed, mismatched, or inconsistent artifact files trigger a safe full rebuild; artifacts are written nodes, edges, then manifest so a torn write cannot validate incomplete output.

## FNXC and query behavior

FNXC rationale is first-class data. TypeScript-family comment ranges come from the parsed tree, not a raw scanner, which prevents strings, regexes, template text, and JSX text from becoming rationale. Markdown recognizes HTML comments outside fenced or narrowly defined indented code; code state gates the comment opener only, so an already-open multi-header comment is not truncated by indentation. Each stamped header starts a separate rationale node and runs to the next header in its comment.

`queryNodes(filter)`, `neighbors(id, options)`, and `shortestPath(from, to)` are deterministic in-process APIs. Neighbor and path results retain complete edge objects, including source, ownership, and `extracted` provenance. `inferred` is reserved in the schema for the later memory-agent layer and is not emitted by this layer.

## Non-goals

This layer has no LLM calls, embeddings, vector recall, MCP tools, source-validity diagnostics, language support beyond TypeScript/TSX symbols, CommonMark parser, cross-rename identity, or capability-fabric bundle. The FR-29/FR-34 bundle format is deferred.
