import { describe, expect, it } from "vitest";

import {
  extractDuplicateOfReferences,
  getTaskDuplicateLineage,
} from "../duplicates/duplicate-lineage.js";

describe("extractDuplicateOfReferences", () => {
  it("parses supported duplicate-of phrasings", () => {
    expect(extractDuplicateOfReferences("(duplicate of FN-4894)")).toEqual(["FN-4894"]);
    expect(extractDuplicateOfReferences("duplicate of FN-4894/FN-4847")).toEqual(["FN-4894", "FN-4847"]);
    expect(extractDuplicateOfReferences("dup of FN-1")).toEqual(["FN-1"]);
    expect(extractDuplicateOfReferences("Duplicates FN-2, FN-3")).toEqual(["FN-2", "FN-3"]);
  });

  it("normalizes case, dedupes and handles no-match", () => {
    expect(extractDuplicateOfReferences("duplicate of fn-7 and duplicate of FN-7")).toEqual(["FN-7"]);
    expect(extractDuplicateOfReferences("no duplicates noted")).toEqual([]);
    expect(extractDuplicateOfReferences(undefined)).toEqual([]);
  });
});

describe("getTaskDuplicateLineage", () => {
  it("orders lineage as parent, metadata, then parsed references", () => {
    expect(
      getTaskDuplicateLineage({
        id: "FN-5000",
        sourceType: "task_duplicate",
        sourceParentTaskId: "fn-10",
        sourceMetadata: { duplicateOfTaskIds: ["FN-11", "FN-10"] },
        title: "Task (duplicate of fn-12)",
        description: "duplicate of FN-13",
      }),
    ).toEqual(["FN-10", "FN-11", "FN-12", "FN-13"]);
  });

  it("filters self references and honors limit", () => {
    expect(
      getTaskDuplicateLineage(
        {
          id: "FN-42",
          sourceMetadata: { duplicateOfTaskIds: ["FN-42", "FN-43", "FN-44"] },
          title: "duplicate of FN-45",
        },
        { limit: 2 },
      ),
    ).toEqual(["FN-43", "FN-44"]);
  });

  it("ignores malformed metadata lineage payloads", () => {
    expect(
      getTaskDuplicateLineage({
        id: "FN-80",
        sourceMetadata: { duplicateOfTaskIds: "FN-81" },
        title: "duplicate of FN-82",
      }),
    ).toEqual(["FN-82"]);
  });
});
