import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TaskDetailContent } from "../TaskDetailModal";
import {
  makeTask,
  noop,
  noopDelete,
  noopMerge,
  noopOpenDetail,
  readDashboardStylesSource,
  setupTaskDetailModalHooks,
} from "./TaskDetailModal.test-helpers";
import { loadComponentCss } from "../../test/cssFixture";

function readTaskDetailModalCss(): string {
  return loadComponentCss("TaskDetailModal.css");
}

function stripCssComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Returns the balanced `{ ... }` block that starts at or after `fromIndex`. */
function extractBlock(source: string, fromIndex: number): string {
  const start = source.indexOf("{", fromIndex);
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return source.slice(start);
}

setupTaskDetailModalHooks();

const fullPrompt = `# Task: FN-195 - Summary first

## What This Delivers

Operators can confirm the expected outcome quickly.

## Mission

Technical delivery details.

## Steps

### Step 1: Ship it
`;

function renderDefinition(options?: { id?: string; prompt?: string; description?: string; embedded?: boolean }) {
  return render(
    <TaskDetailContent
      task={makeTask({ id: options?.id ?? "FN-195", prompt: options?.prompt ?? fullPrompt, description: options?.description ?? "Keep **task intent** readable." })}
      initialTab="definition"
      embedded={options?.embedded}
      onRequestClose={noop}
      onDeleteTask={noopDelete}
      onMergeTask={noopMerge}
      onOpenDetail={noopOpenDetail}
      addToast={noop}
    />,
  );
}

function openPlan(): void {
  fireEvent.click(screen.getByRole("button", { name: "Read plan" }));
}

describe("TaskDetailContent internal plan navigation", () => {
  it("shows the read-only task description before the plan action", () => {
    renderDefinition();

    expect(screen.getByTestId("task-detail-definition-description")).toHaveTextContent("Keep task intent readable.");
    expect(screen.queryByTestId("task-detail-plan-full")).toBeNull();
    expect(screen.getByRole("button", { name: "Read plan" })).toBeInTheDocument();
  });

  it("opens the complete PROMPT.md and returns without a disclosure", () => {
    renderDefinition();
    openPlan();

    const plan = screen.getByTestId("task-detail-plan-full");
    expect(plan).toHaveTextContent("Operators can confirm the expected outcome quickly.");
    expect(plan).toHaveTextContent("Technical delivery details.");
    expect(screen.queryByTestId("task-detail-plan-details-toggle")).toBeNull();
    expect(document.querySelector(".detail-tabs")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Back to definition" }));
    expect(screen.getByTestId("task-detail-definition-description")).toBeInTheDocument();
    expect(document.querySelector(".detail-tabs")).toBeInTheDocument();
  });

  it("renders legacy and summary-shaped plans through the same complete viewer", () => {
    renderDefinition({ prompt: "# Legacy\n\n## Mission\n\nLegacy plan stays visible." });
    openPlan();
    expect(screen.getByTestId("task-detail-plan-full")).toHaveTextContent("Legacy plan stays visible.");
  });

  it("keeps empty description and prompt states explicit", () => {
    renderDefinition({ description: "", prompt: "" });
    expect(screen.getByText("(no description)")).toBeInTheDocument();
    openPlan();
    expect(screen.getByText("(no prompt)")).toBeInTheDocument();
  });

  it("resets the internal plan route when task identity changes", () => {
    const view = renderDefinition({ id: "FN-FIRST", embedded: true });
    openPlan();
    expect(screen.getByTestId("task-detail-plan-document")).toBeInTheDocument();

    view.rerender(
      <TaskDetailContent
        task={makeTask({ id: "FN-SECOND", prompt: fullPrompt, description: "Second description" })}
        initialTab="definition"
        embedded
        onRequestClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );
    expect(screen.queryByTestId("task-detail-plan-document")).toBeNull();
    expect(screen.getByTestId("task-detail-definition-description")).toHaveTextContent("Second description");
  });

  /*
  FNXC:TaskDetailPresentation 2026-09-15-16:02:
  FN-424 removed the inline edit textarea with the Edit action that opened it. What survives is the
  guarantee the textarea used to carry: the sub-view shows the COMPLETE prompt.
  */
  it("renders the complete prompt read-only with no edit textarea", () => {
    renderDefinition();
    openPlan();

    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(document.querySelector(".spec-editor-textarea")).toBeNull();
    const plan = screen.getByTestId("task-detail-plan-full");
    expect(plan).toHaveTextContent("Operators can confirm the expected outcome quickly.");
    expect(plan).toHaveTextContent("Technical delivery details.");
    expect(plan).toHaveTextContent("Ship it");
  });

  /*
  FNXC:TaskDetailDefinition 2026-09-14-20:20:
  FN-391 shows a product-language outcome above `Read plan`, selected from the plan the task already
  has — no second AI call, no new plan section. `What This Delivers` wins; a legacy plan falls back
  to `Before → After Transformation`; `Mission` is NEVER used, because the operator's complaint was
  precisely that Mission is too technical to read at a glance. `Read plan` keeps showing the
  complete PROMPT.md, Mission included.
  */
  it("prefers What This Delivers for the product outcome", () => {
    renderDefinition();

    const outcome = screen.getByTestId("task-detail-definition-outcome");
    expect(outcome).toHaveTextContent("Operators can confirm the expected outcome quickly.");
    expect(outcome).not.toHaveTextContent("Technical delivery details.");
  });

  it("falls back to Before → After Transformation for a legacy plan", () => {
    renderDefinition({ prompt: "# Task: FN-195 - Legacy\n\n## Before → After Transformation\n\nBefore it was manual; after it is automatic.\n\n## Mission\n\nTechnical delivery details.\n" });

    expect(screen.getByTestId("task-detail-definition-outcome")).toHaveTextContent("Before it was manual; after it is automatic.");
  });

  it.each([
    { label: "a Mission-only plan", prompt: "# Task: FN-195 - Mission only\n\n## Mission\n\nTechnical delivery details.\n" },
    { label: "an empty plan", prompt: "" },
    { label: "an empty What This Delivers section", prompt: "# Task: FN-195 - Empty\n\n## What This Delivers\n\n## Mission\n\nTechnical delivery details.\n" },
  ])("shows the localized placeholder for $label and never the Mission", ({ prompt }) => {
    renderDefinition({ prompt });

    expect(screen.queryByTestId("task-detail-definition-outcome")).toBeNull();
    expect(screen.getByTestId("task-detail-definition-outcome-empty")).toBeInTheDocument();
    expect(screen.getByTestId("task-detail-definition-outcome-empty")).not.toHaveTextContent("Technical delivery details.");
  });

  it("ignores a summary heading inside a code fence and uses only the first real one", () => {
    renderDefinition({
      prompt: "# Task: FN-195 - Fenced\n\n```md\n## What This Delivers\n\nFenced example text.\n```\n\n## What This Delivers\n\nThe real product outcome.\n\n## What This Delivers\n\nA duplicated heading.\n",
    });

    const outcome = screen.getByTestId("task-detail-definition-outcome");
    expect(outcome).toHaveTextContent("The real product outcome.");
    expect(outcome).not.toHaveTextContent("Fenced example text.");
    expect(outcome).not.toHaveTextContent("A duplicated heading.");
  });

  it("keeps Read plan beside the outcome and still opens the complete plan", () => {
    renderDefinition();

    const readPlan = screen.getByRole("button", { name: "Read plan" });
    expect(readPlan.closest(".detail-definition-outcome")).toBeInTheDocument();

    openPlan();
    const plan = screen.getByTestId("task-detail-plan-full");
    expect(plan).toHaveTextContent("Technical delivery details.");
    expect(plan).toHaveTextContent("Operators can confirm the expected outcome quickly.");
  });

  it("never leaks the previous task's outcome after a task change", () => {
    const view = renderDefinition({ id: "FN-FIRST", embedded: true });
    expect(screen.getByTestId("task-detail-definition-outcome")).toHaveTextContent("Operators can confirm the expected outcome quickly.");

    view.rerender(
      <TaskDetailContent
        task={makeTask({ id: "FN-SECOND", prompt: "# Task: FN-SECOND - Second\n\n## What This Delivers\n\nA different outcome entirely.\n", description: "Second description" })}
        initialTab="definition"
        embedded
        onRequestClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    const outcome = screen.getByTestId("task-detail-definition-outcome");
    expect(outcome).toHaveTextContent("A different outcome entirely.");
    expect(outcome).not.toHaveTextContent("Operators can confirm the expected outcome quickly.");
  });

  it("bounds the read-only description with token-only scrolling rules", () => {
    renderDefinition({ description: `${"Long description paragraph. ".repeat(60)}` });

    const body = screen.getByTestId("task-detail-definition-description");
    expect(body).toHaveClass("detail-definition-description-body");
    expect(body).toHaveAttribute("tabindex", "0");

    const css = readTaskDetailModalCss();
    const selectorIndex = css.indexOf(".detail-definition-description-body {");
    expect(selectorIndex).toBeGreaterThan(-1);
    const rule = css.slice(selectorIndex, css.indexOf("}", selectorIndex) + 1);
    expect(rule).toContain("overflow-y: auto");
    expect(rule).toContain("max-block-size");
    expect(rule).not.toMatch(/#[0-9a-f]{3,}|rgb\(/i);
  });

  /*
  FNXC:TaskDetailDefinition 2026-09-15-19:26:
  FN-430: le bloc de description borné doit chaîner son scroll vers `.detail-body` une fois son
  contenu épuisé (pas de `overscroll-behavior: contain` sur l'axe bloc) et sa borne de hauteur est
  divisée par deux. jsdom n'implémente pas le chaînage natif: la condition d'échec est donc prouvée
  disparue sur la source CSS effectivement chargée, plus un inventaire qui empêche la réintroduction
  silencieuse du confinement sur un bloc de contenu en flux.
  */
  describe("FN-430 description scroll chaining", () => {
    it("chains block-axis scrolling to the parent and halves the desktop height bound", () => {
      renderDefinition({ description: `${"Long description paragraph. ".repeat(60)}` });

      const css = readTaskDetailModalCss();
      const selectorIndex = css.indexOf(".detail-definition-description-body {");
      expect(selectorIndex).toBeGreaterThan(-1);
      const rule = css.slice(selectorIndex, css.indexOf("}", selectorIndex) + 1);

      expect(rule).toContain("overflow-y: auto");
      expect(rule).toContain("overscroll-behavior: auto");
      expect(rule).not.toContain("overscroll-behavior: contain");
      expect(rule).toContain("max-block-size: var(--task-detail-description-max-block-size, 9rem)");
    });

    it("halves the mobile height bound without re-introducing containment", () => {
      const css = readTaskDetailModalCss();
      const mediaIndex = css.indexOf("@media (max-width: 768px) {");
      expect(mediaIndex).toBeGreaterThan(-1);
      const mediaBlock = extractBlock(css, mediaIndex);

      const selectorIndex = mediaBlock.indexOf(".detail-definition-description-body {");
      expect(selectorIndex).toBeGreaterThan(-1);
      const rule = mediaBlock.slice(selectorIndex, mediaBlock.indexOf("}", selectorIndex) + 1);

      expect(rule).toContain("max-block-size: var(--task-detail-description-max-block-size-mobile, 6rem)");
      expect(rule).not.toContain("overscroll-behavior");
    });

    it("keeps the populated description focusable and grouped", () => {
      renderDefinition({ description: `${"Long description paragraph. ".repeat(60)}` });

      const body = screen.getByTestId("task-detail-definition-description");
      expect(body).toHaveClass("detail-definition-description-body");
      expect(body).toHaveAttribute("tabindex", "0");
      expect(body).toHaveAttribute("role", "group");
    });

    it("renders no bounded scroller when the description is empty", () => {
      const { container } = renderDefinition({ description: "   " });

      expect(screen.queryByTestId("task-detail-definition-description")).toBeNull();
      expect(container.querySelector(".detail-empty-inline")).not.toBeNull();
    });

    it("confines block-axis overscroll only on the floating activity menu", () => {
      const source = stripCssComments(readTaskDetailModalCss());
      const confined: string[] = [];
      const declaration = /overscroll-behavior:\s*contain/g;

      for (let match = declaration.exec(source); match; match = declaration.exec(source)) {
        const openBrace = source.lastIndexOf("{", match.index);
        const previousBoundary = Math.max(
          source.lastIndexOf("}", openBrace),
          source.lastIndexOf("{", openBrace - 1),
        );
        confined.push(source.slice(previousBoundary + 1, openBrace).trim());
      }

      expect(confined).toEqual([".activity-view-menu"]);
    });
  });

  /*
  FNXC:TaskDetailDefinition 2026-09-16-19:45:
  FN-472: quand la description déborde, sa barre de défilement doit être visible en permanence pour
  signaler le contenu masqué. jsdom ne peint aucune barre native et n'expose ni piste ni pouce: la
  preuve déterministe porte donc sur la feuille de style effectivement chargée (`loadComponentCss`)
  plus l'identité DOM du scroller, substitut déjà établi par FN-430 dans ce même fichier.
  */
  describe("FN-472 persistent description scrollbar", () => {
    const longDescription = `${"Long description paragraph. ".repeat(60)}`;

    function descriptionRule(): string {
      const css = readTaskDetailModalCss();
      const selectorIndex = css.indexOf(".detail-definition-description-body {");
      expect(selectorIndex).toBeGreaterThan(-1);
      return extractBlock(css, selectorIndex);
    }

    function pseudoBlock(selector: string): string {
      const css = stripCssComments(readTaskDetailModalCss());
      const selectorIndex = css.indexOf(selector);
      expect(selectorIndex).toBeGreaterThan(-1);
      return extractBlock(css, selectorIndex);
    }

    it("paints both the track and the thumb and reserves a stable gutter", () => {
      renderDefinition({ description: longDescription });

      const rule = descriptionRule();
      expect(rule).toContain("scrollbar-gutter: stable");
      expect(rule).toContain("scrollbar-width: thin");
      expect(rule).not.toContain("scrollbar-width: none");

      const colorMatch = /scrollbar-color:([^;]+);/.exec(rule);
      expect(colorMatch).not.toBeNull();
      const scrollbarColor = colorMatch?.[1] ?? "";
      expect(scrollbarColor.match(/color-mix\(/g) ?? []).toHaveLength(2);
      expect(scrollbarColor).not.toMatch(/\btransparent\s*$/);

      expect(rule).toContain("overflow-y: auto");
      expect(rule).not.toContain("overflow-y: scroll");
      expect(rule).toContain("max-block-size: var(--task-detail-description-max-block-size, 9rem)");
    });

    it("declares painted WebKit track and thumb pseudo-elements", () => {
      const track = pseudoBlock(".detail-definition-description-body::-webkit-scrollbar-track {");
      const thumb = pseudoBlock(".detail-definition-description-body::-webkit-scrollbar-thumb {");

      for (const block of [track, thumb]) {
        expect(block).toMatch(/background:\s*color-mix\(/);
        expect(block).not.toMatch(/background:\s*(transparent|none)\s*;/);
      }
      expect(thumb).toContain("min-block-size: var(--space-");

      const css = stripCssComments(readTaskDetailModalCss());
      const scrollbarSelector = /\.detail-definition-description-body::-webkit-scrollbar[\w-]*(:hover)?\s*\{/g;
      for (let match = scrollbarSelector.exec(css); match; match = scrollbarSelector.exec(css)) {
        expect(extractBlock(css, match.index)).not.toContain("display: none");
      }
    });

    it("stays token-only and never re-declares a local pixel scrollbar width", () => {
      const css = stripCssComments(readTaskDetailModalCss());
      const blocks = [
        descriptionRule(),
        pseudoBlock(".detail-definition-description-body::-webkit-scrollbar-track {"),
        pseudoBlock(".detail-definition-description-body::-webkit-scrollbar-thumb {"),
      ];
      for (const block of blocks) {
        expect(block).not.toMatch(/#[0-9a-f]{3,}/i);
        expect(block).not.toMatch(/[^s]rgb\(/i);
        expect(block).not.toMatch(/\d+px/);
      }

      expect(css).not.toContain(".detail-definition-description-body::-webkit-scrollbar {");
    });

    it("keeps the mobile override to its height bound only", () => {
      const css = readTaskDetailModalCss();
      const mediaIndex = css.indexOf("@media (max-width: 768px) {");
      expect(mediaIndex).toBeGreaterThan(-1);
      const mediaBlock = extractBlock(css, mediaIndex);

      const selectorIndex = mediaBlock.indexOf(".detail-definition-description-body {");
      expect(selectorIndex).toBeGreaterThan(-1);
      const rule = extractBlock(mediaBlock, selectorIndex);

      expect(rule).toContain("max-block-size: var(--task-detail-description-max-block-size-mobile, 6rem)");
      expect(rule).not.toContain("overscroll-behavior");
      expect(rule).not.toContain("scrollbar-width: none");
      expect(rule).not.toContain("display: none");
    });

    it.each([{ embedded: false }, { embedded: true }])("keeps the scroller identity stable across hosts and task changes (embedded: $embedded)", ({ embedded }) => {
      const view = renderDefinition({ id: "FN-FIRST", description: longDescription, embedded });

      const body = screen.getByTestId("task-detail-definition-description");
      expect(body).toHaveClass("detail-definition-description-body");
      expect(body).toHaveAttribute("tabindex", "0");
      expect(body).toHaveAttribute("role", "group");

      view.rerender(
        <TaskDetailContent
          task={makeTask({ id: "FN-SECOND", prompt: fullPrompt, description: `${"Another long paragraph. ".repeat(60)}` })}
          initialTab="definition"
          embedded={embedded}
          onRequestClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const next = screen.getByTestId("task-detail-definition-description");
      expect(next).toHaveClass("detail-definition-description-body");
      expect(next).toHaveAttribute("tabindex", "0");
      expect(next).toHaveAttribute("role", "group");
    });

    it("paints no scrollbar affordance when there is nothing to scroll", () => {
      const { container } = renderDefinition({ description: "   " });

      expect(screen.queryByTestId("task-detail-definition-description")).toBeNull();
      expect(container.querySelector(".detail-definition-description-body")).toBeNull();
      expect(container.querySelector(".detail-empty-inline")).not.toBeNull();
    });
  });

  it("uses token-only responsive styles for definition and plan navigation", () => {
    const css = readDashboardStylesSource();
    const selector = ".detail-definition-description {";
    const selectorIndex = css.indexOf(selector);
    const rule = css.slice(selectorIndex, css.indexOf("}", selectorIndex) + 1);
    expect(selectorIndex).toBeGreaterThan(-1);
    expect(rule).toContain("var(--space-md)");
    expect(rule).not.toMatch(/#[0-9a-f]|rgb\(|\d+px/i);
  });
});

/*
FNXC:TaskDetailDefinition 2026-09-15-16:02:
FN-424 renders the plan's `Before → After Transformation` as a DIRECT section below
`What this delivers`. It never duplicates a body already shown as the legacy outcome fallback, and
it renders nothing (not a placeholder) when the plan has no such section.
*/
const bothSectionsPrompt = `# Task: FN-195 - Summary first

## What This Delivers

Operators can confirm the expected outcome quickly.

## Before → After Transformation

- **Before:** the operator had to open the full plan.
- **After:** the transformation is visible at a glance.

## Mission

Technical delivery details.
`;

describe("TaskDetailContent definition before/after section", () => {
  it.each([{ embedded: false }, { embedded: true }])("shows the before/after body under the outcome (embedded: $embedded)", ({ embedded }) => {
    renderDefinition({ prompt: bothSectionsPrompt, embedded });

    const transformation = screen.getByTestId("task-detail-definition-transformation");
    expect(transformation).toHaveTextContent("the transformation is visible at a glance.");
    expect(screen.getByTestId("task-detail-definition-outcome")).not.toHaveTextContent("the transformation is visible at a glance.");
    expect(transformation).not.toHaveTextContent("Technical delivery details.");
    expect(screen.getByRole("heading", { name: "Before → After" })).toBeInTheDocument();
  });

  it("keeps the reading order progress, description, outcome, before/after", () => {
    const { container } = renderDefinition({ prompt: bothSectionsPrompt });

    const order = Array.from(container.querySelectorAll(".detail-step-progress, .detail-definition-description, .detail-definition-outcome, .detail-definition-transformation")).map((node) => {
      if (node.classList.contains("detail-step-progress")) return "progress";
      if (node.classList.contains("detail-definition-description")) return "description";
      if (node.classList.contains("detail-definition-outcome")) return "outcome";
      return "transformation";
    });

    expect(order).toEqual(["progress", "description", "outcome", "transformation"]);
  });

  it("never duplicates a before/after body already served as the legacy outcome", () => {
    renderDefinition({ prompt: "# Task: FN-195 - Legacy\n\n## Before → After Transformation\n\nBefore it was manual; after it is automatic.\n\n## Mission\n\nTechnical delivery details.\n" });

    expect(screen.getByTestId("task-detail-definition-outcome")).toHaveTextContent("Before it was manual; after it is automatic.");
    expect(screen.queryByTestId("task-detail-definition-transformation")).toBeNull();
  });

  it.each([
    { label: "a plan without the section", prompt: fullPrompt },
    { label: "an empty before/after section", prompt: "# Task: FN-195 - Empty\n\n## What This Delivers\n\nOutcome.\n\n## Before → After Transformation\n\n## Mission\n\nTechnical delivery details.\n" },
    { label: "an empty plan", prompt: "" },
  ])("renders no section and no placeholder for $label", ({ prompt }) => {
    const { container } = renderDefinition({ prompt });

    expect(screen.queryByTestId("task-detail-definition-transformation")).toBeNull();
    expect(container.querySelector(".detail-definition-transformation")).toBeNull();
  });

  it("ignores a fenced or duplicated before/after heading", () => {
    renderDefinition({
      prompt: "# Task: FN-195 - Fenced\n\n## What This Delivers\n\nOutcome.\n\n```md\n## Before → After Transformation\n\nFenced example text.\n```\n\n## Before → After Transformation\n\nThe real transformation.\n\n## Before → After Transformation\n\nA duplicated heading.\n",
    });

    const transformation = screen.getByTestId("task-detail-definition-transformation");
    expect(transformation).toHaveTextContent("The real transformation.");
    expect(transformation).not.toHaveTextContent("Fenced example text.");
    expect(transformation).not.toHaveTextContent("A duplicated heading.");
  });

  /*
  FNXC:TaskDetailDefinition 2026-09-15-16:02:
  FN-424 gives the four definition blocks a padded card treatment. The rule must stay token-only:
  no raw pixel, hex or rgb() value, on desktop and on the mobile override.
  */
  it("gives the four definition blocks a token-only card treatment", () => {
    const css = readTaskDetailModalCss();
    const selector = ".detail-step-progress,\n.detail-definition-description,\n.detail-definition-outcome,\n.detail-definition-transformation {";
    const selectorIndex = css.indexOf(selector);
    expect(selectorIndex).toBeGreaterThan(-1);

    const rule = css.slice(selectorIndex, css.indexOf("}", selectorIndex) + 1);
    expect(rule).toContain("padding: var(--space-");
    expect(rule).toContain("border-radius: var(--radius-");
    expect(rule).toContain("solid var(--border)");
    expect(rule).toContain("background: var(--surface)");
    expect(rule).not.toMatch(/#[0-9a-f]{3,}|rgb\(|\d+px/i);

    const rowIndex = css.indexOf(".detail-progress-row {");
    expect(rowIndex).toBeGreaterThan(-1);
    const rowRule = css.slice(rowIndex, css.indexOf("}", rowIndex) + 1);
    expect(rowRule).toContain("display: flex");
    expect(rowRule).toContain("align-items: center");
    expect(rowRule).not.toMatch(/#[0-9a-f]{3,}|rgb\(|\d+px/i);
  });

  it("never leaks the previous task's before/after after a task change", () => {
    const view = renderDefinition({ id: "FN-FIRST", prompt: bothSectionsPrompt, embedded: true });
    expect(screen.getByTestId("task-detail-definition-transformation")).toHaveTextContent("the transformation is visible at a glance.");

    view.rerender(
      <TaskDetailContent
        task={makeTask({ id: "FN-SECOND", prompt: "# Task: FN-SECOND - Second\n\n## What This Delivers\n\nA different outcome entirely.\n", description: "Second description" })}
        initialTab="definition"
        embedded
        onRequestClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    expect(screen.queryByTestId("task-detail-definition-transformation")).toBeNull();
  });
});
