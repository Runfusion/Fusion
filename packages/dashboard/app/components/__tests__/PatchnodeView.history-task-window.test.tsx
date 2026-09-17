import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PatchnodeFeed, TaskDetail } from "@fusion/core";
import {
  makeTask,
  noop,
  noopDelete,
  noopMerge,
  noopOpenDetail,
  setupTaskDetailModalHooks,
} from "./TaskDetailModal.test-helpers";
import * as api from "../../api";
import { readAppFile } from "../../test/cssFixture";
import { PatchnodeView } from "../PatchnodeView";
import { AppModalTaskDetailHost, AppTaskPopoutWindows, useAppPoppedOutTaskState } from "../TaskDetailHostBoundaries";
import type { NavEntry } from "../../hooks/useNavigationHistory";

setupTaskDetailModalHooks();

const sharedProps = {
  onDeleteTask: noopDelete,
  onMergeTask: noopMerge,
  onOpenDetail: noopOpenDetail,
  addToast: noop,
};

const historyTask = makeTask({ id: "FN-2", title: "Search" });

const feed: PatchnodeFeed = {
  days: [
    {
      day: "2026-08-28",
      completedCount: 1,
      revertedCount: 0,
      entries: [{ entryId: "completed:FN-2:2", taskId: "FN-2", kind: "completed", occurrenceKey: "2", day: "2026-08-28", occurredAt: "2026-08-28T11:00:00Z", title: "Search", body: "Added search" }],
    },
    {
      day: "2026-08-27",
      completedCount: 1,
      revertedCount: 0,
      entries: [{ entryId: "completed:FN-2:1", taskId: "FN-2", kind: "completed", occurrenceKey: "1", day: "2026-08-27", occurredAt: "2026-08-27T10:00:00Z", title: "Search", body: "Earlier delivery of the same task" }],
    },
  ],
  totalEntries: 2,
  hasMore: false,
};

/*
FNXC:HistoryModalSurface 2026-09-15-19:12:
FN-428: this host mounts the production units App wires together — the floating `PatchnodeView`, the `useAppPoppedOutTaskState`
owner, and the `AppTaskPopoutWindows` renderer — so activating a History entry is proved on the real coexisting chain
rather than on a test-only callback map.
*/
function HistoryTaskWindowHost({ resolveTask, onCloseHistory }: { resolveTask: (taskId: string) => Promise<TaskDetail>; onCloseHistory: () => void }) {
  const [, setNavEntries] = useState<NavEntry[]>([]);
  const popouts = useAppPoppedOutTaskState({
    isMobile: false,
    pushNav: (entry) => setNavEntries((entries) => [...entries, entry]),
    removeNav: (callback) => setNavEntries((entries) => entries.filter((entry) => (entry.type === "view" ? entry.revert : entry.close) !== callback)),
  });
  return (
    <>
      <PatchnodeView
        projectId="history-project"
        floating={{ onClose: onCloseHistory }}
        onOpenTaskDetail={async (taskId) => {
          const task = await resolveTask(taskId);
          popouts.open(task);
        }}
      />
      <AppTaskPopoutWindows
        entries={popouts.entries}
        liveTasks={popouts.entries.map((entry) => entry.task)}
        onCloseTask={popouts.close}
        windowProps={sharedProps}
      />
    </>
  );
}

describe("opening a task from History", () => {
  let fetchPatchnode: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchPatchnode = vi.spyOn(api, "fetchPatchnode").mockResolvedValue(feed);
  });

  afterEach(() => {
    fetchPatchnode.mockRestore();
  });

  it("ouvre une fenêtre de tâche coexistante sans overlay bloquant et laisse l'Historique monté", async () => {
    const closeHistory = vi.fn();
    render(<HistoryTaskWindowHost resolveTask={async () => historyTask} onCloseHistory={closeHistory} />);

    fireEvent.click(await screen.findByTestId("patchnode-entry-completed:FN-2:2"));

    const taskWindow = await screen.findByTestId("floating-window-overlay-task-detail-FN-2");
    expect(taskWindow).toHaveAttribute("aria-modal", "false");
    expect(document.querySelectorAll(".floating-window-overlay--modal")).toHaveLength(0);
    expect(screen.getByTestId("patchnode-view")).toBeInTheDocument();
    expect(screen.getByTestId("floating-window-overlay-history-view")).toBeInTheDocument();
    expect(closeHistory).not.toHaveBeenCalled();
    expect(fetchPatchnode).toHaveBeenCalledTimes(1);
  });

  it("garde l'Historique opérationnel et ne monte aucune surface quand la tâche a disparu", async () => {
    const closeHistory = vi.fn();
    render(<HistoryTaskWindowHost resolveTask={async () => { throw new Error("task is gone"); }} onCloseHistory={closeHistory} />);

    fireEvent.click(await screen.findByTestId("patchnode-entry-completed:FN-2:2"));

    await waitFor(() => expect(screen.getByTestId("patchnode-view")).toBeInTheDocument());
    expect(document.querySelectorAll(".floating-window-overlay--modal")).toHaveLength(0);
    expect(screen.queryByTestId("floating-window-overlay-task-detail-FN-2")).toBeNull();
    expect(closeHistory).not.toHaveBeenCalled();
  });

  it("ne monte qu'une seule fenêtre pour deux entrées de la même tâche", async () => {
    render(<HistoryTaskWindowHost resolveTask={async () => historyTask} onCloseHistory={noop} />);

    fireEvent.click(await screen.findByTestId("patchnode-entry-completed:FN-2:2"));
    await screen.findByTestId("floating-window-overlay-task-detail-FN-2");
    fireEvent.click(screen.getByTestId("patchnode-entry-completed:FN-2:1"));

    await waitFor(() => expect(document.querySelectorAll('[data-testid="floating-window-overlay-task-detail-FN-2"]')).toHaveLength(1));
    expect(document.querySelectorAll(".floating-window-overlay--modal")).toHaveLength(0);
    expect(screen.getByTestId("patchnode-view")).toBeInTheDocument();
  });

  /*
  FNXC:HistoryModalSurface 2026-09-15-19:12:
  FN-428 negative control: the blocking presentation stays in production for its own hosts, so rendering it here proves
  the assertions above are refutable — they really do detect the reported veil rather than passing vacuously.
  */
  it("détecte bien l'overlay bloquant sur la présentation modale conservée pour les autres hôtes", () => {
    render(
      <AppModalTaskDetailHost
        {...sharedProps}
        task={makeTask({ id: "FN-2" })}
        onRemoveNavigation={noop}
        onCloseDetail={noop}
        onCleanupDeepLink={noop}
        onClosed={noop}
      />,
    );

    const blocking = document.querySelectorAll(".floating-window-overlay--modal");
    expect(blocking).toHaveLength(1);
    expect(blocking[0]).toHaveAttribute("aria-modal", "true");
  });

  it("câble l'activation d'une entrée d'Historique sur l'unique propriétaire de la route coexistante", () => {
    const source = readAppFile("App.tsx");

    const handlerStart = source.indexOf("onOpenTaskDetailById={async (taskId) => {");
    expect(handlerStart).toBeGreaterThan(-1);
    const handlerBlock = source.slice(handlerStart, source.indexOf("}}", handlerStart));
    expect(handlerBlock).toContain("openTaskDetailInWindow(task)");
    expect(handlerBlock).not.toContain("openDetailTask(");

    expect(source).toContain("popOutTaskDetail: openTaskDetailInWindow,");
    expect(source).not.toContain("popOutTaskDetail: mobileDrawerActive ?");

    const ownerStart = source.indexOf("const openTaskDetailInWindow = useCallback(");
    expect(ownerStart).toBeGreaterThan(-1);
    const ownerBlock = source.slice(ownerStart, source.indexOf("], [", ownerStart));
    expect(ownerBlock).toContain("getCoexistingTaskOpenRoute({ mobileDrawerActive })");
    expect(ownerBlock).toContain("popOutTaskDetailForCurrentView(task, initialTab)");
    expect(ownerBlock).toContain("openTaskDetailInMainPanel(task, initialTab)");
  });
});
