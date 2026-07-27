// @vitest-environment jsdom
/**
 * FNXC:OriginWorkflowSelection 2026-07-26-19:40:
 * Component tests for the two origin-workflow pickers added to GeneralSection —
 * "CLI/agent-created task workflow" (`taskCreateWorkflowId`) and "Refinement task
 * workflow" (`refinementTaskWorkflowId`).
 *
 * Both pickers are asserted against every rule rather than one of them being taken
 * as representative: they are separate settings whose whole point is independence,
 * so a shared-state bug would only show up if both are exercised.
 *
 * Data states covered: unset (must show "Selected workflow", NOT a blank option),
 * populated, explicitly re-selecting "Selected workflow" (stores the "" sentinel,
 * which the resolver reads as unpinned — storing `undefined` would be a different
 * value on the wire), a stale/deleted stored id (renders it instead of silently
 * falling back to a different workflow), and fragment exclusion (a fragment is a
 * palette piece and must never be offerable as a task's workflow).
 */
import { useState } from "react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import * as jestDomMatchers from "@testing-library/jest-dom/matchers";

import { GeneralSection } from "../GeneralSection";
import type { SettingsFormState } from "../context";
import { fetchWorkflows } from "../../../../api";

vi.mock("react-i18next", async (importOriginal) => ({
  ...await importOriginal<typeof import("react-i18next")>(),
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

vi.mock("../../../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../api")>();
  return {
    ...actual,
    fetchWorkflows: vi.fn(),
  };
});

expect.extend(jestDomMatchers);

const WORKFLOWS = [
  { id: "builtin:coding", name: "Coding", ir: {} },
  { id: "builtin:review-heavy", name: "Review Heavy", ir: {} },
  { id: "WF-001", name: "Custom Workflow", ir: {} },
  { id: "WF-002-fragment", name: "Reusable Fragment", ir: {}, kind: "fragment" },
] as unknown as import("@fusion/core").WorkflowDefinition[];

/** testid -> the settings key that picker writes. */
const PICKERS = [
  { testId: "task-create-workflow-select", formKey: "taskCreateWorkflowId" },
  { testId: "refinement-task-workflow-select", formKey: "refinementTaskWorkflowId" },
] as const;

beforeEach(() => {
  vi.mocked(fetchWorkflows).mockReset();
  vi.mocked(fetchWorkflows).mockResolvedValue(WORKFLOWS);
});
afterEach(() => cleanup());

function GeneralHost({ initialForm, onSetForm }: {
  initialForm: Partial<SettingsFormState>;
  onSetForm?: (next: SettingsFormState) => void;
}) {
  const [form, setForm] = useState(initialForm as SettingsFormState);
  return (
    <GeneralSection
      form={form}
      setForm={(updater) => {
        setForm((prev) => {
          const next = (typeof updater === "function" ? (updater as (f: SettingsFormState) => SettingsFormState)(prev) : updater);
          onSetForm?.(next);
          return next;
        });
      }}
      addToast={vi.fn()}
      prefixError={null}
      setPrefixError={vi.fn()}
      projectTrackingRepoOptions={[]}
      projectTrackingRepoLoading={false}
      projectTrackingRepoError={null}
    />
  );
}

async function renderAndGet(testId: string, initialForm: Partial<SettingsFormState> = {}, onSetForm?: (next: SettingsFormState) => void) {
  render(<GeneralHost initialForm={initialForm} onSetForm={onSetForm} />);
  const select = await screen.findByTestId(testId) as HTMLSelectElement;
  // The option list arrives from the async fetchWorkflows; wait for it before asserting.
  await waitFor(() => expect(within(select).getByRole("option", { name: "Custom Workflow" })).toBeInTheDocument());
  return select;
}

describe.each(PICKERS)("GeneralSection origin workflow picker: $formKey", ({ testId, formKey }) => {
  it('defaults an unset setting to the "Selected workflow" option', async () => {
    const select = await renderAndGet(testId);
    expect(select.value).toBe("");
    expect(within(select).getByRole("option", { name: "Selected workflow" })).toBeInTheDocument();
  });

  it("writes the chosen workflow id into the form", async () => {
    const onSetForm = vi.fn();
    const select = await renderAndGet(testId, {}, onSetForm);

    fireEvent.change(select, { target: { value: "WF-001" } });

    await waitFor(() => expect(onSetForm).toHaveBeenCalled());
    expect(onSetForm.mock.calls.at(-1)?.[0][formKey]).toBe("WF-001");
  });

  it('writes the "" sentinel when the operator returns to "Selected workflow"', async () => {
    const onSetForm = vi.fn();
    const select = await renderAndGet(testId, { [formKey]: "WF-001" } as Partial<SettingsFormState>, onSetForm);
    expect(select.value).toBe("WF-001");

    fireEvent.change(select, { target: { value: "" } });

    await waitFor(() => expect(onSetForm).toHaveBeenCalled());
    expect(onSetForm.mock.calls.at(-1)?.[0][formKey]).toBe("");
  });

  it("renders a stale/deleted stored id rather than silently showing a different workflow", async () => {
    const select = await renderAndGet(testId, { [formKey]: "WF-deleted" } as Partial<SettingsFormState>);
    expect(select.value).toBe("WF-deleted");
    expect(within(select).getByRole("option", { name: "WF-deleted" })).toBeInTheDocument();
  });

  it("never offers a fragment as a selectable workflow", async () => {
    const select = await renderAndGet(testId);
    expect(within(select).queryByRole("option", { name: "Reusable Fragment" })).toBeNull();
  });
});

describe("GeneralSection origin workflow pickers are independent", () => {
  it("pinning one origin leaves the other on Selected workflow", async () => {
    render(<GeneralHost initialForm={{ taskCreateWorkflowId: "WF-001" } as Partial<SettingsFormState>} />);

    const taskCreate = await screen.findByTestId("task-create-workflow-select") as HTMLSelectElement;
    const refinement = await screen.findByTestId("refinement-task-workflow-select") as HTMLSelectElement;

    await waitFor(() => expect(within(taskCreate).getByRole("option", { name: "Custom Workflow" })).toBeInTheDocument());
    expect(taskCreate.value).toBe("WF-001");
    expect(refinement.value).toBe("");
  });

  it("changing one picker does not move the other", async () => {
    render(<GeneralHost initialForm={{}} />);

    const taskCreate = await screen.findByTestId("task-create-workflow-select") as HTMLSelectElement;
    const refinement = await screen.findByTestId("refinement-task-workflow-select") as HTMLSelectElement;
    await waitFor(() => expect(within(taskCreate).getByRole("option", { name: "Custom Workflow" })).toBeInTheDocument());

    fireEvent.change(refinement, { target: { value: "builtin:review-heavy" } });

    await waitFor(() => expect(refinement.value).toBe("builtin:review-heavy"));
    expect(taskCreate.value).toBe("");
  });

  // The AI-undo picker shares the same workflow list and sits beside these two;
  // pin that it kept its own distinct default so the shared list did not flatten them.
  it("leaves the neighbouring AI-undo picker on its own review-heavy default", async () => {
    render(<GeneralHost initialForm={{}} />);
    const aiUndo = await screen.findByTestId("ai-undo-workflow-select") as HTMLSelectElement;
    await waitFor(() => expect(within(aiUndo).getByRole("option", { name: "Custom Workflow" })).toBeInTheDocument());
    expect(aiUndo.value).toBe("builtin:review-heavy");
  });
});
