/*
FNXC:WorkflowResolvedColumns 2026-07-31-11:55 (u12 — the last convertible census guard in this file):
The enrich-mode task picker filtered archived rows with `task.column !== "archived"`. On a board whose
archive lane is renamed, that matched nothing, so filed-away tasks stayed in the picker and an operator
could attach research findings to work they had deliberately archived.

Asserted as the INVARIANT rather than the single repro, per the surface-enumeration rule: a renamed
archive lane, the legacy id, an unresolved workflow (fail-soft), and a second workflow's archive lane
in the cross-workflow union. A repro-only test here would pass on the legacy board and prove nothing
about the case the guard exists for.
*/
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import type { Task } from "@fusion/core";

import { ResearchTaskActionModal } from "../components/ResearchTaskActionModal";
import { fetchTasks } from "../api";
import { useBoardWorkflows } from "../hooks/useBoardWorkflows";

vi.mock("../api", () => ({ fetchTasks: vi.fn() }));
vi.mock("../hooks/useBoardWorkflows", () => ({ useBoardWorkflows: vi.fn() }));
vi.mock("../hooks/useMobileScrollLock", () => ({ useMobileScrollLock: vi.fn() }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
}));

const task = (id: string, column: string): Task => ({
  id, title: `task ${id}`, description: "", column,
  dependencies: [], steps: [], currentStep: 0, log: [],
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
} as unknown as Task);

function workflows(columns: { id: string; flags: Record<string, boolean> }[][]) {
  return {
    boardWorkflows: {
      defaultWorkflowId: "wf0",
      workflows: columns.map((cols, i) => ({ id: `wf${i}`, name: `wf${i}`, columns: cols })),
    },
  };
}

/*
The kept tasks render into a <datalist>, whose <option>s jsdom does not expose as role="option" —
so this reads the datalist's DOM directly. That list IS the filter's output.
*/
async function renderPickerTaskIds(): Promise<string[]> {
  const { container } = render(
    <ResearchTaskActionModal
      open
      mode="enrich"
      run={{ title: "run" } as never}
      finding={{ id: "f1", heading: "h", content: "c" }}
      projectId="p1"
      onClose={() => {}}
      onConfirm={async () => {}}
    />,
  );
  await waitFor(() => expect(fetchTasks).toHaveBeenCalled());
  await waitFor(() => {
    expect(container.querySelector("#research-task-action-task-list")).not.toBeNull();
  });
  const list = container.querySelector("#research-task-action-task-list");
  await waitFor(() => expect(list!.querySelectorAll("option").length).toBeGreaterThan(0));
  return [...list!.querySelectorAll("option")].map((o) => (o as HTMLOptionElement).value);
}

describe("the research picker hides archived tasks on ANY board, not just the legacy one", () => {
  beforeEach(() => vi.clearAllMocks());

  it("hides a task resting in a RENAMED archive lane", async () => {
    vi.mocked(fetchTasks).mockResolvedValue([task("FN-1", "building"), task("FN-2", "cold")] as never);
    vi.mocked(useBoardWorkflows).mockReturnValue(workflows([[
      { id: "building", flags: { archived: false } },
      { id: "cold", flags: { archived: true } },
    ]]) as never);

    // Before the fix this returned both: "cold" !== "archived", so the archived row survived.
    expect(await renderPickerTaskIds()).toEqual(["FN-1"]);
  });

  it("still hides the LEGACY archived id when the workflow declares it", async () => {
    vi.mocked(fetchTasks).mockResolvedValue([task("FN-1", "building"), task("FN-2", "archived")] as never);
    vi.mocked(useBoardWorkflows).mockReturnValue(workflows([[
      { id: "building", flags: { archived: false } },
      { id: "archived", flags: { archived: true } },
    ]]) as never);

    expect(await renderPickerTaskIds()).toEqual(["FN-1"]);
  });

  it("FAILS SOFT to the legacy id when no workflow resolved", async () => {
    // The pre-resolution answer. An unresolved board must behave exactly as the old literal did,
    // rather than showing archived rows because the flags map is empty.
    vi.mocked(fetchTasks).mockResolvedValue([task("FN-1", "building"), task("FN-2", "archived")] as never);
    vi.mocked(useBoardWorkflows).mockReturnValue({ boardWorkflows: null } as never);

    expect(await renderPickerTaskIds()).toEqual(["FN-1"]);
  });

  it("honours a SECOND workflow's archive lane through the cross-workflow union", async () => {
    vi.mocked(fetchTasks).mockResolvedValue([task("FN-1", "building"), task("FN-2", "retired")] as never);
    vi.mocked(useBoardWorkflows).mockReturnValue(workflows([
      [{ id: "building", flags: { archived: false } }],
      [{ id: "retired", flags: { archived: true } }],
    ]) as never);

    expect(await renderPickerTaskIds()).toEqual(["FN-1"]);
  });
});
