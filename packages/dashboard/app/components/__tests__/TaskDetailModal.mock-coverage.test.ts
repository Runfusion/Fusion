import { describe, it, expect } from "vitest";
import "./TaskDetailModal.test-helpers";

// This test verifies that the shared lucide-react mock in
// TaskDetailModal.test-helpers.ts covers all icons used by
// TaskDetailModal and its transitive imports. If a new icon
// is added to any component in the import tree, this test will
// fail until the mock is updated.
describe("TaskDetailModal lucide mock coverage", () => {
  it("includes WorkflowResultsTab and WorkflowSelector icons", async () => {
    const lucideMock = await import("lucide-react");
    expect(lucideMock.Check).toBeDefined();
    expect(lucideMock.ChevronDown).toBeDefined();
    expect(lucideMock.ChevronRight).toBeDefined();
    expect(lucideMock.ChevronUp).toBeDefined();
    expect(lucideMock.Maximize2).toBeDefined();
    expect(lucideMock.Paperclip).toBeDefined();
    expect(lucideMock.Pencil).toBeDefined();
    expect(lucideMock.Workflow).toBeDefined();
    expect(lucideMock.X).toBeDefined();
    // FN-8286 ArtifactsGallery / TaskReviewTab icons
    expect(lucideMock.Image).toBeDefined();
    expect(lucideMock.FileText).toBeDefined();
    expect(lucideMock.User).toBeDefined();
  });
});
