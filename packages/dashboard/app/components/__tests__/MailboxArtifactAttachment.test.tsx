import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MailboxArtifactAttachment } from "../MailboxArtifactAttachment";
import { artifactMediaUrlWithToken } from "../../api";

const { mockArtifactImageViewer } = vi.hoisted(() => ({ mockArtifactImageViewer: vi.fn() }));

vi.mock("../../api", () => ({
  artifactMediaUrlWithToken: vi.fn((id: string, projectId?: string) => `/api/artifacts/${id}/media${projectId ? `?projectId=${projectId}&` : "?"}fn_token=daemon-token`),
}));

vi.mock("../ArtifactImageViewer", () => ({
  ArtifactImage: ({ title, onError }: { title: string; onError?: () => void }) => <img alt={title} src="blob:secure-preview" onError={onError} />,
  ArtifactImageViewer: (props: { artifactId: string; projectId?: string; title: string; onClose: () => void }) => {
    mockArtifactImageViewer(props);
    return <div role="dialog"><img alt={props.title} src="blob:secure-preview" /><button type="button" aria-label="Close image artifact preview" onClick={props.onClose}>Close</button></div>;
  },
}));

const mockArtifactMediaUrlWithToken = vi.mocked(artifactMediaUrlWithToken);

describe("MailboxArtifactAttachment", () => {
  beforeEach(() => {
    cleanup();
    mockArtifactMediaUrlWithToken.mockClear();
    mockArtifactImageViewer.mockClear();
  });
  afterEach(() => cleanup());

  it("renders image artifacts through a blob preview and viewer without a tokenized link", () => {
    render(
      <MailboxArtifactAttachment
        artifactId="art-image"
        artifactType="image"
        title="Screenshot"
        mimeType="image/png"
        projectId="proj-1"
      />,
    );

    expect(mockArtifactMediaUrlWithToken).not.toHaveBeenCalledWith("art-image", "proj-1");
    const image = screen.getByRole("img", { name: "Screenshot" });
    expect(image).toHaveAttribute("src", "blob:secure-preview");
    fireEvent.click(screen.getAllByRole("button", { name: "Open artifact: Screenshot" }).at(-1)!);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(mockArtifactImageViewer).toHaveBeenCalledWith(expect.objectContaining({
      artifactId: "art-image",
      projectId: "proj-1",
      title: "Screenshot",
      onClose: expect.any(Function),
    }));
    expect(Object.keys(mockArtifactImageViewer.mock.calls[0][0]).sort()).toEqual(["artifactId", "onClose", "projectId", "title"]);
    expect(document.body.innerHTML).not.toContain("fn_token");
    expect(document.body.innerHTML).not.toContain("daemon-token");
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
    expect(screen.getAllByRole("button", { name: "Open artifact: Screenshot" })).toHaveLength(2);
  });

  it("does not render a View task affordance without task metadata", () => {
    render(<MailboxArtifactAttachment artifactId="art-image" artifactType="image" title="Screenshot" onOpenTask={vi.fn()} />);

    expect(screen.queryByTestId("mailbox-artifact-view-task")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Open artifact: Screenshot" })).toHaveLength(2);
  });

  it.each([
    ["document", "Spec"],
    ["other", "Archive"],
  ])("renders an open link for %s artifacts", (artifactType, title) => {
    render(<MailboxArtifactAttachment artifactId={`art-${artifactType}`} artifactType={artifactType} title={title} />);

    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByRole("link", { name: `Open artifact: ${title}` })).toHaveAttribute("href", `/api/artifacts/art-${artifactType}/media?fn_token=daemon-token`);
  });

  it("renders controls media and an open link for video and audio artifacts", () => {
    const { rerender, container } = render(<MailboxArtifactAttachment artifactId="art-video" artifactType="video" title="Clip" />);
    expect(container.querySelector("video[controls]")).toHaveAttribute("src", "/api/artifacts/art-video/media?fn_token=daemon-token");
    expect(screen.getByRole("link", { name: "Open artifact: Clip" })).toHaveAttribute("href", "/api/artifacts/art-video/media?fn_token=daemon-token");

    rerender(<MailboxArtifactAttachment artifactId="art-audio" artifactType="audio" title="Recording" />);
    expect(container.querySelector("audio[controls]")).toHaveAttribute("src", "/api/artifacts/art-audio/media?fn_token=daemon-token");
    expect(screen.getByRole("link", { name: "Open artifact: Recording" })).toHaveAttribute("href", "/api/artifacts/art-audio/media?fn_token=daemon-token");
  });

  it("renders nothing when artifactId metadata is missing", () => {
    const { container } = render(<MailboxArtifactAttachment artifactType="image" title="No id" />);

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId("mailbox-artifact-attachment")).toBeNull();
  });

  it("keeps the safe viewer action available after an image load failure", () => {
    render(<MailboxArtifactAttachment artifactId="art-broken" artifactType="image" title="Broken screenshot" taskId="FN-1234" onOpenTask={vi.fn()} />);

    fireEvent.error(screen.getByRole("img", { name: "Broken screenshot" }));

    expect(screen.queryByRole("img", { name: "Broken screenshot" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open artifact: Broken screenshot" })).toBeInTheDocument();
    expect(screen.getByTestId("mailbox-artifact-view-task")).toBeInTheDocument();
  });
});
