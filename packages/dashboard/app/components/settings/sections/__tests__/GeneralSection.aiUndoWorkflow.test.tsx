// @vitest-environment jsdom
/**
 * FN-7578: component tests for the "AI-undo task workflow" picker added to
 * GeneralSection. Covers the Surface Enumeration data states: unset (shows the
 * builtin:review-heavy default), populated (stores the chosen id), explicit
 * inherit (stores the "" sentinel, not undefined), and a stale/deleted stored
 * id (renders without crashing).
 */
import { useState } from "react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import * as jestDomMatchers from "@testing-library/jest-dom/matchers";

import { GeneralSection } from "../GeneralSection";
import { SETTINGS_SECTIONS } from "../../../SettingsModal";
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
  { id: "builtin:review-heavy", name: "Review Heavy", ir: {} },
  { id: "builtin:coding", name: "Coding", ir: {} },
  { id: "WF-001", name: "Custom Workflow", ir: {} },
  { id: "WF-002-fragment", name: "Reusable Fragment", ir: {}, kind: "fragment" },
] as unknown as import("@fusion/core").WorkflowDefinition[];

beforeEach(() => {
  vi.mocked(fetchWorkflows).mockReset();
  vi.mocked(fetchWorkflows).mockResolvedValue(WORKFLOWS);
});
afterEach(() => cleanup());

function GeneralHost({ initialForm, onSetForm }: {
  initialForm: Partial<SettingsFormState>;
  onSetForm?: (updater: (f: SettingsFormState) => SettingsFormState) => void;
}) {
  const [form, setForm] = useState(initialForm as SettingsFormState);
  return (
    <GeneralSection
      form={form}
      setForm={(updater) => {
        setForm((prev) => {
          const next = (typeof updater === "function" ? (updater as (f: SettingsFormState) => SettingsFormState)(prev) : updater);
          onSetForm?.(() => next);
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

describe("GeneralSection - project controls", () => {
  it("renders the report menu and opens its guided modal", async () => {
    render(<GeneralHost initialForm={{}} />);

    fireEvent.click(screen.getByRole("button", { name: "Report" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Report bug" }));

    expect(await screen.findByRole("dialog", { name: "bug report" })).toBeInTheDocument();
  });

  it("advertises report actions through General settings search metadata", () => {
    const general = SETTINGS_SECTIONS.find((section) => section.id === "general");
    expect(general?.searchableText).toEqual(expect.arrayContaining(["report", "report bug", "send feedback", "share idea", "get help"]));
  });

  it("shows builtin:review-heavy as the effective default when unset", async () => {
    render(<GeneralHost initialForm={{}} />);

    const select = (await screen.findByTestId("ai-undo-workflow-select")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("builtin:review-heavy"));
  });

  it("stores the chosen workflow id when a workflow is selected", async () => {
    let latestForm: SettingsFormState | undefined;
    render(
      <GeneralHost
        initialForm={{}}
        onSetForm={(getNext) => {
          latestForm = getNext();
        }}
      />,
    );

    const select = (await screen.findByTestId("ai-undo-workflow-select")) as HTMLSelectElement;
    await waitFor(() => expect(select.querySelectorAll("option").length).toBeGreaterThan(1));

    fireEvent.change(select, { target: { value: "WF-001" } });

    await waitFor(() => expect(latestForm?.aiUndoTaskWorkflowId).toBe("WF-001"));
  });

  it("stores the empty-string inherit sentinel when 'Inherit project default workflow' is selected", async () => {
    let latestForm: SettingsFormState | undefined;
    render(
      <GeneralHost
        initialForm={{ aiUndoTaskWorkflowId: "builtin:coding" }}
        onSetForm={(getNext) => {
          latestForm = getNext();
        }}
      />,
    );

    const select = (await screen.findByTestId("ai-undo-workflow-select")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("builtin:coding"));

    fireEvent.change(select, { target: { value: "" } });

    await waitFor(() => {
      expect(latestForm?.aiUndoTaskWorkflowId).toBe("");
      expect(latestForm?.aiUndoTaskWorkflowId).not.toBeUndefined();
    });
  });

  it("renders a stale/deleted stored workflow id without crashing", async () => {
    render(<GeneralHost initialForm={{ aiUndoTaskWorkflowId: "WF-DELETED" }} />);

    const select = (await screen.findByTestId("ai-undo-workflow-select")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("WF-DELETED"));
    expect(screen.getByRole("option", { name: "WF-DELETED" })).toBeInTheDocument();
  });
});
