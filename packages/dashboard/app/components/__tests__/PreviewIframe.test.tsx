import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewIframe } from "../PreviewIframe";

vi.mock("lucide-react", () => ({
  AlertTriangle: () => <span data-testid="alert-icon">⚠️</span>,
  Loader2: () => <span data-testid="loader-icon">⏳</span>,
  ShieldAlert: () => <span data-testid="shield-icon">🛡️</span>,
}));

describe("PreviewIframe", () => {
  const originalWindowOpen = window.open;

  beforeEach(() => {
    window.open = vi.fn();
  });

  afterEach(() => {
    window.open = originalWindowOpen;
  });

  it("renders null when url is null", () => {
    const { container } = render(
      <PreviewIframe
        url={null}
        embedStatus="unknown"
        onEmbedStatusChange={vi.fn()}
        iframeRef={createRef<HTMLIFrameElement>()}
        blockReason={null}
        embedContext={null}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("renders iframe with correct url, sandbox attributes, and title", () => {
    render(
      <PreviewIframe
        url="http://localhost:3000"
        embedStatus="embedded"
        onEmbedStatusChange={vi.fn()}
        iframeRef={createRef<HTMLIFrameElement>()}
        blockReason={null}
        embedContext={null}
      />,
    );

    const iframe = screen.getByTitle("Dev server preview");
    expect(iframe).toBeInTheDocument();
    expect(iframe).toHaveAttribute("src", "http://localhost:3000");
    expect(iframe).toHaveAttribute(
      "sandbox",
      "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox",
    );
  });

  it("moves unknown status into loading", async () => {
    const onEmbedStatusChange = vi.fn();

    render(
      <PreviewIframe
        url="http://localhost:3000"
        embedStatus="unknown"
        onEmbedStatusChange={onEmbedStatusChange}
        iframeRef={createRef<HTMLIFrameElement>()}
        blockReason={null}
        embedContext={null}
      />,
    );

    await waitFor(() => {
      expect(onEmbedStatusChange).toHaveBeenCalledWith("loading");
    });
  });

  it("iframe load marks status as embedded", () => {
    const onEmbedStatusChange = vi.fn();

    render(
      <PreviewIframe
        url="http://localhost:3000"
        embedStatus="loading"
        onEmbedStatusChange={onEmbedStatusChange}
        iframeRef={createRef<HTMLIFrameElement>()}
        blockReason={null}
        embedContext={null}
      />,
    );

    fireEvent.load(screen.getByTitle("Dev server preview"));

    expect(onEmbedStatusChange).toHaveBeenCalledWith("embedded");
  });

  it("iframe error marks status as error", () => {
    const onEmbedStatusChange = vi.fn();

    render(
      <PreviewIframe
        url="http://localhost:3000"
        embedStatus="loading"
        onEmbedStatusChange={onEmbedStatusChange}
        iframeRef={createRef<HTMLIFrameElement>()}
        blockReason={null}
        embedContext={null}
      />,
    );

    fireEvent(screen.getByTitle("Dev server preview"), new Event("error"));

    expect(onEmbedStatusChange).toHaveBeenCalledWith("error");
  });

  it("applies custom className", () => {
    render(
      <PreviewIframe
        url="http://localhost:3000"
        embedStatus="embedded"
        onEmbedStatusChange={vi.fn()}
        iframeRef={createRef<HTMLIFrameElement>()}
        blockReason={null}
        embedContext={null}
        className="custom-class"
      />,
    );

    expect(screen.getByTitle("Dev server preview")).toHaveClass("custom-class");
  });

  it("blocked state shows ShieldAlert icon and embed context", () => {
    render(
      <PreviewIframe
        url="http://localhost:3000"
        embedStatus="blocked"
        onEmbedStatusChange={vi.fn()}
        iframeRef={createRef<HTMLIFrameElement>()}
        blockReason="The server may block iframe embedding..."
        embedContext="The server may block iframe embedding..."
      />,
    );

    expect(screen.getByTestId("shield-icon")).toBeInTheDocument();
    expect(screen.getByText("Preview cannot be embedded")).toBeInTheDocument();
    expect(screen.getByText("The server may block iframe embedding...")).toBeInTheDocument();
  });

  it("blocked state open in new tab opens external URL", () => {
    render(
      <PreviewIframe
        url="http://localhost:3000"
        embedStatus="blocked"
        onEmbedStatusChange={vi.fn()}
        iframeRef={createRef<HTMLIFrameElement>()}
        blockReason="The server may block iframe embedding..."
        embedContext="The server may block iframe embedding..."
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open in new tab" }));

    expect(window.open).toHaveBeenCalledWith("http://localhost:3000", "_blank", "noopener,noreferrer");
  });

  it("blocked state retry calls onRetry", () => {
    const onRetry = vi.fn();

    render(
      <PreviewIframe
        url="http://localhost:3000"
        embedStatus="blocked"
        onEmbedStatusChange={vi.fn()}
        iframeRef={createRef<HTMLIFrameElement>()}
        blockReason="The server may block iframe embedding..."
        embedContext="The server may block iframe embedding..."
        onRetry={onRetry}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("error state shows AlertTriangle and contextual message", () => {
    render(
      <PreviewIframe
        url="http://localhost:3000"
        embedStatus="error"
        onEmbedStatusChange={vi.fn()}
        iframeRef={createRef<HTMLIFrameElement>()}
        blockReason="The preview URL could not be loaded..."
        embedContext="The preview URL could not be loaded..."
      />,
    );

    expect(screen.getByTestId("alert-icon")).toBeInTheDocument();
    expect(screen.getByText("Unable to load preview")).toBeInTheDocument();
    expect(screen.getByText("The preview URL could not be loaded...")).toBeInTheDocument();
  });

  it("error state retry calls onRetry", () => {
    const onRetry = vi.fn();

    render(
      <PreviewIframe
        url="http://localhost:3000"
        embedStatus="error"
        onEmbedStatusChange={vi.fn()}
        iframeRef={createRef<HTMLIFrameElement>()}
        blockReason="The preview URL could not be loaded..."
        embedContext="The preview URL could not be loaded..."
        onRetry={onRetry}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("loading state shows loading spinner without action buttons", () => {
    render(
      <PreviewIframe
        url="http://localhost:3000"
        embedStatus="loading"
        onEmbedStatusChange={vi.fn()}
        iframeRef={createRef<HTMLIFrameElement>()}
        blockReason={null}
        embedContext={null}
      />,
    );

    expect(screen.getByTestId("loader-icon")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open in new tab" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });
});
