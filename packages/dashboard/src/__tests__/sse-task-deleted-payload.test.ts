import { describe, expect, it } from "vitest";
import { stripTaskEventHeavyFields, stripTaskListHeavyFields } from "../sse";

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

  it("never broadcasts a transient release verdict in created, updated, or moved payload shapes", () => {
    const releaseGate = { promoteBlocked: false, evaluatedAt: "2026-08-13T22:02:00.000Z" };
    const task = { id: "FN-9029", log: [], releaseGate };

    expect(stripTaskListHeavyFields(task)).not.toHaveProperty("releaseGate");
    expect(stripTaskEventHeavyFields({ task, from: "todo", to: "in-progress" }).task).not.toHaveProperty("releaseGate");
  });
});
