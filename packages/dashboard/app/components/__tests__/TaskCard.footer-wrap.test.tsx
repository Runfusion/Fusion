import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  CheckCircle2: () => <svg />,
  XCircle: () => <svg />,
  Target: () => <svg />,
  Bot: () => <svg />,
  Trash2: () => <svg />,
  RotateCw: () => <svg />,
  Zap: () => <svg />,
  AlertTriangle: () => <svg />,
  ArrowUpRight: () => <svg />,
}));

vi.mock("../ProviderIcon", () => ({
  ProviderIcon: () => <span data-testid="provider-icon" />,
}));

vi.mock("../PluginSlot", () => ({
  PluginSlot: () => null,
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
vi.mock("../../hooks/useToast", () => ({
  useToast: () => ({
    addToast: vi.fn(),
    removeToast: vi.fn(),
    toasts: [],
  }),
}));

const noop = () => {};

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-5210",
    title: "Wrap footer chips when the card gets narrow",
    description: "",
    column: "in-progress",
    status: "executing" as Task["status"],
    steps: [],
    dependencies: [],
    sourceType: "dashboard_ui",
    githubTracking: {
      enabled: true,
      issue: {
        owner: "runfusion",
        repo: "fusion",
        number: 5210,
        url: "https://github.com/runfusion/fusion/issues/5210",
        createdAt: "2026-05-19T12:00:00.000Z",
      },
    },
    retrySummary: { total: 3 } as Task["retrySummary"],
    executionStartedAt: "2026-05-19T12:00:00.000Z",
    updatedAt: "2026-05-19T12:05:00.000Z",
    ...overrides,
  } as Task;
}

describe("TaskCard footer wrapping (FN-5210)", () => {
  let cleanupCss: (() => void) | undefined;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-19T12:10:00.000Z"));

    const style = document.createElement("style");
    style.textContent = await Promise.resolve(loadAllAppCss());
    document.head.appendChild(style);
    cleanupCss = () => style.remove();
  });

  afterEach(() => {
    cleanupCss?.();
    cleanupCss = undefined;
    vi.useRealTimers();
  });

  it("FN-5210 wraps the footer row and right chip cluster with a non-zero row gap", () => {
    const { container } = render(
      <TaskCard task={makeTask()} onOpenDetail={noop} addToast={noop} onOpenDetailWithTab={noop} />,
    );

    const footerRow = container.querySelector(".card-footer-row") as HTMLElement;
    const rightCluster = container.querySelector(".card-footer-row-right") as HTMLElement;
    const retryChip = container.querySelector(".card-retry-badge") as HTMLElement;
    const githubChip = container.querySelector(".card-github-tracking-chip") as HTMLElement;
    const timeChip = container.querySelector(".card-time-indicator") as HTMLElement;

    expect(footerRow).toBeTruthy();
    expect(rightCluster).toBeTruthy();
    expect(retryChip).toBeTruthy();
    expect(githubChip).toBeTruthy();
    expect(timeChip).toBeTruthy();
    expect(rightCluster.contains(timeChip)).toBe(true);

    const footerStyles = getComputedStyle(footerRow);
    expect(footerStyles.flexWrap).toBe("wrap");
    expect(footerStyles.rowGap).toMatch(/^(var\(--space-xs\)|(?!0(?:px)?$)\d+(?:\.\d+)?px)$/);

    const rightClusterStyles = getComputedStyle(rightCluster);
    expect(rightClusterStyles.flexWrap).toBe("wrap");
    expect(rightClusterStyles.rowGap).toMatch(/^(var\(--space-xs\)|(?!0(?:px)?$)\d+(?:\.\d+)?px)$/);
    expect(rightClusterStyles.justifyContent).toBe("flex-end");
  });

  it.each([
    ".card-retry-badge",
    ".card-github-tracking-chip",
    ".card-time-indicator",
  ])("FN-5210 keeps %s internally nowrap so wrapping happens at chip boundaries", (selector) => {
    const { container } = render(
      <TaskCard task={makeTask()} onOpenDetail={noop} addToast={noop} onOpenDetailWithTab={noop} />,
    );

    const chip = container.querySelector(selector) as HTMLElement;
    expect(chip, `${selector} should render for the FN-5210 fixture`).toBeTruthy();

    const styles = getComputedStyle(chip);
    expect(styles.whiteSpace).toBe("nowrap");
    expect(styles.flexShrink).toBe("0");
  });

  it("places workflow badges after footer and action rows in DOM order", () => {
    const { container } = render(
      <TaskCard
        task={makeTask()}
        onOpenDetail={noop}
        addToast={noop}
        onOpenDetailWithTab={noop}
        onPromote={vi.fn(async () => undefined)}
        workflowBadge={{ workflowId: "wf-footer", workflowName: "Workflow with a very long display name for wrapping" }}
      />,
    );

    const footerRow = container.querySelector(".card-footer-row") as HTMLElement;
    const actionRow = container.querySelector(".card-action-row") as HTMLElement;
    const workflowRow = container.querySelector(".card-workflow-badge-row") as HTMLElement;
    const workflowBadge = container.querySelector(".card-workflow-badge") as HTMLElement;

    expect(footerRow).toBeTruthy();
    expect(actionRow).toBeTruthy();
    expect(workflowRow).toBeTruthy();
    expect(workflowRow.contains(workflowBadge)).toBe(true);
    expect(footerRow.compareDocumentPosition(workflowRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(actionRow.compareDocumentPosition(workflowRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const rowStyles = getComputedStyle(workflowRow);
    expect(rowStyles.justifyContent).toBe("flex-start");
    const badgeStyles = getComputedStyle(workflowBadge);
    expect(badgeStyles.whiteSpace).toBe("nowrap");
    expect(badgeStyles.overflow).toBe("hidden");
    expect(badgeStyles.textOverflow).toBe("ellipsis");
  });
});
