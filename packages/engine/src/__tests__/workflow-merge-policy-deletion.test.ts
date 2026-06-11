import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PROCESSOR_PATH = resolve(__dirname, "../workflow-work-processor.ts");

describe("workflow merge policy deletion guard", () => {
  it("keeps workflow work processing isolated from the legacy ProjectEngine merge queue", () => {
    const processorSource = readFileSync(PROCESSOR_PATH, "utf8");

    expect(processorSource).toContain("claimDueWorkflowWorkItem");
    expect(processorSource).toContain("runtime.runWorkItem");
    expect(processorSource).toContain("\"merge\"");
    expect(processorSource).toContain("\"manual-hold\"");
    expect(processorSource).not.toContain("mergeQueue");
    expect(processorSource).not.toContain("enqueueMerge");
    expect(processorSource).not.toContain("ProjectEngine");
  });
});
