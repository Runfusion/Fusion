import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("bin pr router wiring", () => {
  const source = readFileSync(resolve(__dirname, "../bin.ts"), "utf8");

  it("dispatches the full pr noun to commands/pr.js", () => {
    expect(source).toContain('case "pr":');
    expect(source).toContain('case "create":');
    expect(source).toContain("runPrCreate(id, parsePrCreateOptions(args.slice(3)), projectName)");
    expect(source).toContain('await import("../commands/pr.js")');
  });

  it("parses draft/no-ai/reviewer flags for pr create", () => {
    expect(source).toContain('const draft = args.includes("--draft")');
    expect(source).toContain('const ai = !args.includes("--no-ai")');
    expect(source).toContain('args[i] === "--reviewer"');
  });

  it("retires the per-task pr-create command", () => {
    expect(source).not.toContain('case "pr-create":');
    expect(source).not.toContain("runTaskPrCreate");
  });
});
