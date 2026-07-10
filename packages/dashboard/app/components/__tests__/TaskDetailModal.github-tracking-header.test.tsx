/*
FNXC:TaskDetailTabs 2026-06-17-08:20:
FN-7306 labels the stable internal `chat` tab as Activity and keeps it as the default TaskDetailModal tab. Tests that assert Definition-only sections must opt into `initialTab="definition"` so they verify the intended surface instead of the Activity landing state.
*/
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
        initialTab="definition"
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

    /*
    FNXC:TaskDetailCSS 2026-07-08-13:00:
    The github/gitlab tracking header rules were consolidated into a shared selector list (.detail-github-tracking-section .detail-source-header, .detail-gitlab-tracking-section .detail-source-header {…}), so the selector is no longer immediately followed by `{`. Allow the selector list (comma + sibling selector) between the tracked selector and the brace via [^{]* while still pinning the layout contract (flex-wrap/align-items/min-width).
    */
    expect(css).toMatch(
      /\.detail-github-tracking-section\s+\.detail-source-header[^{]*\{[^}]*flex-wrap:\s*nowrap;[^}]*align-items:\s*center;[^}]*min-width:\s*0;/,
    );
    expect(css).toMatch(
      /\.detail-github-tracking-section\s+\.detail-source-summary[^{]*\{[^}]*flex:\s*1 1 auto;[^}]*flex-wrap:\s*nowrap;[^}]*min-width:\s*0;/,
    );
    expect(css).toMatch(
      /@media[^{]*\(max-width:\s*768px\)[^{]*\{[\s\S]*?\.detail-github-tracking-section\s+\.detail-source-header[^{]*\{[^}]*flex-wrap:\s*nowrap;[^}]*min-width:\s*0;[^}]*\}[\s\S]*?\.detail-github-tracking-section\s+\.detail-source-summary[^{]*\{[^}]*flex:\s*1 1 auto;[^}]*flex-wrap:\s*nowrap;[^}]*min-width:\s*0;[^}]*\}/,
    );
  });
});
