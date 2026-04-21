import { fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { PreviewIframe } from "../PreviewIframe";

describe("PreviewIframe", () => {
  it("renders iframe with correct url, sandbox attributes, and title", () => {
    const iframeRef = createRef<HTMLIFrameElement>();

    render(
      <PreviewIframe
        url="http://localhost:3000"
        iframeRef={iframeRef}
        onLoad={vi.fn()}
        onError={vi.fn()}
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

  it("calls onLoad handler", () => {
    const onLoad = vi.fn();

    render(
      <PreviewIframe
        url="http://localhost:3000"
        iframeRef={createRef<HTMLIFrameElement>()}
        onLoad={onLoad}
        onError={vi.fn()}
      />,
    );

    fireEvent.load(screen.getByTitle("Dev server preview"));

    expect(onLoad).toHaveBeenCalledTimes(1);
  });

  it("calls onError handler", () => {
    const onError = vi.fn();

    render(
      <PreviewIframe
        url="http://localhost:3000"
        iframeRef={createRef<HTMLIFrameElement>()}
        onLoad={vi.fn()}
        onError={onError}
      />,
    );

    fireEvent(screen.getByTitle("Dev server preview"), new Event("error"));

    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("applies custom className", () => {
    render(
      <PreviewIframe
        url="http://localhost:3000"
        iframeRef={createRef<HTMLIFrameElement>()}
        onLoad={vi.fn()}
        onError={vi.fn()}
        className="custom-class"
      />,
    );

    expect(screen.getByTitle("Dev server preview")).toHaveClass("custom-class");
  });
});
