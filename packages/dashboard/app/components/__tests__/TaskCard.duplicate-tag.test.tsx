import React from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TaskCard } from "../TaskCard";
import { loadAllAppCss, loadComponentCss } from "../../test/cssFixture";
import type { Task } from "@fusion/core";

const addToast = vi.fn();
vi.mock("../../hooks/useToast", () => ({
  useOptionalToast: () => null,
  useToast: () => ({ addToast, removeToast: vi.fn(), toasts: [] }),
}));

vi.mock("lucide-react", () => ({
  Link: () => null, Clock: () => null, Layers: () => null, Pencil: () => null,
  ChevronDown: () => null, Folder: () => null, Target: () => null, Bot: () => null,
  Trash2: () => null, RotateCw: () => null, Zap: () => null, GitBranch: () => null,
  GitPullRequest: () => null, AlertTriangle: () => null, ArrowUpRight: () => null,
  ArrowDown: () => null, Flag: () => null, ArrowUp: () => null, TriangleAlert: () => null,
  Eye: () => null, MoreHorizontal: () => null, Sparkles: () => null,
  X: () => <svg data-testid="icon-x" />,
}));

vi.mock("../ProviderIcon", () => ({ ProviderIcon: () => null }));
vi.mock("../PrCreateModal", () => ({ PrCreateModal: () => null }));
vi.mock("../../hooks/useTaskDiffStats", () => ({ useTaskDiffStats: () => ({ stats: null, loading: false }) }));
vi.mock("../../hooks/useBadgeWebSocket", () => ({ useBadgeWebSocket: () => ({ badgeUpdates: new Map(), isConnected: true, subscribeToBadge: vi.fn(), unsubscribeFromBadge: vi.fn() }) }));
vi.mock("../../hooks/useBatchBadgeFetch", () => ({ getFreshBatchData: vi.fn(() => null) }));
vi.mock("../../hooks/useConfirm", () => ({ useConfirm: () => ({ confirm: vi.fn(), confirmWithChoice: vi.fn() }) }));
vi.mock("../../api", () => ({ fetchWorkflowSettingValues: vi.fn().mockResolvedValue({ stored: {}, effective: {}, orphaned: [] }) }));

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-001",
    title: "Test task",
    column: "in-progress",
    description: "",
    steps: [],
    dependencies: [],
    ...overrides,
  } as Task;
}

const noop = () => {};
const readSource = (relativePath: string) => readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");

function renderCard(task: Task, onUpdateTask?: (id: string, patch: { dismissNearDuplicate: boolean }) => Promise<unknown> | unknown) {
  return render(<TaskCard task={task} onOpenDetail={noop} addToast={addToast} onUpdateTask={onUpdateTask} />);
}

describe("TaskCard duplicate tag (FN-173)", () => {
  it("clears the duplicate flag through the existing update seam", async () => {
    const onUpdateTask = vi.fn().mockResolvedValue(undefined);
    renderCard(makeTask({ sourceMetadata: { nearDuplicateOf: "FN-1234" } }), onUpdateTask);

    fireEvent.click(screen.getByRole("button", { name: "Mark the duplicate flag for FN-1234 as read" }));

    await waitFor(() => expect(onUpdateTask).toHaveBeenCalledWith("FN-001", { dismissNearDuplicate: true }));
    expect(screen.queryByRole("button", { name: /keep/i })).toBeNull();
  });

  it("does not leave a duplicate group shell without a duplicate", () => {
    const { container } = renderCard(makeTask());

    expect(screen.queryByText("Duplicate of FN-1234")).toBeNull();
    expect(screen.queryByRole("button", { name: /mark the duplicate flag/i })).toBeNull();
    expect(container.querySelector(".card-duplicate-chip-group")).toBeNull();
    expect(screen.queryByRole("button", { name: /keep/i })).toBeNull();
  });

  it("explains that a held triage duplicate stays paused until dismissed or deleted", () => {
    renderCard(makeTask({
      paused: true,
      pausedReason: "duplicate-decision-required",
      sourceMetadata: { nearDuplicateOf: "FN-1234", duplicateSource: "triage-marker" },
    }), vi.fn());

    const chip = screen.getByText("Duplicate of FN-1234").closest(".card-duplicate-chip");
    expect(chip).toHaveAttribute("title", expect.stringContaining("stays paused until you clear this flag or delete it"));
    expect(chip).toHaveAttribute("aria-label", expect.stringContaining("stays paused until you clear this flag or delete it"));
    expect(screen.getByTestId("card-needs-user-feedback-FN-001")).toHaveTextContent("Needs your decision");
    expect(screen.queryByRole("button", { name: /keep/i })).toBeNull();
  });

  it("explains that an ordinary near-duplicate continues normally", () => {
    renderCard(makeTask({ sourceMetadata: { nearDuplicateOf: "FN-1234" } }), vi.fn());

    expect(screen.getByText("Duplicate of FN-1234").closest(".card-duplicate-chip")).toHaveAttribute("title", expect.stringContaining("task continues normally"));
    expect(screen.queryByRole("button", { name: /keep/i })).toBeNull();
  });

  it("keeps the tag visible and reports a failed dismissal", async () => {
    const failure = new Error("request rejected");
    const onUpdateTask = vi.fn().mockRejectedValue(failure);
    renderCard(makeTask({ sourceMetadata: { nearDuplicateOf: "FN-1234" } }), onUpdateTask);

    fireEvent.click(screen.getByRole("button", { name: "Mark the duplicate flag for FN-1234 as read" }));

    await waitFor(() => expect(addToast).toHaveBeenCalledWith(expect.stringContaining("Failed to clear the duplicate flag"), "error"));
    expect(screen.getByText("Duplicate of FN-1234")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /keep/i })).toBeNull();
  });

  it("passes onUpdateTask inside every TaskCard host element", () => {
    for (const relativePath of ["../Column.tsx", "../DockTaskList.tsx", "../useRightDockController.tsx", "../WorktreeGroup.tsx", "../dashboard/MainContent.tsx"]) {
      const source = readSource(relativePath);
      const taskCardElements = source.match(/<TaskCard\b[\s\S]*?\/>/g) ?? [];
      expect(taskCardElements.length, relativePath).toBeGreaterThan(0);
      expect(taskCardElements.some((element) => /\bonUpdateTask\b/.test(element)), relativePath).toBe(true);
    }
  });

  it("keeps the informational chip but no button when updates are unavailable", () => {
    const { container } = renderCard(makeTask({ sourceMetadata: { nearDuplicateOf: "FN-1234" } }));

    expect(screen.getByText("Duplicate of FN-1234")).toBeInTheDocument();
    expect(container.querySelector(".card-duplicate-chip-group button")).toBeNull();
    expect(screen.queryByRole("button", { name: /keep/i })).toBeNull();
  });

  it("keeps duplicate dismissal styles responsive and removes legacy styles", () => {
    const cardCss = loadComponentCss("TaskCard.css");
    const appCss = loadAllAppCss();
    const detailCss = loadComponentCss("TaskDetailModal.css");

    expect(appCss).not.toContain("card-duplicate-keep");
    expect(cardCss).toMatch(/\.card-duplicate-dismiss\s*\{[\s\S]*?height:\s*var\(--card-chip-height\)/);
    expect(cardCss).toMatch(/\.card-duplicate-dismiss:focus-visible\s*\{[\s\S]*?var\(--focus-ring-strong\)/);
    expect(cardCss).toContain(".card-duplicate-dismiss::after");
    expect(cardCss).toMatch(/@media \(max-width: 768px\)\s*\{[\s\S]*?\.card-duplicate-chip-group,[\s\S]*?\.card-duplicate-dismiss/);
    expect(detailCss).toContain(".detail-near-duplicate-banner__dismiss");
    expect(detailCss).toMatch(/@media \(max-width: 768px\)\s*\{\s*\.detail-near-duplicate-banner__actions/);
  });

  it("removes obsolete duplicate keys from the catalog and generated declarations", () => {
    const catalog = readSource("../../../../i18n/locales/en/app.json");
    const declarations = readSource("../../../../i18n/src/resources.d.ts");

    for (const removedKey of ["keepTaskTitle", "keepFailed", "keepBtn"]) {
      expect(catalog).not.toContain(removedKey);
      expect(declarations).not.toContain(removedKey);
    }
    for (const retainedKey of ["dismissDuplicateFlag", "nearDuplicateHeldTitle"]) {
      expect(catalog).toContain(retainedKey);
      expect(declarations).toContain(retainedKey);
    }
  });
});
