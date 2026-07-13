import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MailboxArtifactAttachment } from "../MailboxArtifactAttachment";
import { artifactMediaUrl } from "../../api";

vi.mock("../../api", () => ({
  artifactMediaUrl: vi.fn((id: string, projectId?: string) => `/api/artifacts/${id}/media${projectId ? `?projectId=${projectId}` : ""}`),
}));

const mockArtifactMediaUrl = vi.mocked(artifactMediaUrl);

describe("MailboxArtifactAttachment", () => {
  it("renders image artifacts inline with the project-scoped media URL", () => {
    render(
      <MailboxArtifactAttachment
        artifactId="art-image"
        artifactType="image"
        title="Screenshot"
        mimeType="image/png"
        projectId="proj-1"
      />,
    );

    expect(mockArtifactMediaUrl).toHaveBeenCalledWith("art-image", "proj-1");
    const image = screen.getByRole("img", { name: "Screenshot" });
    expect(image).toHaveAttribute("src", "/api/artifacts/art-image/media?projectId=proj-1");
    expect(screen.getByRole("link", { name: "Open artifact: Screenshot" })).toHaveAttribute("href", "/api/artifacts/art-image/media?projectId=proj-1");
  });

  it("renders a View task affordance when task metadata and a handler are present", () => {
    const onOpenTask = vi.fn();
    render(
      <MailboxArtifactAttachment
        artifactId="art-image"
        artifactType="image"
        title="Screenshot"
        taskId="FN-1234"
        onOpenTask={onOpenTask}
      />,
    );

    fireEvent.click(screen.getByTestId("mailbox-artifact-view-task"));

    expect(screen.getByRole("button", { name: "View task: FN-1234" })).toHaveTextContent("View task");
    expect(onOpenTask).toHaveBeenCalledWith("FN-1234");
  });

  it("does not render a View task affordance without an open-task handler", () => {
    render(<MailboxArtifactAttachment artifactId="art-image" artifactType="image" title="Screenshot" taskId="FN-1234" />);

    expect(screen.queryByTestId("mailbox-artifact-view-task")).toBeNull();
    expect(screen.getByRole("link", { name: "Open artifact: Screenshot" })).toBeInTheDocument();
  });

  it("does not render a View task affordance without task metadata", () => {
    render(<MailboxArtifactAttachment artifactId="art-image" artifactType="image" title="Screenshot" onOpenTask={vi.fn()} />);

    expect(screen.queryByTestId("mailbox-artifact-view-task")).toBeNull();
    expect(screen.getByRole("link", { name: "Open artifact: Screenshot" })).toBeInTheDocument();
  });

  it.each([
    ["document", "Spec"],
    ["other", "Archive"],
  ])("renders an open link for %s artifacts", (artifactType, title) => {
    render(<MailboxArtifactAttachment artifactId={`art-${artifactType}`} artifactType={artifactType} title={title} />);

    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByRole("link", { name: `Open artifact: ${title}` })).toHaveAttribute("href", `/api/artifacts/art-${artifactType}/media`);
  });

  it("renders controls media and an open link for video and audio artifacts", () => {
    const { rerender, container } = render(<MailboxArtifactAttachment artifactId="art-video" artifactType="video" title="Clip" />);
    expect(container.querySelector("video[controls]")).toHaveAttribute("src", "/api/artifacts/art-video/media");
    expect(screen.getByRole("link", { name: "Open artifact: Clip" })).toHaveAttribute("href", "/api/artifacts/art-video/media");

    rerender(<MailboxArtifactAttachment artifactId="art-audio" artifactType="audio" title="Recording" />);
    expect(container.querySelector("audio[controls]")).toHaveAttribute("src", "/api/artifacts/art-audio/media");
    expect(screen.getByRole("link", { name: "Open artifact: Recording" })).toHaveAttribute("href", "/api/artifacts/art-audio/media");
  });

  it("renders nothing when artifactId metadata is missing", () => {
    const { container } = render(<MailboxArtifactAttachment artifactType="image" title="No id" />);

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId("mailbox-artifact-attachment")).toBeNull();
  });

  it("degrades image load failures to the open artifact link", () => {
    render(<MailboxArtifactAttachment artifactId="art-broken" artifactType="image" title="Broken screenshot" taskId="FN-1234" onOpenTask={vi.fn()} />);

    fireEvent.error(screen.getByRole("img", { name: "Broken screenshot" }));

    expect(screen.queryByRole("img", { name: "Broken screenshot" })).toBeNull();
    expect(screen.getByRole("link", { name: "Open artifact: Broken screenshot" })).toHaveAttribute("href", "/api/artifacts/art-broken/media");
    expect(screen.getByTestId("mailbox-artifact-view-task")).toBeInTheDocument();
  });
});
