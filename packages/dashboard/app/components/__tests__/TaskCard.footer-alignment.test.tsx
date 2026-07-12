import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { render } from "@testing-library/react";
import type { Task } from "@fusion/core";
import { TaskCard } from "../TaskCard";
import { loadAllAppCss } from "../../test/cssFixture";

vi.mock("lucide-react", () => ({
  Link: () => <svg />,
  GitBranch: () => <svg />,
  Clock: () => <svg />,
  Pencil: () => <svg />,
  Layers: () => <svg />,
  ChevronDown: () => <svg />,
  Folder: () => <svg />,
  GitPullRequest: () => <svg />,
  CircleDot: () => <svg />,
  Target: () => <svg />,
  Bot: () => <svg />,
  Trash2: () => <svg />,
  RotateCw: () => <svg />,
  Zap: () => <svg />,
  AlertTriangle: () => <svg />,
}));

vi.mock("../../hooks/useTaskDiffStats", () => ({
  useTaskDiffStats: () => ({ stats: null, loading: false }),
}));

vi.mock("../../hooks/useBadgeWebSocket", () => ({
  useBadgeWebSocket: () => ({
    badgeUpdates: new Map(),
    isConnected: true,
    subscribeToBadge: vi.fn(),
    unsubscribeFromBadge: vi.fn(),
  }),
}));

vi.mock("../../hooks/useBatchBadgeFetch", () => ({
  getFreshBatchData: vi.fn(() => null),
}));

vi.mock("../../api", () => ({
  fetchTaskDetail: vi.fn(),
  uploadAttachment: vi.fn(),
  fetchMission: vi.fn(),
  fetchAgent: vi.fn(),
}));

vi.mock("../../hooks/useConfirm", () => ({
  useConfirm: () => ({ confirm: vi.fn(async () => true) }),
}));
/*
FNXC:RuntimeFallbackUI 2026-07-11-00:00:
RuntimeFallbackBadge (commit 0bed997af / FUX-022) calls the shared useToast() hook directly. TaskCard
embeds RuntimeFallbackBadge and this file renders <TaskCard> outside a ToastProvider, so mock the hook
to avoid "useToast must be used within ToastProvider", matching the TaskCard.test.tsx pattern.
*/
vi.mock("../../hooks/useToast", () => ({
  useToast: () => ({
    addToast: vi.fn(),
    removeToast: vi.fn(),
    toasts: [],
  }),
}));

const noop = () => {};

function makeTask(): Task {
  return {
    id: "FN-4598",
    title: "Alignment test",
    description: "",
    column: "in-progress",
    steps: [],
    dependencies: [],
    sourceType: "github_import",
    issueInfo: {
      owner: "runfusion",
      repo: "fusion",
      number: 315,
      title: "Imported issue",
      url: "https://github.com/runfusion/fusion/issues/315",
    },
    githubTracking: {
      enabled: true,
      issue: {
        owner: "runfusion",
        repo: "fusion",
        number: 316,
        url: "https://github.com/runfusion/fusion/issues/316",
        createdAt: new Date().toISOString(),
      },
    },
    retrySummary: { total: 2 },
    columnMovedAt: new Date(Date.now() - 60_000).toISOString(),
  } as Task;
}

describe("FN-4598 TaskCard footer chip alignment", () => {
  let styleEl: HTMLStyleElement;

  beforeAll(() => {
    styleEl = document.createElement("style");
    styleEl.textContent = loadAllAppCss();
    document.head.appendChild(styleEl);
  });

  afterAll(() => {
    styleEl.remove();
  });

  it("keeps footer chips and inner spans vertically centered", () => {
    const { container } = render(
      <TaskCard task={makeTask()} onOpenDetail={noop} addToast={noop} onOpenDetailWithTab={noop} />,
    );

    const selectors = [
      ".card-retry-badge",
      ".card-time-indicator",
      ".card-github-tracking-chip",
    ] as const;

    for (const selector of selectors) {
      const chip = container.querySelector(selector) as HTMLElement;
      expect(chip).toBeTruthy();
      const chipStyle = getComputedStyle(chip);
      expect(chipStyle.display).toBe("inline-flex");
      expect(chipStyle.alignItems).toBe("center");
      expect(chipStyle.lineHeight).toBe("1");

      const textSpan = chip.querySelector("span") as HTMLElement;
      expect(textSpan).toBeTruthy();
      const textStyle = getComputedStyle(textSpan);
      expect(textStyle.display).toBe("inline-flex");
      expect(textStyle.alignItems).toBe("center");
      expect(textStyle.lineHeight).toBe("1");
      expect(textStyle.transform).toMatch(/translateY\(1px\)|matrix\(1,\s*0,\s*0,\s*1,\s*0,\s*1\)/);
    }
  });

  it("keeps github, retry, and timer right-aligned in the footer cluster", () => {
    const { container } = render(
      <TaskCard
        task={{
          ...makeTask(),
          sourceType: "dashboard_ui",
          column: "in-review",
          retrySummary: { total: 2 },
          executionStartedAt: "2026-05-12T00:00:00.000Z",
          executionCompletedAt: "2026-05-12T00:05:00.000Z",
          updatedAt: "2026-05-12T00:05:00.000Z",
        }}
        onOpenDetail={noop}
        addToast={noop}
        onOpenDetailWithTab={noop}
      />,
    );

    const footerRow = container.querySelector(".card-footer-row") as HTMLElement;
    const rightCluster = footerRow.querySelector(":scope > .card-footer-row-right") as HTMLElement;
    const githubChip = rightCluster.querySelector(":scope > .card-github-tracking-chip") as HTMLElement;
    const retryChip = rightCluster.querySelector(":scope > .card-retry-badge") as HTMLElement;
    const timerChip = rightCluster.querySelector(":scope > .card-time-indicator") as HTMLElement;

    expect(footerRow).toBeTruthy();
    expect(rightCluster).toBeTruthy();
    expect(githubChip).toBeTruthy();
    expect(retryChip).toBeTruthy();
    expect(timerChip).toBeTruthy();
    expect(rightCluster.contains(timerChip)).toBe(true);

    expect(getComputedStyle(rightCluster).marginLeft).toBe("auto");

    const footerStyle = getComputedStyle(footerRow);
    expect(footerStyle.gap).toBe("var(--space-sm)");
  });

  it("FN-5099 keeps retry in the right cluster when source provenance is present in chipFarRight layouts", () => {
    const { container } = render(
      <TaskCard
        task={{
          ...makeTask(),
          column: "in-review",
          sourceType: "github_import",
          retrySummary: { total: 3 },
          executionStartedAt: "2026-05-12T00:00:00.000Z",
          executionCompletedAt: "2026-05-12T00:05:00.000Z",
          updatedAt: "2026-05-12T00:05:00.000Z",
        }}
        onOpenDetail={noop}
        addToast={noop}
        onOpenDetailWithTab={noop}
      />,
    );

    const footerRow = container.querySelector(".card-footer-row") as HTMLElement;
    const sourceChip = footerRow.querySelector(":scope > .card-source-provenance") as HTMLElement;
    const rightCluster = footerRow.querySelector(":scope > .card-footer-row-right") as HTMLElement;
    const retryChip = rightCluster.querySelector(":scope > .card-retry-badge") as HTMLElement;
    const githubChip = rightCluster.querySelector(":scope > .card-github-tracking-chip") as HTMLElement;
    const timerChip = rightCluster.querySelector(":scope > .card-time-indicator") as HTMLElement;

    expect(footerRow).toBeTruthy();
    expect(sourceChip).toBeTruthy();
    expect(rightCluster).toBeTruthy();
    expect(retryChip).toBeTruthy();
    expect(githubChip).toBeTruthy();
    expect(timerChip).toBeTruthy();
    expect(rightCluster.contains(timerChip)).toBe(true);

    expect(getComputedStyle(sourceChip).marginLeft).not.toBe("auto");
    expect(getComputedStyle(rightCluster).marginLeft).toBe("auto");
    expect(Array.from(rightCluster.children).map((node) => (node as HTMLElement).className)).toEqual([
      "card-github-tracking-chip card-github-tracking-link",
      expect.stringContaining("card-retry-badge"),
      "card-time-indicator",
    ]);
  });
});
