/*
FNXC:TaskLogProjections 2026-10-10-20:58 (RUFU-615):
THE CORE TYPES ENTRY MUST STAY A BROWSER LEAF.

The dashboard's browser bundle aliases `@fusion/core` to `packages/core/src/types.ts` precisely so Node
builtins cannot be dragged into the client (`packages/dashboard/vite.config.ts` says so, and
`tasks/in-review-stall.ts`'s header repeats it). RUFU-615 broke exactly that with one well-meaning line:
the write-time projection module needed the `[timing]` sum rule, which lived in
`task-store/serialization.ts`, which imports `node:crypto`. One hop, and `types.ts` reached a Node
builtin through `settings-schema -> in-review-stall -> task-log-projections -> serialization`.

Nothing in `pnpm test` noticed. The failure surfaced only as a `vite build` error —
`"createHash" is not exported by "__vite-browser-external"` — which is the CI build step, i.e. minutes
to hours after the change rather than at the commit. This test moves that feedback to the unit lane:
it walks the value-import graph from the entry that ships to the browser and refuses any reachable
module that imports a Node builtin.

The walk follows RUNTIME edges only: a `import type` / `export type` specifier emits nothing, so the
bundler cannot follow it either, and the graph does already reach Node-tainted modules through
type-only re-export barrels (`config/mcp-config.ts -> plugins/plugin-types.ts -> store.ts`), which a
client never value-imports. Today the runtime graph is 49 modules with zero offenders, so the ratchet
is tight rather than aspirational.
*/

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CORE_SRC = fileURLToPath(new URL("../", import.meta.url));
const ENTRY = resolve(CORE_SRC, "types.ts");

/** Import specifiers that cannot exist in a browser bundle. Bare `fs`/`path` are the legacy spellings. */
const NODE_ONLY = /^node:/;
const NODE_LEGACY = new Set(["fs", "path", "crypto", "os", "child_process", "net", "http", "https", "util", "url", "worker_threads", "stream", "events", "sqlite3", "better-sqlite3", "pg"]);

interface Edge {
  specifier: string;
  resolved: string | null;
}

/**
 * Every import or barrel re-export that emits a RUNTIME edge. `types.ts` is a barrel, so scanning only
 * `import` statements would walk to it and stop — exactly how a guard like this looks green while
 * proving nothing. Edges whose whole clause is type-only are dropped, for the reason in the header.
 */
function importEdges(file: string): Edge[] {
  const src = readFileSync(file, "utf8");
  const edges: Edge[] = [];
  for (const match of src.matchAll(/(?:^|\n)\s*(import|export)\s+(type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/g)) {
    const [, keyword, typeKeyword, rawClause, specifier] = match;
    if (keyword === undefined || specifier === undefined) continue;
    if (typeKeyword !== undefined) continue;
    const clause = rawClause?.trim() ?? "";
    const named = clause.match(/^\{([\s\S]*)\}$/);
    if (named) {
      const parts = named[1]!.split(",").map((part) => part.trim()).filter(Boolean);
      if (parts.length === 0) continue;
      if (parts.every((part) => part.startsWith("type "))) continue;
    }
    if (/^type\s/.test(clause)) continue;
    edges.push({ specifier, resolved: resolveRelative(file, specifier) });
  }
  return edges;
}

function resolveRelative(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  // Core source spells its own imports with `.js` extensions that do not exist on disk; TypeScript and
  // Vite both rewrite them to `.ts`, so the walk has to make the same substitution or it walks nothing.
  const base = resolve(dirname(fromFile), specifier.replace(/\.js$/, ""));
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, resolve(base, "index.ts")]) {
    if (existsSync(candidate) && candidate.endsWith(".ts")) return candidate;
  }
  return null;
}

describe("core types entry stays free of Node builtins for the dashboard browser bundle", () => {
  it("no module reachable from types.ts imports a Node builtin", () => {
    const previous = new Map<string, string | null>([[ENTRY, null]]);
    expect(existsSync(ENTRY), `${ENTRY} is the module the browser aliases; it must exist`).toBe(true);
    const queue: string[] = [ENTRY];
    const violations: string[] = [];

    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const edge of importEdges(current)) {
        if (NODE_ONLY.test(edge.specifier) || NODE_LEGACY.has(edge.specifier)) {
          const chain: string[] = [`${current.replace(CORE_SRC, "")} -> ${edge.specifier}`];
          let walker: string | null | undefined = current;
          while (walker) {
            chain.push(walker.replace(CORE_SRC, ""));
            walker = previous.get(walker) ?? null;
          }
          violations.push(chain.reverse().join(" -> "));
        }
        if (!edge.resolved || previous.has(edge.resolved)) continue;
        previous.set(edge.resolved, current);
        queue.push(edge.resolved);
      }
    }

    // A green run should say something about the size of what it just proved, or the next author
    // cannot tell a tight ratchet from a walk that reached nothing.
    expect(previous.size, "the walk from types.ts reached only the entry, so it proves nothing").toBeGreaterThan(20);
    expect(
      violations,
      "Node builtins are reachable from packages/core/src/types.ts, which the dashboard browser bundle "
        + "aliases as `@fusion/core`. Move the shared logic into a browser-safe leaf (see "
        + "`packages/core/src/tasks/log-timing.ts` for the pattern RUFU-615 used) rather than widening "
        + "the alias.\n" + violations.join("\n"),
    ).toEqual([]);
  });

  /*
  FNXC:TaskLogProjections 2026-10-10-21:08 (RUFU-615):
  The direct half of the same invariant, and the half that actually catches this regression. The entry
  walk above follows the runtime graph from `types.ts`, and RUFU-615's bad edge sat one hop behind a
  type-only import the bundler-approximating walk declines to follow — while `vite build` still failed.
  So the entry walk alone is a ratchet, not a proof. What IS a proof for these modules is asking about
  them directly: the log-signal leaf modules the dashboard's stall copy depends on must reach nothing
  Node-only themselves, at any depth. With `task-log-projections.ts` importing `task-store/serialization`
  this list is 9 entries deep in `node:crypto`, `node:fs`, and the SQLite driver; today it is empty over
  22 reachable modules.
  */
  const BROWSER_SAFE_LEAVES = [
    "tasks/log-timing.ts",
    "task-store/task-log-projections.ts",
    "tasks/in-review-stall.ts",
    "tasks/in-review-stalled.ts",
    "tasks/stalled-review-detector.ts",
  ];

  it("the log-signal leaf modules stay free of Node builtins at any depth", () => {
    const seeds = BROWSER_SAFE_LEAVES.map((rel) => resolve(CORE_SRC, rel));
    for (const seed of seeds) expect(existsSync(seed), `${seed} must exist for this guard to mean anything`).toBe(true);

    const previous = new Map<string, string | null>(seeds.map((seed) => [seed, null]));
    const queue: string[] = [...seeds];
    const violations: string[] = [];

    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const edge of importEdges(current)) {
        if (NODE_ONLY.test(edge.specifier) || NODE_LEGACY.has(edge.specifier)) {
          const chain: string[] = [`${current.replace(CORE_SRC, "")} -> ${edge.specifier}`];
          let walker: string | null | undefined = current;
          while (walker) {
            chain.push(walker.replace(CORE_SRC, ""));
            walker = previous.get(walker) ?? null;
          }
          violations.push(chain.reverse().join(" -> "));
        }
        if (!edge.resolved || previous.has(edge.resolved)) continue;
        previous.set(edge.resolved, current);
        queue.push(edge.resolved);
      }
    }

    expect(
      violations,
      "a browser-safe log-signal leaf reaches a Node builtin. RUFU-615 hit exactly this: the `[timing]` "
        + "rule lived in `task-store/serialization.ts`, which imports `node:crypto`, and moving the rule "
        + "to `tasks/log-timing.ts` (a pure leaf) is the fix pattern.\n" + [...new Set(violations)].join("\n"),
    ).toEqual([]);
  });
});
