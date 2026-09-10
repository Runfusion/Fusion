import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTask, noop, noopDelete, noopMerge, noopOpenDetail, setupTaskDetailModalHooks } from "./TaskDetailModal.test-helpers";
import { TaskDetailModal } from "../TaskDetailModal";

setupTaskDetailModalHooks();

vi.mock("mermaid", () => ({
  default: { initialize: vi.fn(), render: vi.fn().mockResolvedValue({ svg: "<svg />" }) },
}));

describe("TaskDetailModal Alpha mobile drawer", () => {
  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query.includes("max-width") || query.includes("max-height"),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
  });

  it("réutilise le contenu Task Detail dans le shell partagé sans FloatingWindow", () => {
    const close = vi.fn();
    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-DRAWER" })}
        alphaMobileDrawer
        onClose={close}
        onOpenDetail={noopOpenDetail}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        addToast={noop}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Task detail" });
    expect(dialog).toHaveClass("alpha-mobile-drawer__panel");
    expect(dialog.querySelector(".task-detail-modal--alpha-drawer .task-detail-content")).toBeInTheDocument();
    expect(document.querySelector(".floating-window--task-detail")).toBeNull();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("conserve le FloatingWindow existant hors du contrat Alpha", () => {
    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-STANDARD" })}
        onClose={noop}
        onOpenDetail={noopOpenDetail}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        addToast={noop}
      />,
    );

    expect(document.querySelector(".floating-window--task-detail")).toBeInTheDocument();
    expect(screen.queryByTestId("alpha-mobile-drawer-task-detail")).toBeNull();
  });
});
