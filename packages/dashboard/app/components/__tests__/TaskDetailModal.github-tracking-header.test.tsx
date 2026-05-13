import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { loadAllAppCss } from "../../test/cssFixture";
import { TaskDetailModal } from "../TaskDetailModal";
import { makeTask, noop, noopDelete, noopMerge, noopMove, noopOpenDetail, setupTaskDetailModalHooks } from "./TaskDetailModal.test-helpers";

setupTaskDetailModalHooks();

describe("FN-4224 GitHub tracking header layout", () => {
  it("keeps the summary, enable action, and disclosure toggle on one row across desktop and mobile CSS", () => {
    render(
      <TaskDetailModal
        task={makeTask({
          column: "todo",
          githubTracking: { enabled: false },
        })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    expect(screen.getByText("GitHub tracking")).toBeInTheDocument();
    expect(screen.getByText("Tracking is currently disabled")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enable GitHub tracking" })).toHaveTextContent("Enable");
    expect(screen.getByRole("button", { name: "Expand GitHub tracking details" })).toBeInTheDocument();

    const css = loadAllAppCss();

    expect(css).toMatch(
      /\.detail-github-tracking-section\s+\.detail-source-header\s*\{[^}]*flex-wrap:\s*nowrap;[^}]*align-items:\s*center;[^}]*min-width:\s*0;/,
    );
    expect(css).toMatch(
      /\.detail-github-tracking-section\s+\.detail-source-summary\s*\{[^}]*flex:\s*1 1 auto;[^}]*flex-wrap:\s*nowrap;[^}]*min-width:\s*0;/,
    );
    expect(css).toMatch(
      /@media\s*\(max-width:\s*768px\)\s*\{[\s\S]*?\.detail-github-tracking-section\s+\.detail-source-header\s*\{[^}]*flex-wrap:\s*nowrap;[^}]*min-width:\s*0;[^}]*\}[\s\S]*?\.detail-github-tracking-section\s+\.detail-source-summary\s*\{[^}]*flex:\s*1 1 auto;[^}]*flex-wrap:\s*nowrap;[^}]*min-width:\s*0;[^}]*\}/,
    );
  });
});
