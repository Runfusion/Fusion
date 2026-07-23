import { describe, expect, it } from "vitest";
import {
  FUSION_TASK_LINEAGE_TRAILER_KEY,
  buildTaskLineageTrailer,
  classifyTaskCommitAssociationConfidence,
  generateTaskLineageId,
  parseTaskLineageTrailer,
} from "../tasks/task-lineage.js";

describe("task-lineage", () => {
  it("generates UUID lineage ids", () => {
    const id = generateTaskLineageId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it("round-trips canonical trailer", () => {
    const lineageId = generateTaskLineageId();
    const trailer = buildTaskLineageTrailer(lineageId);
    expect(trailer).toBe(`${FUSION_TASK_LINEAGE_TRAILER_KEY}: ${lineageId}`);
    expect(parseTaskLineageTrailer(`subject\n\n${trailer}\n`)).toBe(lineageId);
  });

  it("classifies match confidence", () => {
    expect(classifyTaskCommitAssociationConfidence("canonical-lineage-trailer")).toBe("canonical");
    expect(classifyTaskCommitAssociationConfidence("legacy-task-id-trailer")).toBe("legacy");
    expect(classifyTaskCommitAssociationConfidence("manual-reconciliation")).toBe("ambiguous");
  });
});
