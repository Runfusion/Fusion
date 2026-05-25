import { describe, expect, it } from "vitest";
import { detectDanglingTaskDocReferences, formatDanglingDiagnostic } from "../spec-validation/task-document-references.js";

describe("detectDanglingTaskDocReferences", () => {
  it("flags FN-5110-style missing artifact references", async () => {
    const prompt = "## Context to Read First\n- `.fusion/tasks/FN-5110/failure-inventory.md`\n\n## Steps\n### Step 0: Preflight\n- Read .fusion/tasks/FN-5110/failure-inventory.md\n\n### Step 4: Verify\n- Use (.fusion/tasks/FN-5110/failure-inventory.md)\n\n### Step 5: Delivery\n- Final check: `.fusion/tasks/FN-5110/failure-inventory.md`";
    const refs = await detectDanglingTaskDocReferences(prompt, {
      rootDir: "/tmp/project",
      taskId: "FN-5112",
      existsImpl: async () => false,
    });

    expect(refs).toEqual([
      {
        path: ".fusion/tasks/FN-5110/failure-inventory.md",
        sections: ["Context to Read First", "Step 0", "Step 4", "Step 5", "Steps"],
      },
    ]);
  });

  it("ignores sibling PROMPT.md and task.json references", async () => {
    const prompt = `## Context to Read First\n- .fusion/tasks/FN-9999/PROMPT.md\n- .fusion/tasks/FN-9999/task.json`;
    const refs = await detectDanglingTaskDocReferences(prompt, {
      rootDir: "/tmp/project",
      taskId: "FN-5112",
      existsImpl: async () => false,
    });
    expect(refs).toEqual([]);
  });

  it("does not flag (new) artifacts", async () => {
    const prompt = "## Steps\n### Step 1: Create inventory\n- Read .fusion/tasks/FN-5112/failure-inventory.md\n\n**Artifacts:**\n- `.fusion/tasks/FN-5112/failure-inventory.md` (new)";
    const refs = await detectDanglingTaskDocReferences(prompt, {
      rootDir: "/tmp/project",
      taskId: "FN-5112",
      existsImpl: async () => false,
    });
    expect(refs).toEqual([]);
  });

  it("does not flag paths listed in file scope", async () => {
    const prompt = "## File Scope\n- `.fusion/tasks/FN-5112/failure-inventory.md`\n\n## Steps\n### Step 1: Read\n- .fusion/tasks/FN-5112/failure-inventory.md";
    const refs = await detectDanglingTaskDocReferences(prompt, {
      rootDir: "/tmp/project",
      taskId: "FN-5112",
      existsImpl: async () => false,
    });
    expect(refs).toEqual([]);
  });

  it("returns empty when all candidates exist", async () => {
    const prompt = `## Steps\n### Step 1: Read\n- .fusion/tasks/FN-9999/notes.md`;
    const refs = await detectDanglingTaskDocReferences(prompt, {
      rootDir: "/tmp/project",
      taskId: "FN-5112",
      existsImpl: async () => true,
    });
    expect(refs).toEqual([]);
  });

  it("parses wrapped and punctuated path tokens", async () => {
    const prompt = "## Steps\n### Step 1: Parse\n- (`.fusion/tasks/FN-9999/notes%20encoded.md`),\n- '.fusion/tasks/FN-9999/path(with)-parens.md'.";

    const refs = await detectDanglingTaskDocReferences(prompt, {
      rootDir: "/tmp/project",
      taskId: "FN-5112",
      existsImpl: async () => false,
    });

    expect(refs.map((r) => r.path)).toEqual([
      ".fusion/tasks/FN-9999/notes%20encoded.md",
      ".fusion/tasks/FN-9999/path(with)-parens.md",
    ]);
  });

  it("formats revise diagnostics", async () => {
    const formatted = formatDanglingDiagnostic([
      { path: ".fusion/tasks/FN-5110/failure-inventory.md", sections: ["Step 0", "Step 4", "Step 5"] },
    ]);
    expect(formatted).toContain("REVISE — Dangling task-document references");
    expect(formatted).toContain("Step 0, Step 4, Step 5");
  });
});
