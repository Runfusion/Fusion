import { fireEvent, render, screen } from "@testing-library/react";
import type { PointerEventHandler, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactImage, ArtifactImageViewer, clampArtifactImageTransform } from "../ArtifactImageViewer";
import { useArtifactImageBlob } from "../../hooks/useArtifactImageBlob";

const { mockDialogPointerDown } = vi.hoisted(() => ({ mockDialogPointerDown: vi.fn() }));

vi.mock("../../hooks/useArtifactImageBlob", () => ({ useArtifactImageBlob: vi.fn() }));
vi.mock("../FloatingWindow", () => ({
  FloatingWindow: ({ children, ariaLabel }: { children: ReactNode; ariaLabel?: string }) => <div role="dialog" aria-label={ariaLabel} onPointerDown={mockDialogPointerDown as PointerEventHandler<HTMLDivElement>}>{children}</div>,
}));

const mockUseArtifactImageBlob = vi.mocked(useArtifactImageBlob);
const loadedImage = (url = "blob:secure-preview") => ({ url, loading: false, error: null, reload: vi.fn() });
const imageTransform = (name = "Secure image") => screen.getByRole("img", { name }).style.transform;

describe("ArtifactImageViewer", () => {
  beforeEach(() => {
    mockDialogPointerDown.mockClear();
    mockUseArtifactImageBlob.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders a blob image without a raw media link and closes with Escape while restoring focus", () => {
    mockUseArtifactImageBlob.mockReturnValue({ url: "blob:secure-preview", loading: false, error: null, reload: vi.fn() });
    const onClose = vi.fn();
    const trigger = document.createElement("button");
    trigger.textContent = "Open";
    document.body.append(trigger);
    trigger.focus();

    const { unmount } = render(<ArtifactImageViewer artifactId="image-1" title="Secure image" onClose={onClose} />);
    const image = screen.getByRole("img", { name: "Secure image" });
    expect(image).toHaveAttribute("src", "blob:secure-preview");
    expect(image.getAttribute("src")).not.toContain("fn_token");
    expect(screen.queryByRole("link")).toBeNull();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    unmount();
    expect(trigger).toHaveFocus();
    trigger.remove();
  });

  it("exposes an accessible error and retry action without an unsafe image URL", () => {
    const reload = vi.fn();
    mockUseArtifactImageBlob.mockReturnValue({ url: null, loading: false, error: "Failed to load image artifact.", reload });
    render(<ArtifactImageViewer artifactId="image-1" title="Broken image" onClose={vi.fn()} />);

    expect(screen.getByRole("alert")).toHaveTextContent("Failed to load image artifact.");
    expect(screen.queryByRole("img")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(reload).toHaveBeenCalledOnce();
  });

  it("zooms with controls, lowers the scale, and resets the transform", () => {
    mockUseArtifactImageBlob.mockReturnValue(loadedImage());
    render(<ArtifactImageViewer artifactId="image-1" title="Secure image" onClose={vi.fn()} />);

    const zoomOut = screen.getByTestId("artifact-image-viewer-zoom-out");
    const zoomIn = screen.getByTestId("artifact-image-viewer-zoom-in");
    const reset = screen.getByTestId("artifact-image-viewer-zoom-reset");
    const level = screen.getByTestId("artifact-image-viewer-zoom-level");
    expect(zoomOut).toBeDisabled();
    expect(reset).toBeDisabled();

    fireEvent.click(zoomIn);
    expect(level).toHaveTextContent("125%");
    expect(imageTransform()).toContain("scale(1.25)");
    expect(screen.getByRole("img", { name: "Secure image" })).toHaveAttribute("src", "blob:secure-preview");
    expect(screen.getByRole("img", { name: "Secure image" }).getAttribute("src")).not.toContain("fn_token");
    expect(screen.queryByRole("link")).toBeNull();

    fireEvent.click(zoomOut);
    expect(level).toHaveTextContent("100%");
    fireEvent.click(zoomIn);
    fireEvent.click(reset);
    expect(imageTransform()).toBe("translate(0px, 0px) scale(1)");
    expect(level).toHaveTextContent("100%");
  });

  it("clamps repeated control zoom between 100% and 800%", () => {
    mockUseArtifactImageBlob.mockReturnValue(loadedImage());
    render(<ArtifactImageViewer artifactId="image-1" title="Secure image" onClose={vi.fn()} />);

    const zoomIn = screen.getByTestId("artifact-image-viewer-zoom-in");
    const zoomOut = screen.getByTestId("artifact-image-viewer-zoom-out");
    for (let index = 0; index < 20; index += 1) fireEvent.click(zoomIn);
    expect(screen.getByTestId("artifact-image-viewer-zoom-level")).toHaveTextContent("800%");
    expect(zoomIn).toBeDisabled();

    for (let index = 0; index < 20; index += 1) fireEvent.click(zoomOut);
    expect(screen.getByTestId("artifact-image-viewer-zoom-level")).toHaveTextContent("100%");
    expect(zoomOut).toBeDisabled();
  });

  it("uses a non-passive wheel listener to zoom at the pointer", () => {
    mockUseArtifactImageBlob.mockReturnValue(loadedImage());
    render(<ArtifactImageViewer artifactId="image-1" title="Secure image" onClose={vi.fn()} />);
    const viewport = screen.getByTestId("artifact-image-viewer-viewport");

    const zoomInEvent = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100, clientX: 10, clientY: 10 });
    fireEvent(viewport, zoomInEvent);
    expect(zoomInEvent.defaultPrevented).toBe(true);
    expect(imageTransform()).toContain("scale(1.25)");

    fireEvent.wheel(viewport, { deltaY: 100, clientX: 10, clientY: 10 });
    expect(imageTransform()).toContain("scale(1)");
  });

  it("pans only while magnified", () => {
    mockUseArtifactImageBlob.mockReturnValue(loadedImage());
    render(<ArtifactImageViewer artifactId="image-1" title="Secure image" onClose={vi.fn()} />);
    const viewport = screen.getByTestId("artifact-image-viewer-viewport");

    fireEvent.pointerDown(viewport, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(viewport, { pointerId: 1, clientX: 40, clientY: 50 });
    fireEvent.pointerUp(viewport, { pointerId: 1, clientX: 40, clientY: 50 });
    expect(imageTransform()).toBe("translate(0px, 0px) scale(1)");

    fireEvent.click(screen.getByTestId("artifact-image-viewer-zoom-in"));
    fireEvent.pointerDown(viewport, { pointerId: 2, clientX: 10, clientY: 10 });
    expect(viewport).toHaveAttribute("data-panning", "true");
    fireEvent.pointerMove(viewport, { pointerId: 2, clientX: 40, clientY: 50 });
    fireEvent.pointerUp(viewport, { pointerId: 2, clientX: 40, clientY: 50 });
    expect(imageTransform()).toMatch(/translate\((?!0px, 0px)[^)]+\) scale\(1\.25\)/);
    expect(viewport).toHaveAttribute("data-panning", "false");
  });

  it("pinch-zooms around the midpoint of two pointers", () => {
    mockUseArtifactImageBlob.mockReturnValue(loadedImage());
    render(<ArtifactImageViewer artifactId="image-1" title="Secure image" onClose={vi.fn()} />);
    const viewport = screen.getByTestId("artifact-image-viewer-viewport");

    fireEvent.pointerDown(viewport, { pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerDown(viewport, { pointerId: 2, clientX: 100, clientY: 0 });
    fireEvent.pointerMove(viewport, { pointerId: 2, clientX: 200, clientY: 0 });
    expect(imageTransform()).toContain("scale(2)");
    fireEvent.pointerUp(viewport, { pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerUp(viewport, { pointerId: 2, clientX: 200, clientY: 0 });
  });

  it("toggles between fit and 200% on double-click", () => {
    mockUseArtifactImageBlob.mockReturnValue(loadedImage());
    render(<ArtifactImageViewer artifactId="image-1" title="Secure image" onClose={vi.fn()} />);
    const viewport = screen.getByTestId("artifact-image-viewer-viewport");

    fireEvent.doubleClick(viewport, { clientX: 10, clientY: 10 });
    expect(screen.getByTestId("artifact-image-viewer-zoom-level")).toHaveTextContent("200%");
    expect(imageTransform()).toContain("scale(2)");
    fireEvent.doubleClick(viewport, { clientX: 10, clientY: 10 });
    expect(imageTransform()).toBe("translate(0px, 0px) scale(1)");
  });

  it("supports zoom keyboard shortcuts while preserving Escape close", () => {
    mockUseArtifactImageBlob.mockReturnValue(loadedImage());
    const onClose = vi.fn();
    render(<ArtifactImageViewer artifactId="image-1" title="Secure image" onClose={onClose} />);

    fireEvent.keyDown(document, { key: "+" });
    expect(imageTransform()).toContain("scale(1.25)");
    fireEvent.keyDown(document, { key: "-" });
    expect(imageTransform()).toContain("scale(1)");
    fireEvent.keyDown(document, { key: "=" });
    fireEvent.keyDown(document, { key: "0" });
    expect(imageTransform()).toBe("translate(0px, 0px) scale(1)");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("ignores zoom keyboard shortcuts from editable controls", () => {
    mockUseArtifactImageBlob.mockReturnValue(loadedImage());
    render(<><input aria-label="Editor" /><ArtifactImageViewer artifactId="image-1" title="Secure image" onClose={vi.fn()} /></>);

    fireEvent.keyDown(screen.getByRole("textbox", { name: "Editor" }), { key: "+" });
    expect(imageTransform()).toBe("translate(0px, 0px) scale(1)");
  });

  it("resets zoom when a different artifact image opens", () => {
    mockUseArtifactImageBlob.mockImplementation((artifactId) => loadedImage(`blob:${artifactId}`));
    const rendered = render(<ArtifactImageViewer artifactId="image-1" title="First image" onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId("artifact-image-viewer-zoom-in"));
    expect(imageTransform("First image")).toContain("scale(1.25)");

    rendered.rerender(<ArtifactImageViewer artifactId="image-2" title="Second image" onClose={vi.fn()} />);
    expect(imageTransform("Second image")).toBe("translate(0px, 0px) scale(1)");
    expect(screen.getByTestId("artifact-image-viewer-zoom-level")).toHaveTextContent("100%");
  });

  it("renders no zoom viewport or toolbar while loading or after an error", () => {
    mockUseArtifactImageBlob.mockReturnValue({ url: null, loading: true, error: null, reload: vi.fn() });
    const rendered = render(<ArtifactImageViewer artifactId="image-1" title="Pending image" onClose={vi.fn()} />);
    expect(screen.getByText("Loading image artifact…")).toBeInTheDocument();
    expect(screen.queryByTestId("artifact-image-viewer-viewport")).toBeNull();
    expect(screen.queryByTestId("artifact-image-viewer-zoom-in")).toBeNull();

    const reload = vi.fn();
    mockUseArtifactImageBlob.mockReturnValue({ url: null, loading: false, error: "Failed to load image artifact.", reload });
    rendered.rerender(<ArtifactImageViewer artifactId="image-1" title="Broken image" onClose={vi.fn()} />);
    expect(screen.queryByTestId("artifact-image-viewer-viewport")).toBeNull();
    expect(screen.queryByTestId("artifact-image-viewer-zoom-in")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(reload).toHaveBeenCalledOnce();
  });

  it("stops toolbar pointer gestures before they reach the floating window", () => {
    mockUseArtifactImageBlob.mockReturnValue(loadedImage());
    render(<ArtifactImageViewer artifactId="image-1" title="Secure image" onClose={vi.fn()} />);

    fireEvent.pointerDown(screen.getByTestId("artifact-image-viewer-zoom-in"), { pointerId: 1 });
    expect(mockDialogPointerDown).not.toHaveBeenCalled();
  });

  it("keeps zoom controls and behavior available at the mobile breakpoint", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("max-width: 768px"),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    mockUseArtifactImageBlob.mockReturnValue(loadedImage());
    render(<ArtifactImageViewer artifactId="image-1" title="Mobile image" onClose={vi.fn()} />);

    expect(screen.getByTestId("artifact-image-viewer-zoom-level")).toHaveTextContent("100%");
    fireEvent.click(screen.getByTestId("artifact-image-viewer-zoom-in"));
    expect(imageTransform("Mobile image")).toContain("scale(1.25)");
  });

  it("keeps inline artifact thumbnails free of viewer zoom chrome", () => {
    mockUseArtifactImageBlob.mockReturnValue(loadedImage());
    render(<ArtifactImage artifactId="image-1" title="Inline image" />);

    expect(screen.getByRole("img", { name: "Inline image" })).toHaveAttribute("src", "blob:secure-preview");
    expect(screen.queryByTestId("artifact-image-viewer-zoom-in")).toBeNull();
  });

  it("clamps scale and translation while preserving pan for unmeasured layouts", () => {
    expect(clampArtifactImageTransform(
      { scale: 20, x: 999, y: -999 },
      { width: 100, height: 100 },
      { width: 100, height: 100 },
    )).toEqual({ scale: 8, x: 350, y: -350 });
    expect(clampArtifactImageTransform(
      { scale: 0.2, x: 20, y: -20 },
      { width: 100, height: 100 },
      { width: 50, height: 50 },
    )).toEqual({ scale: 1, x: 0, y: 0 });
    expect(clampArtifactImageTransform(
      { scale: 2, x: 999, y: -999 },
      { width: 100, height: 100 },
      { width: 100, height: 100 },
    )).toEqual({ scale: 2, x: 50, y: -50 });
    expect(clampArtifactImageTransform(
      { scale: 2, x: 23, y: -17 },
      { width: 0, height: 100 },
      { width: 100, height: 100 },
    )).toEqual({ scale: 2, x: 23, y: -17 });
  });
});
