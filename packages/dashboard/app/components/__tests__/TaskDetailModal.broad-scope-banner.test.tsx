import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { TaskDetailModal } from "../TaskDetailModal";
import {
  makeTask,
  noop,
  noopDelete,
  noopMerge,
  noopMove,
  noopOpenDetail,
  setupTaskDetailModalHooks,
} from "./TaskDetailModal.test-helpers";

setupTaskDetailModalHooks();

describe("TaskDetailModal broad-scope advisory banner", () => {
  it("renders banner details for well-formed broadScopeFlag and keeps provenance", () => {
    render(
      <TaskDetailModal
        task={makeTask({
          sourceType: "dashboard_ui",
          sourceMetadata: {
            broadScopeFlag: {
              score: 4,
              reasons: ["size-l", "steps-high", "file-scope-high"],
              signals: {
                size: "L",
                stepCount: 13,
                fileScopeCount: 21,
                failingFileMentions: 32,
              },
            },
          },
        })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    expect(screen.getByText("Created via Dashboard")).toBeInTheDocument();

    const banner = screen.getByLabelText("Triage broad-scope advisory");
    expect(banner.tagName).toBe("DIV");
    expect(within(banner).queryByRole("button")).not.toBeInTheDocument();
    expect(within(banner).getByText("Triage broad-scope advisory")).toBeInTheDocument();
    expect(within(banner).getByText("Score 4 · Size L, many steps, large file scope")).toBeInTheDocument();
    expect(within(banner).getByText("Size: L · Steps: 13 · File scope: 21 · Failing-file mentions: 32")).toBeInTheDocument();
    expect(within(banner).getByText("Advisory only — task lifecycle is unaffected.")).toBeInTheDocument();
  });

  it.each([
    ["missing sourceMetadata", undefined],
    ["missing broadScopeFlag", {}],
    ["non-numeric score", { broadScopeFlag: { score: "4", reasons: ["size-l"] } }],
    ["non-array reasons", { broadScopeFlag: { score: 4, reasons: "size-l" } }],
  ])("does not render banner when %s", (_label, sourceMetadata) => {
    render(
      <TaskDetailModal
        task={makeTask({ sourceMetadata: sourceMetadata as any })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    expect(screen.queryByLabelText("Triage broad-scope advisory")).not.toBeInTheDocument();
  });
});
