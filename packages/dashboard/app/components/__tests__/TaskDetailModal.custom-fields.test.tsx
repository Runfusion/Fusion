import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { WorkflowFieldDefinition } from "../../api";
import {
  makeTask,
  noop,
  noopDelete,
  noopMerge,
  noopMove,
  noopOpenDetail,
  setupTaskDetailModalHooks,
} from "./TaskDetailModal.test-helpers";
import { TaskDetailModal } from "../TaskDetailModal";
import * as dashboardApi from "../../api";
import { FileBrowserProvider } from "../../context/FileBrowserContext";

setupTaskDetailModalHooks();

function renderModal(task = makeTask({ column: "done" })) {
  return render(
    <FileBrowserProvider openFile={vi.fn()}>
      <TaskDetailModal
        task={task}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />
    </FileBrowserProvider>,
  );
}

describe("TaskDetailModal custom fields (U13/KTD-14)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders no fields section when the workflow declares no fields (today's UI)", async () => {
    vi.spyOn(dashboardApi, "fetchBoardWorkflows").mockResolvedValue({
      flagEnabled: true,
      defaultWorkflowId: "builtin:coding",
      workflows: [{ id: "builtin:coding", name: "Coding", columns: [] }],
      taskWorkflowIds: {},
    });
    renderModal();
    // Allow the field-defs fetch to settle.
    await waitFor(() => expect(dashboardApi.fetchBoardWorkflows).toHaveBeenCalled());
    expect(screen.queryByTestId("task-fields-section")).toBeNull();
  });

  it("renders the schema-driven fields section when the workflow declares fields", async () => {
    vi.spyOn(dashboardApi, "fetchBoardWorkflows").mockResolvedValue({
      flagEnabled: true,
      defaultWorkflowId: "builtin:coding",
      workflows: [
        {
          id: "builtin:coding",
          name: "Coding",
          columns: [],
          fields: [
            { id: "owner", name: "Owner", type: "string", render: { placement: "detail" } },
          ],
        },
      ],
      taskWorkflowIds: { "FN-001": "builtin:coding" },
    });
    renderModal(makeTask({ id: "FN-001", column: "done", customFields: { owner: "alice" } }));
    await waitFor(() => expect(screen.getByTestId("task-fields-section")).toBeTruthy());
    expect((screen.getByLabelText("Owner") as HTMLInputElement).value).toBe("alice");
  });

  it("uses workflowFieldDefs prop directly while resolving independent move metadata", async () => {
    const fetchSpy = vi.spyOn(dashboardApi, "fetchBoardWorkflows");
    const defs: WorkflowFieldDefinition[] = [
      { id: "owner", name: "Owner", type: "string", render: { placement: "detail" } },
    ];
    render(
      <FileBrowserProvider openFile={vi.fn()}>
        <TaskDetailModal
          task={makeTask({ id: "FN-002", column: "done", customFields: { owner: "bob" } })}
          workflowFieldDefs={defs}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />
      </FileBrowserProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("task-fields-section")).toBeTruthy());
    expect((screen.getByLabelText("Owner") as HTMLInputElement).value).toBe("bob");
    // Supplied fields remain authoritative; the one fetch resolves move columns independently.
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
  });

  it("renders no fields section when workflowFieldDefs prop is an empty array", async () => {
    const fetchSpy = vi.spyOn(dashboardApi, "fetchBoardWorkflows");
    render(
      <FileBrowserProvider openFile={vi.fn()}>
        <TaskDetailModal
          task={makeTask({ id: "FN-003", column: "done" })}
          workflowFieldDefs={[]}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />
      </FileBrowserProvider>,
    );
    // Give React a tick to settle; no section should appear.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("task-fields-section")).toBeNull();
    // Empty supplied fields still avoid replacement; the lookup is only for move metadata.
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
  });
});
