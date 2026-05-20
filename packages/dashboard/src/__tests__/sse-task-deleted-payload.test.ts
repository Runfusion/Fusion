import { describe, expect, it } from "vitest";
import { stripTaskListHeavyFields } from "../sse";

describe("stripTaskListHeavyFields", () => {
  it("preserves deletedAt on slim SSE payloads", () => {
    const payload = {
      id: "FN-123",
      title: "soft deleted task",
      deletedAt: "2026-05-19T00:00:00.000Z",
      log: [{ action: "[timing] step in 5ms" }],
    };

    const slimmed = stripTaskListHeavyFields(payload);

    expect(slimmed.deletedAt).toBe("2026-05-19T00:00:00.000Z");
  });
});
