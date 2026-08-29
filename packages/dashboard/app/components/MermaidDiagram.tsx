import { memo, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

/*
FNXC:Markdown 2026-06-23-03:15:
GitHub PR/issue bodies and comments embed ```mermaid fenced blocks. Render them
as real diagrams instead of literal code. The `mermaid` library is heavy (~600kb+
of parser/renderer), so it is LAZY-LOADED via `await import("mermaid")` only when a
mermaid block is actually present — keeping it out of the main dashboard bundle.

Race/unmount safety: each render gets a unique element id, an incrementing render
token guards against overlapping async renders (theme/chart change mid-flight), and
an `unmounted` flag prevents state updates after teardown. On parse error we fall
back to the raw fenced code block so a malformed diagram never crashes the message.
*/

let mermaidIdCounter = 0;

/** Theme follows the dashboard token: `data-theme="light"` => mermaid `default`, else `dark`. */
function resolveMermaidTheme(): "dark" | "default" {
  if (typeof document === "undefined") return "default";
  return document.documentElement.dataset.theme === "light" ? "default" : "dark";
}

interface MermaidDiagramProps {
  /** Raw mermaid source from the fenced ```mermaid block. */
  chart: string;
  /** Optional data-testid for test selectors. */
  testId?: string;
}

/**
 * Renders a mermaid diagram from raw mermaid source.
 *
 * Lazy-imports `mermaid` inside an effect, calls `mermaid.render` to produce an
 * SVG string, and injects it. On any parse/render failure, falls back to the raw
 * code block so the surrounding message keeps rendering.
 */
export const MermaidDiagram = memo(function MermaidDiagram({
  chart,
  testId,
}: MermaidDiagramProps) {
  const { t } = useTranslation("app");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    let unmounted = false;
    // Bump the token per effect run; only the latest run is allowed to commit.
    const renderToken = ++mermaidIdCounter;
    const elementId = `mermaid-${renderToken}`;

    setErrored(false);

    void (async () => {
      try {
        const mermaidModule = await import("mermaid");
        const mermaid = mermaidModule.default;
        mermaid.initialize({
          startOnLoad: false,
          theme: resolveMermaidTheme(),
          securityLevel: "strict",
        });
        const { svg } = await mermaid.render(elementId, chart);
        if (unmounted || renderToken !== mermaidIdCounter) return;
        if (containerRef.current) {
          containerRef.current.innerHTML = svg;
        }
      } catch {
        if (unmounted || renderToken !== mermaidIdCounter) return;
        setErrored(true);
      }
    })();

    return () => {
      unmounted = true;
    };
  }, [chart]);

  if (errored) {
    // Fallback: show the raw mermaid source as a normal code block.
    return (
      <pre className="mailbox-markdown-pre mailbox-mermaid-fallback" data-testid={testId}>
        <code>{chart}</code>
      </pre>
    );
  }

  return (
    <div
      ref={containerRef}
      className="mailbox-mermaid"
      data-testid={testId}
      aria-label={t("mermaid.diagram", "Mermaid diagram")}
    />
  );
});
