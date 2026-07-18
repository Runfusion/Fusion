import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactWithTask } from "@fusion/core";
import { ArtifactsGallery } from "../ArtifactsGallery";
import { NavigationHistoryProvider, useNavigationHistory, type UseNavigationHistoryResult } from "../../hooks/useNavigationHistory";

vi.mock("../../api", () => ({
  artifactMediaUrl: vi.fn((id: string) => `/api/artifacts/${id}/media`),
  artifactMediaUrlWithToken: vi.fn((id: string) => `/api/artifacts/${id}/media?fn_token=test`),
  fetchArtifact: vi.fn(() => Promise.resolve({})),
  updateArtifact: vi.fn(),
}));

vi.mock("../FloatingWindow", () => ({
  FloatingWindow: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const artifacts: ArtifactWithTask[] = [
  {
    id: "image-artifact",
    type: "image",
    title: "Image artifact",
    mimeType: "image/png",
    uri: "artifacts/image.png",
    authorId: "agent",
    authorType: "agent",
    createdAt: "2026-07-16T12:00:00.000Z",
    updatedAt: "2026-07-16T12:00:00.000Z",
  },
  {
    id: "doc-artifact",
    type: "document",
    title: "Document artifact",
    mimeType: "text/markdown",
    content: "# Document",
    authorId: "agent",
    authorType: "agent",
    createdAt: "2026-07-16T12:00:00.000Z",
    updatedAt: "2026-07-16T12:00:00.000Z",
  },
];

function HistoryHarness({ children, onReady }: { children: ReactNode; onReady: (history: UseNavigationHistoryResult) => void }) {
  const history = useNavigationHistory({ enabled: true });
  useEffect(() => onReady(history), [history, onReady]);
  return <NavigationHistoryProvider value={history}>{children}</NavigationHistoryProvider>;
}

function dispatchPopState(navIndex: number) {
  act(() => {
    window.dispatchEvent(new PopStateEvent("popstate", { state: { navIndex } }));
  });
}

const galleryProps = {
  artifacts,
  isMobile: true,
  addToast: vi.fn(),
  onOpenTask: vi.fn(),
};

function openImageViewer() {
  fireEvent.click(screen.getByRole("button", { name: "Expand Image artifact" }));
}

function openDocumentViewer() {
  fireEvent.click(screen.getByRole("button", { name: "Open Document artifact" }));
}

function expectViewerOpen(container: HTMLElement) {
  expect(container.querySelector(".artifacts-gallery-viewer")).not.toBeNull();
}

describe("ArtifactsGallery mobile viewer navigation history", () => {
  let navigationHistory: UseNavigationHistoryResult | null = null;

  beforeEach(() => {
    navigationHistory = null;
    window.history.replaceState({ navIndex: 0 }, "");
    vi.spyOn(window.history, "back").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  function renderWithHistory(isMobile = true) {
    return render(
      <HistoryHarness onReady={(history) => { navigationHistory = history; }}>
        <ArtifactsGallery {...galleryProps} isMobile={isMobile} />
      </HistoryHarness>,
    );
  }

  it("dismisses the media viewer on browser Back and drains its nav entry", async () => {
    const { container } = renderWithHistory();
    openImageViewer();
    expectViewerOpen(container);

    dispatchPopState(0);

    await waitFor(() => expect(container.querySelector(".artifacts-gallery-viewer")).toBeNull());
    expect(screen.getByRole("button", { name: "Expand Image artifact" })).toBeInTheDocument();
    dispatchPopState(0);
    expect(container.querySelector(".artifacts-gallery-viewer")).toBeNull();
  });

  it("routes Android native Back through popstate before dismissing the document viewer", async () => {
    const { container } = renderWithHistory();
    openDocumentViewer();
    expectViewerOpen(container);

    const nativeBack = new CustomEvent("fusion:native-back", { cancelable: true });
    expect(window.dispatchEvent(nativeBack)).toBe(false);
    expect(window.history.back).toHaveBeenCalledOnce();
    expectViewerOpen(container);

    dispatchPopState(0);
    await waitFor(() => expect(container.querySelector(".artifacts-gallery-viewer")).toBeNull());
    expect(screen.getByRole("button", { name: "Open Document artifact" })).toBeInTheDocument();
  });

  async function expectProgrammaticCloseConsumesViewerEntry(close: () => void) {
    const { container } = renderWithHistory();
    await waitFor(() => expect(navigationHistory).not.toBeNull());
    const sentinelClose = vi.fn();
    navigationHistory?.pushNav({ type: "modal", close: sentinelClose });
    openImageViewer();
    expectViewerOpen(container);

    close();
    await waitFor(() => expect(container.querySelector(".artifacts-gallery-viewer")).toBeNull());
    expect(window.history.back).toHaveBeenCalledOnce();

    // The first pop is removeNav's self-pop; exactly one more pop reaches the lower entry.
    dispatchPopState(1);
    expect(sentinelClose).not.toHaveBeenCalled();
    dispatchPopState(0);
    expect(sentinelClose).toHaveBeenCalledOnce();
  }

  it("consumes the viewer entry when the header close button dismisses it", async () => {
    await expectProgrammaticCloseConsumesViewerEntry(() => fireEvent.click(screen.getByRole("button", { name: "Close artifact preview" })));
  });

  it("consumes the viewer entry when Escape dismisses it", async () => {
    await expectProgrammaticCloseConsumesViewerEntry(() => fireEvent.keyDown(document, { key: "Escape" }));
  });

  it("keeps provider-less gallery renders functional", async () => {
    const { container } = render(<ArtifactsGallery {...galleryProps} />);
    openImageViewer();
    expectViewerOpen(container);
    fireEvent.click(screen.getByRole("button", { name: "Close artifact preview" }));
    await waitFor(() => expect(container.querySelector(".artifacts-gallery-viewer")).toBeNull());
  });

  it("does not push a viewer entry on desktop", async () => {
    renderWithHistory(false);
    await waitFor(() => expect(navigationHistory).not.toBeNull());
    const sentinelClose = vi.fn();
    navigationHistory?.pushNav({ type: "modal", close: sentinelClose });
    openImageViewer();

    dispatchPopState(0);
    expect(sentinelClose).toHaveBeenCalledOnce();
  });
});
