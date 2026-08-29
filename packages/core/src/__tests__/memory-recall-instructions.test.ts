import { describe, expect, it } from "vitest";
import {
  buildExecutionMemoryInstructions,
  buildReviewerMemoryInstructions,
  buildTriageMemoryInstructions,
} from "../memory/project-memory.js";
import {
  formatRecallInstructionSection,
  MAX_RECALL_INJECTION_BYTES,
} from "../memory/recall/recall-instructions.js";
import type { RecallSearchHit } from "../memory/recall/recall-types.js";

const settings = [
  { memoryBackendType: "file" },
  { memoryBackendType: "qmd" },
  { memoryBackendType: "readonly" },
] as const;
const hits: RecallSearchHit[] = Array.from({ length: 200 }, (_, index) => ({
  score: index,
  matchedTerms: [],
  record: {
    id: String(index), projectId: "p", kind: "decision",
    content: `決定 ${"🌱".repeat(100)}`, contentHash: String(index),
    source: { origin: "manual" }, tags: [], graphNodeIds: [],
    createdAt: "2026-01-01", updatedAt: "2026-01-01",
  },
}));

const builders = [
  buildTriageMemoryInstructions,
  buildExecutionMemoryInstructions,
  buildReviewerMemoryInstructions,
] as const;

describe("recall instruction injection", () => {
  it("preserves every existing builder output when recall is omitted", () => {
    for (const builder of builders) {
      for (const backend of settings) {
        expect(builder("/tmp", backend)).toBe(builder("/tmp", backend, undefined));
      }
      expect(builder("/tmp", { memoryEnabled: false })).toBe("");
      expect(builder("/tmp", { memoryEnabled: false }, hits)).toBe("");
    }
  });

  it("bounds only appended recall context without splitting UTF-8", () => {
    const section = formatRecallInstructionSection(hits);
    expect(section).toContain("### Recalled Context");
    expect(Buffer.byteLength(section, "utf8")).toBeLessThanOrEqual(MAX_RECALL_INJECTION_BYTES);
    expect(Buffer.from(section, "utf8").toString("utf8")).toBe(section);
    expect(section).not.toContain("\uFFFD");

    for (const builder of builders) {
      const baseline = builder("/tmp", { memoryBackendType: "file" });
      const withRecall = builder("/tmp", { memoryBackendType: "file" }, hits);
      expect(withRecall).toContain(baseline);
      expect(Buffer.byteLength(withRecall, "utf8") - Buffer.byteLength(baseline, "utf8"))
        .toBeLessThanOrEqual(MAX_RECALL_INJECTION_BYTES);
      expect(withRecall).toContain("### Recalled Context");
    }
  });
});
