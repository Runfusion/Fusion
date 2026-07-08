#!/usr/bin/env node
/**
 * FNXC:EngineTests 2026-07-08-04:10:
 * FN-7669 prototypes the #1 lever FN-7668 ranked: the `engine-core` merge
 * gate's dominant, precisely-quantified wall-time cost is vitest/Vite's
 * `import`-phase (SSR module-graph resolution + evaluation across the
 * ~430-file/215.8K-line production closure the 18 curated gate files reach
 * via the full `@fusion/core` barrel). Each of the 18 `pool:"forks"` OS
 * processes independently rebuilds this whole module graph from scratch with
 * NO cross-fork sharing. This script esbuild-bundles that closure — starting
 * from the FN-7667 gate-safe barrel copy (`packages/core/src/index.gate.ts`,
 * NOT the full `index.ts`, so this composes with FN-7667's narrowing rather
 * than working against it) — into a single first-party ESM file, collapsing
 * ~430 per-fork Vite SSR module-loader round-trips into one file load per
 * fork.
 *
 * Invalidation model: REBUILD-EVERY-RUN (the preferred, simplest, provably-
 * current design per the task spec). This script is invoked from the
 * `engine-core` vitest project's `globalSetup` before any of the 18 forks
 * spawn, so the bundle is (re)emitted fresh on every gate invocation — there
 * is NO drift surface, and no hand-maintained file/symbol list is ever
 * consulted (esbuild's own dependency graph, captured in a `metafile`,
 * enumerates every input file that fed the bundle; that metafile is written
 * next to the bundle for the coverage-parity / metafile-derived module-count
 * proof, see the task's `docs` document). Bundling a ~430-file first-party
 * closure with esbuild is typically sub-second — cheap enough that a
 * content-hash cache (this script's own alternative design) is unnecessary.
 *
 * Output is written under `packages/engine/node_modules/.gate-bundle/`,
 * which is gitignored: this is a rebuilt-every-run, non-committed artifact,
 * never a checked-in build output.
 */

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

// FNXC:EngineTests 2026-07-08-04:10:
// The bundle entrypoint is the FN-7667 gate-safe barrel copy
// (index.gate.ts), not the full index.ts barrel — this prototype composes
// with the existing gate-narrowing, it does not re-widen it.
export const CORE_GATE_ENTRYPOINT = resolve(REPO_ROOT, "packages/core/src/index.gate.ts");
// FNXC:EngineTests 2026-07-08-05:10:
// Output lives at packages/core/.gate-bundle/ — a SIBLING of
// packages/core/node_modules/, deliberately NOT nested inside it. Two
// empirically-discovered constraints pin this exact placement:
//
// 1. Third-party bare-specifier resolution (e.g. bonjour-service, used by
//    node-discovery.ts and left `external` by esbuild's packages:"external"):
//    Node/Vite SSR resolves bare specifiers by walking UP the node_modules
//    chain from the importing file's own physical location. From
//    packages/core/.gate-bundle/core.mjs, that walk reaches
//    packages/core/node_modules on the very first step — same as it would
//    from any other file directly under packages/core/src/. A placement
//    under packages/engine/node_modules/ 404s on anything only core (not
//    engine) depends on (verified via a standalone `node --input-type=module
//    -e 'await import(...)'` check that threw ERR_MODULE_NOT_FOUND for
//    'bonjour-service').
//
// 2. Vite SSR external-dep heuristic (the more serious constraint, found via
//    a real coverage-parity break): Vite's SSR module loader externalizes
//    (loads via Node's native import, OUTSIDE its own transform+mock
//    pipeline) any resolved module path containing a `node_modules` segment
//    by default. A first attempt that placed the bundle at
//    packages/core/node_modules/.gate-bundle/core.mjs was silently
//    externalized this way — vi.mock("node:child_process", ...) in the gate
//    test files stopped intercepting the `node:child_process` import nested
//    inside the bundled process-supervisor.ts (superviseSpawn), because Vite
//    handed that whole externalized bundle to Node's real loader instead of
//    its own mock-aware SSR graph. Symptom: 60/335 gate tests failed with
//    "spawned child without pid" / "Deterministic test verification failed"
//    (the REAL node:child_process ran instead of the test's mock). Moving
//    the bundle to a node_modules-free path keeps it inside Vite's normal
//    (non-externalized, mock-interceptable) SSR pipeline while still
//    resolving third-party deps correctly per point 1. See the task's docs
//    document "vi.mock risk check" section for the full repro.
export const GATE_BUNDLE_OUTDIR = resolve(REPO_ROOT, "packages/core/.gate-bundle");
export const CORE_GATE_BUNDLE_OUTFILE = resolve(GATE_BUNDLE_OUTDIR, "core.mjs");
export const CORE_GATE_BUNDLE_METAFILE = resolve(GATE_BUNDLE_OUTDIR, "core.meta.json");

/**
 * Bundle the `@fusion/core` gate-safe barrel closure into a single ESM file.
 *
 * Bundles ONLY the first-party closure reached transitively from the
 * entrypoint via relative imports — every `node:*` builtin and every
 * third-party npm package is marked `external` via esbuild's `packages:
 * "external"` (bare-specifier imports resolve to `node_modules` and are left
 * as external `import` statements; only relative/absolute-path imports,
 * which is how the entire `@fusion/core` production closure is wired, get
 * inlined into the bundle). This means `node:sqlite` (used by
 * `sqlite-adapter.ts`, a Node 22+ built-in per FN-7668, not an npm native
 * addon) is correctly left as a runtime `import "node:sqlite"` rather than
 * mis-bundled.
 *
 * Returns the esbuild `metafile`, whose `inputs` map is the provably-
 * complete (esbuild-graph-derived, not hand-maintained) enumeration of every
 * first-party file that fed the bundle — this is both the invalidation
 * dependency set (were this the content-hash-cache design) and the ~430→1
 * module-load-count proof cited in the task's `docs` document.
 */
export async function buildCoreGateBundle({ silent = false } = {}) {
  mkdirSync(GATE_BUNDLE_OUTDIR, { recursive: true });

  const result = await build({
    entryPoints: [CORE_GATE_ENTRYPOINT],
    outfile: CORE_GATE_BUNDLE_OUTFILE,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    // FNXC:EngineTests 2026-07-08-04:10:
    // packages:"external" marks every bare-specifier import (npm packages,
    // including any node:* builtin reached via a bare specifier) as
    // external, so ONLY the first-party relative-import closure is inlined.
    // This is the "do not re-bundle node_modules" requirement from the task
    // spec, enforced structurally rather than via a hand-maintained
    // external list.
    packages: "external",
    sourcemap: false,
    // Preserve module-level side effects (e.g. singleton registration) —
    // this bundle must behave identically to importing index.gate.ts
    // directly for the 18 gate files' purposes, not be tree-shaken to a
    // used-symbols subset (which could silently drop side-effecting
    // initialization code even if all consumed exports still resolve).
    treeShaking: false,
    metafile: true,
    logLevel: silent ? "silent" : "info",
  });

  writeFileSync(CORE_GATE_BUNDLE_METAFILE, JSON.stringify(result.metafile, null, 2));

  return result.metafile;
}

/**
 * FNXC:EngineTests 2026-07-08-04:45:
 * Vitest `globalSetup` module contract: a module in the `globalSetup` array
 * may export a `setup()` function, called once before any test file/fork in
 * the project runs. This is the REBUILD-EVERY-RUN hook point: wiring this
 * same builder module directly into the `engine-core` project's
 * `globalSetup` array (packages/engine/vitest.config.ts) means the bundle is
 * (re)built exactly once per gate invocation, before any of the 18 forks
 * spawn and read the `resolve.alias` that points at its output file — so
 * every fork sees a bundle that is provably current for that run, with zero
 * possibility of drift between builds (there is no persisted state to go
 * stale). No `teardown()` export: the bundle output is a disposable,
 * gitignored artifact that does not need cleanup between runs (the next
 * `setup()` overwrites it).
 */
export async function setup() {
  const started = Date.now();
  const metafile = await buildCoreGateBundle({ silent: true });
  const elapsedMs = Date.now() - started;
  const inputCount = Object.keys(metafile.inputs).length;
  console.log(
    `[engine-core gate bundle] rebuilt ${CORE_GATE_BUNDLE_OUTFILE} from ${inputCount} first-party inputs in ${elapsedMs}ms`,
  );
}

// Allow direct invocation for manual measurement / debugging:
//   node scripts/build-engine-core-gate-bundle.mjs
if (import.meta.url === `file://${process.argv[1]}`) {
  const started = Date.now();
  const metafile = await buildCoreGateBundle();
  const elapsedMs = Date.now() - started;
  const inputCount = Object.keys(metafile.inputs).length;
  console.log(
    `[build-engine-core-gate-bundle] built ${CORE_GATE_BUNDLE_OUTFILE} from ${inputCount} first-party inputs in ${elapsedMs}ms`,
  );
}
