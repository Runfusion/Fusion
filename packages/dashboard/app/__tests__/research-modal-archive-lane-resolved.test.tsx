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
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

/*
FNXC:ResearchTaskModal 2026-08-01-01:20 (u12 — the regression MY archived-lane fix caused, now pinned):
#3215 (mine) added `isArchivedColumn` to the effect's dependency list to keep the task fetch honest.
That effect ALSO owned four setState calls, and `isArchivedColumn` is a useMemo over `useBoardWorkflows()`
— which revalidates asynchronously. Each revalidation re-ran the reset over whatever the operator had
typed, so a title entered before the workflows settled silently reverted to `Research: <heading>` and
the task was created with a title nobody wrote. Fixed in #3286 by splitting reset from fetch.

The four cases above could not see it: every one asserts the FILTERED TASK LIST and none types into the
form. I tested what I added and not what I touched, which is why this file gets the regression rather
than a new one.

Types with per-character `userEvent`, not `fireEvent.change`: the documented failure here is state being
overwritten between renders, and a single synthetic change event can land after the reset and mask it.
*/
describe("operator input survives board-workflow revalidation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps a typed title when useBoardWorkflows resolves afterwards", async () => {
    vi.mocked(fetchTasks).mockResolvedValue([task("FN-1", "building")] as never);
    // First render: workflows unresolved, exactly as when the operator opens the modal and types.
    vi.mocked(useBoardWorkflows).mockReturnValue({ boardWorkflows: null } as never);

    const { rerender } = render(
      <ResearchTaskActionModal
        open mode="create"
        run={{ title: "run" } as never}
        finding={{ id: "f1", heading: "h", content: "c" }}
        projectId="p1"
        onClose={() => {}}
        onConfirm={async () => {}}
      />,
    );

    const title = screen.getAllByRole("textbox")[0] as HTMLInputElement;
    await userEvent.clear(title);
    await userEvent.type(title, "Operator wrote this");
    expect(title.value).toBe("Operator wrote this");

    /* The revalidation. A NEW object identity is the whole point — a memo over it changes, and the
       pre-#3286 effect re-ran its setters on that change. */
    vi.mocked(useBoardWorkflows).mockReturnValue(workflows([[
      { id: "building", flags: { archived: false } },
      { id: "cold", flags: { archived: true } },
    ]]) as never);
    rerender(
      <ResearchTaskActionModal
        open mode="create"
        run={{ title: "run" } as never}
        finding={{ id: "f1", heading: "h", content: "c" }}
        projectId="p1"
        onClose={() => {}}
        onConfirm={async () => {}}
      />,
    );

    /* No fetch to await here: `fetchTasks` runs only in enrich mode, while the title field exists only
       in create mode — so the reset effect, not the fetch, is the thing under test. Settle the effects
       React ran for the rerender, then read the field back. */
    await waitFor(() => expect(vi.mocked(useBoardWorkflows)).toHaveBeenCalled());
    // Pre-#3286 this read "Research: h" — the derived default, over the operator's text.
    expect((screen.getAllByRole("textbox")[0] as HTMLInputElement).value).toBe("Operator wrote this");
  });
});
