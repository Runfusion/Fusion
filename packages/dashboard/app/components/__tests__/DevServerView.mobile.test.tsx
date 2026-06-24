import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { loadAllAppCss } from "../../test/cssFixture";
import { DevServerView } from "../DevServerView";

const mockUseDevServer = vi.fn();
const mockUseDevServerLogs = vi.fn();
const mockUsePreviewEmbed = vi.fn();

vi.mock("../../hooks/useDevServer", () => ({
  useDevServer: (...args: unknown[]) => mockUseDevServer(...args),
}));

vi.mock("../../hooks/useDevServerLogs", () => ({
  useDevServerLogs: (...args: unknown[]) => mockUseDevServerLogs(...args),
}));

vi.mock("../../hooks/usePreviewEmbed", () => ({
  usePreviewEmbed: (...args: unknown[]) => mockUsePreviewEmbed(...args),
}));

vi.mock("../DevServerLogViewer", () => ({
  DevServerLogViewer: () => <div data-testid="mock-devserver-log-viewer" />,
}));

function createDevServerHookState() {
  return {
    session: {
      config: { id: "default", name: "Dev Server", command: "pnpm dev", cwd: "." },
      status: "running",
      previewUrl: "http://localhost:3000",
      logHistory: [],
    },
    sessions: [],
    detectedCommands: [],
    previewUrl: "http://localhost:3000",
    isLoading: false,
    error: null,
    startServer: vi.fn().mockResolvedValue(undefined),
    stopServer: vi.fn().mockResolvedValue(undefined),
    restartServer: vi.fn().mockResolvedValue(undefined),
    setPreviewUrl: vi.fn().mockResolvedValue(undefined),
    detectCommands: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
  };
}

describe("DevServerView mobile CSS/structure", () => {
  it("defines one mobile rule-set for preview header/actions and wraps badge correctly", () => {
    const css = loadAllAppCss();
    const mobileBlockMatch = css.match(/@media[^{]*\(max-width: 768px\)[^{]*\{([\s\S]*?)\n\}/g) ?? [];
    const mobileCss = mobileBlockMatch.join("\n");

    const headerRuleCount = (mobileCss.match(/\.devserver-preview-header,\s*\.devserver-preview-modal-launcher__copy\s*\{/g) ?? []).length;
    expect(headerRuleCount).toBe(1);
    expect(mobileCss).toMatch(/\.devserver-preview-url-badge\s*\{[\s\S]*max-width:\s*100%/);
    expect(mobileCss).toMatch(/\.dev-server-header-title\s*\{[\s\S]*flex-wrap:\s*wrap/);
  });

  it("defines narrow right-dock launcher and modal rules without duplicating mobile media rules", () => {
    const css = loadAllAppCss();
    const containerStart = css.indexOf("@container right-dock-body (max-width: 768px)");
    expect(containerStart).toBeGreaterThan(-1);
    const containerCss = css.slice(containerStart);

    expect(containerCss).toMatch(/\.devserver-preview-panel,\s*\.devserver-preview-modal-launcher\s*\{[\s\S]*grid-column:\s*auto/);
    expect(containerCss).toMatch(/\.devserver-preview-modal\s*\{[\s\S]*width:\s*min\(calc\(var\(--space-2xl\) \* 20\), calc\(100vw - var\(--space-md\) \* 2\)\)/);
    expect(containerCss).toMatch(/\.devserver-preview-panel \.devserver-preview-container/);
    expect(containerCss).not.toMatch(/\.dev-server-logs,\s*\.devserver-preview-container,\s*\.devserver-preview-iframe/);

    expect(css).toMatch(/@media[^{]*\(max-width: 768px\)/);
    expect(css).toMatch(/@container right-dock-body \(max-width: 768px\)/);
  });

  it("renders preview header elements and keeps URL badge outside preview actions", () => {
    mockUseDevServer.mockReturnValue(createDevServerHookState());
    mockUseDevServerLogs.mockReturnValue({
      entries: [],
      loading: false,
      loadingMore: false,
      hasMore: false,
      total: 0,
      loadMore: vi.fn(),
    });
    mockUsePreviewEmbed.mockReturnValue({
      embedStatus: "embedded",
      setEmbedStatus: vi.fn(),
      resetEmbedStatus: vi.fn(),
      iframeRef: { current: null },
      isEmbedded: true,
      isBlocked: false,
      blockReason: null,
      retry: vi.fn(),
    });

    render(<DevServerView addToast={vi.fn()} projectId="project-a" />);

    const previewPanel = screen.getByTestId("devserver-preview-panel");
    const badge = screen.getByTestId("devserver-preview-url-badge");
    const actions = previewPanel.querySelector(".devserver-preview-actions");
    const statusBadge = screen.getByTestId("dev-server-status-badge");

    expect(previewPanel.querySelector(".devserver-preview-header")).toBeInTheDocument();
    expect(statusBadge).toBeInTheDocument();
    expect(actions).toBeTruthy();
    expect(actions?.contains(badge)).toBe(false);
    expect(badge.parentElement).toBe(previewPanel.querySelector(".devserver-preview-header"));
  });
});
