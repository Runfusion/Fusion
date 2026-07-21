import { describe, expect, it } from "vitest";
import { resolveArtifactMediaPath } from "../artifact-media.js";

const store = {
  getTaskDir: (taskId: string) => `/workspace/.fusion/tasks/${taskId}`,
  getFusionDir: () => "/workspace/.fusion",
};

describe("resolveArtifactMediaPath", () => {
  it("preserves task artifact and attachment media paths", () => {
    expect(resolveArtifactMediaPath(store as never, { taskId: "FN-1", uri: "artifacts/screenshot.png" })).toBe("/workspace/.fusion/tasks/FN-1/artifacts/screenshot.png");
    expect(resolveArtifactMediaPath(store as never, { taskId: "FN-1", uri: "attachments/capture.png" })).toBe("/workspace/.fusion/tasks/FN-1/attachments/capture.png");
  });

  it("rejects traversal and absolute paths outside the artifact storage roots", () => {
    for (const uri of ["../../etc/passwd", "/etc/passwd", "other/capture.png"]) {
      expect(() => resolveArtifactMediaPath(store as never, { taskId: "FN-1", uri })).toThrow("Invalid artifact media path");
    }
  });
});
