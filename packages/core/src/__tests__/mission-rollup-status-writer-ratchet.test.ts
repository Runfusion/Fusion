/*
FNXC:MissionStatusRollup 2026-08-13-21:59:
Automatic hierarchy rollups may only replace statuses that the hierarchy can derive. This
cheap source ratchet makes a new computed mission or milestone status writer reviewable before
it can bypass shouldApplyRecomputedStatus and clear blocked or archived operator intent.
*/
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");

function sourceRoots(base: string = REPO_ROOT): string[] {
  const roots: string[] = [];
  for (const tree of ["packages", "plugins"]) {
    try {
      for (const name of readdirSync(join(base, tree))) {
        try {
          if (statSync(join(base, tree, name, "src")).isDirectory()) roots.push(`${tree}/${name}/src`);
        } catch { /* not a source package */ }
      }
    } catch { /* optional first-party tree */ }
  }
  return roots.sort();
}

function sourceFiles(root: string, base: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (!["__tests__", "dist", "node_modules"].includes(entry)) walk(full);
      } else if (/\.tsx?$/.test(entry) && !entry.endsWith(".d.ts")) files.push(full);
    }
  };
  walk(join(base, root));
  return files;
}

function executableSource(file: string): string {
  return readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** Modules with hierarchy-derived status writes; each must retain the shared guard. */
const AUTOMATIC_GUARDED_WRITER_MODULES = [
  // Sync recomputeMissionStatus and recomputeMilestoneStatus derive hierarchy state.
  "packages/core/src/missions/mission-store.ts",
  // Async recomputes and terminal-task transaction derive hierarchy state in one transaction.
  "packages/core/src/async-stores/async-mission-store.ts",
] as const;

/** Modules whose status writes express explicit lifecycle intent rather than a rollup. */
const EXPLICIT_INTENT_WRITER_MODULES = [
  // Autopilot start/completion owns explicit lifecycle transitions; its slice cascade uses core guards.
  "packages/engine/src/missions/mission-autopilot.ts",
  // Operator/tool/dashboard PATCH and block routes deliberately own explicit intent.
  "packages/cli/src/extension.ts",
  "packages/engine/src/agent-tools.ts",
  "packages/dashboard/src/mission-routes.ts",
] as const;

const COMPUTED_STATUS_VALUE = "(?:computed\\w*|recomputed\\w*|missionStatus|milestoneStatus|newStatus)\\b";
const COMPUTED_STATUS_WRITE = new RegExp(
  String.raw`(?:update(?:Mission|Milestone)\s*\([^;\n]*?\bstatus\s*:\s*|\{\s*\.\.\.(?:mission|milestone)\s*,\s*status\s*:\s*)${COMPUTED_STATUS_VALUE}`,
);

function computedStatusWrites(source: string): number[] {
  return [...source.matchAll(new RegExp(COMPUTED_STATUS_WRITE.source, "g"))]
    .map((match) => match.index!)
    .filter((index) => index !== undefined);
}

function enclosingFunction(source: string, writeIndex: number): string {
  const declarations = [...source.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:private\s+|public\s+|protected\s+)?(?:async\s+)?(?:function\s+)?[\w$]+\s*\([^)]*\)\s*(?::[^={]+)?\{/gm)];
  for (const declaration of declarations.reverse()) {
    const brace = source.indexOf("{", declaration.index);
    let depth = 0;
    for (let index = brace; index < source.length; index++) {
      if (source[index] === "{") depth++;
      if (source[index] === "}" && --depth === 0) {
        if (writeIndex >= brace && writeIndex <= index) return source.slice(brace, index + 1);
        break;
      }
    }
  }
  return "";
}

function computedStatusWriters(roots: readonly string[] | undefined = undefined, base = REPO_ROOT): string[] {
  const hits: string[] = [];
  for (const root of roots ?? sourceRoots(base)) {
    for (const file of sourceFiles(root, base)) {
      if (computedStatusWrites(executableSource(file)).length > 0) hits.push(file.slice(base.length + 1));
    }
  }
  return hits.sort();
}

function unguardedComputedStatusWriters(roots: readonly string[] | undefined = undefined, base = REPO_ROOT): string[] {
  const hits: string[] = [];
  for (const root of roots ?? sourceRoots(base)) {
    for (const file of sourceFiles(root, base)) {
      const source = executableSource(file);
      const writesByFunction = new Map<string, number>();
      for (const index of computedStatusWrites(source)) {
        const fn = enclosingFunction(source, index);
        writesByFunction.set(fn, (writesByFunction.get(fn) ?? 0) + 1);
      }
      if ([...writesByFunction].some(([fn, writes]) => !fn || (fn.match(/shouldApplyRecomputedStatus/g)?.length ?? 0) < writes)) {
        hits.push(file.slice(base.length + 1));
      }
    }
  }
  return hits.sort();
}

describe("automatic mission and milestone rollup status writers", () => {
  it("has exactly the audited automatic writer modules, each using the shared guard", () => {
    expect(computedStatusWriters()).toEqual([...AUTOMATIC_GUARDED_WRITER_MODULES].sort());
    expect(unguardedComputedStatusWriters()).toEqual([]);
  });

  it("keeps explicit-intent modules distinct from automatic rollup ownership", () => {
    expect(EXPLICIT_INTENT_WRITER_MODULES).not.toContain("packages/core/src/missions/mission-store.ts");
    expect(EXPLICIT_INTENT_WRITER_MODULES).not.toContain("packages/core/src/async-stores/async-mission-store.ts");
  });

  describe("detector fixtures", () => {
    let fixtureRoot = "";
    const fixture = (path: string, content: string): void => {
      const full = join(fixtureRoot, path);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, content);
    };
    const newFixtureRoot = (): string => (fixtureRoot = mkdtempSync(join(tmpdir(), "fusion-mission-rollup-ratchet-")));
    afterEach(() => { if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true }); fixtureRoot = ""; });

    it("fails an unguarded computed mission status write", () => {
      const base = newFixtureRoot();
      fixture("packages/new-writer/src/writer.ts", "await updateMission(tx, { ...mission, status: computedStatus });");
      expect(unguardedComputedStatusWriters(undefined, base)).toEqual(["packages/new-writer/src/writer.ts"]);
    });

    it("accepts the same computed writer when its function applies the guard", () => {
      const base = newFixtureRoot();
      fixture("packages/guarded/src/writer.ts", "async function recompute() { if (shouldApplyRecomputedStatus(mission.status, computedStatus, OWNED)) await updateMission(tx, { ...mission, status: computedStatus }); }");
      expect(unguardedComputedStatusWriters(undefined, base)).toEqual([]);
    });

    it("fails an unguarded writer beside a guarded writer in the same function", () => {
      const base = newFixtureRoot();
      fixture("packages/mixed/src/writer.ts", "async function recompute() { if (shouldApplyRecomputedStatus(mission.status, computedStatus, OWNED)) await updateMission(tx, { ...mission, status: computedStatus }); await updateMission(tx, { ...mission, status: computedStatus }); }");
      expect(unguardedComputedStatusWriters(undefined, base)).toEqual(["packages/mixed/src/writer.ts"]);
    });

    it("does not treat an explicit blocked write as a rollup", () => {
      const base = newFixtureRoot();
      fixture("packages/intent/src/writer.ts", "await updateMission(id, { status: 'blocked' });");
      expect(computedStatusWriters(undefined, base)).toEqual([]);
    });

    it("does not treat a comment as an executable writer", () => {
      const base = newFixtureRoot();
      fixture("packages/comment/src/writer.ts", "// updateMission(id, { status: computedStatus });\nexport const value = 1;");
      expect(computedStatusWriters(undefined, base)).toEqual([]);
    });
  });
});
