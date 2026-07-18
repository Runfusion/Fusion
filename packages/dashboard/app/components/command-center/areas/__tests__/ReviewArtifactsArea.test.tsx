import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { LIVE_DEMO_ARTIFACT_MIME_TYPE } from "@fusion/core";
import { ReviewArtifactsArea } from "../ReviewArtifactsArea";
import { useArtifacts } from "../../../../hooks/useArtifacts";

vi.mock("../../../../hooks/useArtifacts", () => ({ useArtifacts: vi.fn() }));
vi.mock("../../../ArtifactsGallery", () => ({
  ArtifactsGallery: ({ artifacts }: { artifacts: Array<{ title: string; taskId?: string }> }) => (
    <div data-testid="review-gallery" data-task-link-count={artifacts.filter((artifact) => artifact.taskId).length}>
      {artifacts.map((artifact) => artifact.title).join(",")}
    </div>
  ),
}));

const mockUseArtifacts = vi.mocked(useArtifacts);
const base = { authorId: "agent", authorType: "agent" as const, taskId: "FN-1", createdAt: "2026-07-17T00:00:00.000Z", updatedAt: "2026-07-17T00:00:00.000Z" };

describe("ReviewArtifactsArea", () => {
  it("degrades to an empty state when no video review deliverables exist", () => {
    mockUseArtifacts.mockReturnValue({ artifacts: [{ ...base, id: "doc", type: "document", title: "Descriptor" }], loading: false, error: null, refresh: vi.fn() });
    render(<ReviewArtifactsArea projectId="project-1" />);
    expect(screen.getByTestId("cc-area-review-artifacts-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("review-gallery")).not.toBeInTheDocument();
  });

  it("surfaces task-scoped videos and marked live-demo descriptors while filtering ordinary documents", () => {
    mockUseArtifacts.mockReturnValue({ artifacts: [
      { ...base, id: "video", type: "video", title: "Feature video" },
      { ...base, id: "notes", type: "document", title: "Task notes" },
      { ...base, id: "live-demo", type: "document", mimeType: LIVE_DEMO_ARTIFACT_MIME_TYPE, title: "Live-demo descriptor" },
    ], loading: false, error: null, refresh: vi.fn() });
    render(<ReviewArtifactsArea projectId="project-1" />);
    expect(screen.getByTestId("review-gallery")).toHaveTextContent("Feature video");
    expect(screen.getByTestId("review-gallery")).toHaveTextContent("Live-demo descriptor");
    expect(screen.getByTestId("review-gallery")).not.toHaveTextContent("Task notes");
    expect(screen.getByTestId("review-gallery")).toHaveAttribute("data-task-link-count", "0");
  });
});
