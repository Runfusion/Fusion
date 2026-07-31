import { render, screen, cleanup } from "@testing-library/react";
import { describe, expect, it, vi, afterEach } from "vitest";
import { MessageSquare, Repeat } from "lucide-react";
import type { WorkflowDefinition, WorkflowStepTemplate } from "@fusion/core";
import { WorkflowAddStepModal, type AddStepPaletteEntry } from "../WorkflowAddStepModal";
import { assertModalGeometryRecoveryAndSheetContracts, assertRenderedModalTouchGeometry } from "./floatingWindowMigration.test-helpers";
import { expectStableTyping } from "./typingStability.test-helpers";

/*
FNXC:WorkflowSimpleView 2026-07-12-14:30:
PR #2006 review coverage: when the add-step dialog targets an edge INSIDE a
container (disallowContainers), it must hide container palette kinds,
fragments (top-level subgraphs cannot splice into a template-child edge),
and the "as optional group" template variant — while keeping plain step
templates, which materialize a single sibling-safe node.
*/

const palette: AddStepPaletteEntry[] = [
  { kind: "prompt", label: "Prompt", icon: MessageSquare },
  { kind: "loop", label: "Loop", icon: Repeat },
];

const fragment = {
  id: "WF-FRAG",
  kind: "fragment",
  name: "Lint fragment",
  description: "",
  ir: { version: "v1", name: "Lint fragment", nodes: [], edges: [] },
  layout: {},
  createdAt: "2026-06-03T00:00:00.000Z",
  updatedAt: "2026-06-03T00:00:00.000Z",
} as WorkflowDefinition;

const stepTemplate = { id: "tpl-1", name: "Security review" } as WorkflowStepTemplate;

function renderModal(disallowContainers: boolean) {
  return render(
    <WorkflowAddStepModal
      open
      onClose={() => {}}
      palette={palette}
      disallowContainers={disallowContainers}
      fragments={[fragment]}
      stepTemplates={[stepTemplate]}
      pluginTemplates={[]}
      onPickPalette={vi.fn()}
      onPickFragment={vi.fn()}
      onPickStepTemplate={vi.fn()}
      onPickStepTemplateAsOptionalGroup={vi.fn()}
    />,
  );
}

describe("WorkflowAddStepModal", () => {
  afterEach(() => cleanup());


  /*
  FNXC:TypingStability 2026-07-26-22:15:
  Per-character typing guard. The FN-8606 floating-window migration made Planning Mode and Settings
  untypable and no test noticed, because field coverage here uses fireEvent.change, which never needs
  the input to stay mounted. This asserts the field keeps its DOM node, value, and focus while typed.
  */
  it("keeps the step search field mounted and focused while typing", async () => {
    renderModal(false);
    const field = screen.getByPlaceholderText("Search steps and templates…") as HTMLInputElement;
    await expectStableTyping(field, "sec", () => screen.getByPlaceholderText("Search steps and templates…"));
  });

  it("offers containers, fragments, and optional-group inserts for top-level targets", () => {
    renderModal(false);
    expect(screen.getByTestId("wf-add-step-loop-loop")).toBeInTheDocument();
    expect(screen.getByTestId("wf-add-step-fragment-WF-FRAG")).toBeInTheDocument();
    expect(screen.getByTestId("wf-add-step-tpl-tpl-1")).toBeInTheDocument();
    expect(screen.getByTestId("wf-add-step-tpl-tpl-1-optional-group")).toBeInTheDocument();
  });

  it("uses the real workflow dialog header for touch geometry", () => {
    renderModal(false);
    assertRenderedModalTouchGeometry("workflow-add-step", screen.getByRole("heading", { name: "Add a step" }).closest(".wf-add-step-header") as HTMLElement);
    assertModalGeometryRecoveryAndSheetContracts("workflow-add-step", () => renderModal(false));
  });

  it("hides containers, fragments, and optional-group inserts for container-internal targets", () => {
    renderModal(true);
    expect(screen.getByTestId("wf-add-step-prompt-prompt")).toBeInTheDocument();
    expect(screen.queryByTestId("wf-add-step-loop-loop")).not.toBeInTheDocument();
    expect(screen.queryByTestId("wf-add-step-fragment-WF-FRAG")).not.toBeInTheDocument();
    // Plain step templates remain — they insert a single sibling-safe node.
    expect(screen.getByTestId("wf-add-step-tpl-tpl-1")).toBeInTheDocument();
    expect(screen.queryByTestId("wf-add-step-tpl-tpl-1-optional-group")).not.toBeInTheDocument();
  });
});
