import { describe, expect, it, vi } from "vitest";

import { extractCitedConstructs, isBugFixShape, runGhostBugPreflight } from "../triage-domain/triage-preflight.js";

describe("triage-preflight", () => {
  it("isBugFixShape matrix", () => {
    expect(isBugFixShape({ title: "fix: broken typecheck", description: "x" })).toBe(true);
    expect(isBugFixShape({ title: "chore", description: "compile error appears" })).toBe(true);
    expect(isBugFixShape({ title: "refactor", description: "cleanup" })).toBe(false);
    expect(isBugFixShape({ title: null, description: "" })).toBe(false);
  });

  it("extracts constructs and dedupes", () => {
    const prompt = [
      "Use `secrets_sync.handle()` and `foo_bar` in packages/core/src/secrets-sync.ts:12",
      "```ts",
      "import { x } from 'y'",
      "const a = b",
      "```",
      "pnpm --filter @fusion/core test",
      "pnpm --filter @fusion/core test",
    ].join("\n");

    const constructs = extractCitedConstructs(prompt);
    expect(constructs.some((c) => c.kind === "identifier" && c.raw === "secrets_sync.handle()")).toBe(true);
    expect(constructs.some((c) => c.filePath === "packages/core/src/secrets-sync.ts" && c.line === 12)).toBe(true);
    expect(constructs.some((c) => c.kind === "snippet" && c.raw.includes("import"))).toBe(true);
    expect(constructs.filter((c) => c.kind === "command")).toHaveLength(1);
  });

  it("caps extracted constructs at 20", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `\`value_${i}.x\``).join("\n");
    expect(extractCitedConstructs(lines)).toHaveLength(20);
  });

  it("archives when all definitive probes are missing", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const decision = await runGhostBugPreflight(
      { title: "fix: typecheck error", description: "desc" },
      "`foo_bar`",
      { cwd: process.cwd(), exec },
    );
    expect(decision.decision).toBe("archive");
  });

  it("passes when at least one construct matches", async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "hit", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });
    const decision = await runGhostBugPreflight(
      { title: "fix: compile error", description: "desc" },
      "`foo_bar`\n`bar_baz`",
      { cwd: process.cwd(), exec },
    );
    expect(decision.decision).toBe("pass");
  });

  it("fails open when all probes throw", async () => {
    const exec = vi.fn().mockRejectedValue(new Error("boom"));
    const decision = await runGhostBugPreflight(
      { title: "fix: regression", description: "desc" },
      "`foo_bar`",
      { cwd: process.cwd(), exec },
    );
    expect(decision.decision).toBe("pass");
  });

  it("passes non bug-shape tasks", async () => {
    const exec = vi.fn();
    const decision = await runGhostBugPreflight(
      { title: "docs", description: "desc" },
      "`foo_bar`",
      { cwd: process.cwd(), exec },
    );
    expect(decision.decision).toBe("pass");
    expect(exec).not.toHaveBeenCalled();
  });
});
