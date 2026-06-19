import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertPluginLocalAgentsTarget,
  installBundledCeAgents,
  isPluginLocalAgentsPath,
  resolveBundledAgentsRoot,
} from "../agent-installation.js";

describe("compound engineering bundled agent-persona install", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ce-agent-install-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("installs every bundled ce-* persona def into the plugin-local target", () => {
    const targetRoot = join(tmp, "plugin-local", ".fusion-ce-agents");
    const { results } = installBundledCeAgents({ targetRoot });

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.outcome === "installed")).toBe(true);

    // Every source def lands on disk.
    const sourceDefs = readdirSync(resolveBundledAgentsRoot()).filter((f) => f.endsWith(".md"));
    for (const file of sourceDefs) {
      expect(existsSync(join(targetRoot, file))).toBe(true);
    }
    // The reviewer/research personas the CE skills fan out to are present.
    for (const id of ["ce-correctness-reviewer", "ce-repo-research-analyst", "ce-pr-comment-resolver"]) {
      expect(existsSync(join(targetRoot, `${id}.md`))).toBe(true);
    }
  });

  it("is idempotent: a second run with the target present is a skip-if-exists no-op", () => {
    const targetRoot = join(tmp, ".fusion-ce-agents");
    const first = installBundledCeAgents({ targetRoot });
    expect(first.results.every((r) => r.outcome === "installed")).toBe(true);

    const sentinelPath = join(targetRoot, "ce-correctness-reviewer.md");
    writeFileSync(sentinelPath, "SENTINEL");

    const second = installBundledCeAgents({ targetRoot });
    expect(second.results.every((r) => r.outcome === "skipped")).toBe(true);
    expect(readFileSync(sentinelPath, "utf-8")).toBe("SENTINEL");
  });

  it("refuses to install into a global client agents directory", () => {
    expect(() => assertPluginLocalAgentsTarget(join(tmp, ".claude", "agents"))).toThrow(/plugin-local/i);
    expect(isPluginLocalAgentsPath(join(tmp, ".claude", "agents"))).toBe(false);
    expect(isPluginLocalAgentsPath(join(tmp, ".fusion-ce-agents"))).toBe(true);
  });

  it("AE: never writes outside the plugin-local target when a global install exists", () => {
    const fakeHome = join(tmp, "home");
    const globalAgentsDir = join(fakeHome, ".claude", "agents");
    mkdirSync(globalAgentsDir, { recursive: true });
    const globalDef = join(globalAgentsDir, "ce-correctness-reviewer.md");
    writeFileSync(globalDef, "GLOBAL-ORIGINAL");
    const beforeMtime = statSync(globalDef).mtimeMs;

    installBundledCeAgents({ targetRoot: join(tmp, "plugin-local", ".fusion-ce-agents") });

    expect(readFileSync(globalDef, "utf-8")).toBe("GLOBAL-ORIGINAL");
    expect(statSync(globalDef).mtimeMs).toBe(beforeMtime);
  });
});
