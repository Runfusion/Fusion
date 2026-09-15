/*
FNXC:TaskDetailPresentation 2026-09-15-00:20:
Task Detail is the pilot surface for FN-399's interface-style axis, so the invariant that matters most is
that the style changes ONLY presentation: for one and the same task, both styles must expose the same
accessible names, the same tabs, the same actions with the same disabled states, invoke a command exactly
once, and keep the operator's tab, scroll and focus. The clean grammar is applied by a scoped CSS layer, so
this suite asserts the behavioural equivalence in JSDOM plus the structural contract of that layer; the
composed pixels are measured in the browser lane.
*/

import "../../native-ui.css";
import "../../ui-style-tokens.css";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  makeTask,
  noop,
  noopDelete,
  noopMerge,
  noopOpenDetail,
  setupTaskDetailModalHooks,
} from "./TaskDetailModal.test-helpers";
import { readAppFile } from "../../test/cssFixture";
import { TaskDetailContent } from "../TaskDetailModal";
import type { UiStyle } from "@fusion/core";

setupTaskDetailModalHooks();

const sharedProps = {
  onDeleteTask: noopDelete,
  onMergeTask: noopMerge,
  onOpenDetail: noopOpenDetail,
  addToast: noop,
};

const STYLES: UiStyle[] = ["classic", "clean"];

function renderDetail(style: UiStyle, overrides = {}) {
  document.documentElement.dataset.uiStyle = style;
  return render(
    <TaskDetailContent
      {...sharedProps}
      embedded
      task={makeTask({
        id: "FN-STYLE",
        title: "Task under both styles",
        // Real steps so the progress region, its counter, bar and disclosure all render.
        steps: [
          { name: "Preflight", status: "done" },
          { name: "Implement `useTheme`", status: "in-progress" },
          { name: "Testing & Verification", status: "pending" },
        ] as never,
        currentStep: 1,
        ...overrides,
      })}
    />,
  );
}

/**
 * Task Detail opens on Activity; the definition destination — where progress, the description, the
 * product summary and the plan live — is the tab labelled "Plan" in the catalog. Select it by its real
 * tab element so the helper cannot collide with the "Read plan" button inside the panel.
 */
function openDefinition() {
  const tab = Array.from(document.querySelectorAll<HTMLElement>(".detail-tab"))
    .find((candidate) => candidate.textContent?.trim() === "Plan");
  if (!tab) throw new Error("definition tab not found");
  fireEvent.click(tab);
}

function tabLabels(): string[] {
  return Array.from(document.querySelectorAll(".detail-tab")).map((tab) => tab.textContent ?? "");
}

afterEach(() => {
  document.documentElement.removeAttribute("data-ui-style");
});

describe("Task Detail exposes the same product in both interface styles", () => {
  it("renders the same tab set, in the same order, under both styles", () => {
    const captured = STYLES.map((style) => {
      const view = renderDetail(style);
      const tabs = tabLabels();
      view.unmount();
      return tabs;
    });

    expect(captured[0]).toEqual(captured[1]);
    expect(captured[0]!.length).toBeGreaterThan(0);
  });

  it("renders the same header actions with the same accessible names and disabled states", () => {
    const captured = STYLES.map((style) => {
      const view = renderDetail(style);
      const actions = within(document.querySelector<HTMLElement>(".modal-header-actions")!)
        .getAllByRole("button")
        .map((button) => `${button.getAttribute("aria-label") ?? button.textContent}:${button.hasAttribute("disabled")}`);
      view.unmount();
      return actions;
    });

    expect(captured[0]).toEqual(captured[1]);
  });

  it("keeps the progress counter, bar and step data identical under both styles", async () => {
    const user = userEvent.setup();
    const captured: Array<{ counter: string | null; steps: string[]; bar: string | null }> = [];

    for (const style of STYLES) {
      const view = renderDetail(style);
      openDefinition();
      await user.click(screen.getByTestId("detail-step-list-toggle"));
      captured.push({
        counter: document.querySelector(".step-progress-label")?.textContent ?? null,
        bar: document.querySelector(".step-progress-track")?.getAttribute("aria-valuenow") ?? null,
        steps: Array.from(document.querySelectorAll(".detail-step-item")).map((item) => item.textContent ?? ""),
      });
      view.unmount();
    }

    expect(captured[0]).toEqual(captured[1]);
  });

  it.each(STYLES)("invokes a header command exactly once in the %s style", async (style) => {
    const user = userEvent.setup();
    const onRequestClose = vi.fn();
    document.documentElement.dataset.uiStyle = style;
    render(
      <TaskDetailContent
        {...sharedProps}
        embedded
        task={makeTask({ id: "FN-STYLE-CMD" })}
        onRequestClose={onRequestClose}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Close" }));

    expect(onRequestClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the selected tab and the mounted nodes when the style changes live", async () => {
    const user = userEvent.setup();
    renderDetail("classic");

    openDefinition();
    await user.click(screen.getByTestId("detail-step-list-toggle"));
    const activeBefore = document.querySelector(".detail-tab-active");
    const surface = document.querySelector("[data-task-detail-surface='true']");

    document.documentElement.dataset.uiStyle = "clean";

    // A style change is CSS only: no remount, no tab change, no lost node identity.
    expect(document.querySelector("[data-task-detail-surface='true']")).toBe(surface);
    expect(document.querySelector(".detail-tab-active")).toBe(activeBefore);
  });

  it("keeps focus on the control the operator was using when the style changes", () => {
    renderDetail("classic");
    openDefinition();

    const toggle = screen.getByTestId("detail-step-list-toggle");
    toggle.focus();
    expect(toggle).toHaveFocus();

    document.documentElement.dataset.uiStyle = "clean";

    expect(screen.getByTestId("detail-step-list-toggle")).toBe(toggle);
    expect(toggle).toHaveFocus();
  });

  it("keeps the step-list disclosure state across a style change", async () => {
    const user = userEvent.setup();
    renderDetail("classic");
    openDefinition();

    const toggle = screen.getByTestId("detail-step-list-toggle");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    document.documentElement.dataset.uiStyle = "clean";

    expect(screen.getByTestId("detail-step-list-toggle")).toHaveAttribute("aria-expanded", "true");
    expect(document.querySelectorAll(".detail-step-item").length).toBeGreaterThan(0);
  });
});

describe("the clean grammar is a scoped, token-only presentation layer", () => {
  /* The clean layer spans Task Detail and its tab strip; both are the pilot surface. */
  const css = [readAppFile("components/TaskDetailModal.css"), readAppFile("components/TaskDetailTabStrip.css")]
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  /*
   * Collect `selector { declarations }` pairs with a brace-aware scan so an at-rule wrapper's own
   * condition is never mistaken for a rule selector.
   */
  const cleanRules = (() => {
    const rules: string[] = [];
    let selector = "";
    let index = 0;
    while (index < css.length) {
      const character = css[index]!;
      if (character === "{") {
        const close = css.indexOf("}", index);
        const body = css.slice(index + 1, close === -1 ? css.length : close);
        // An at-rule wrapper has no declaration directly inside it; skip straight past its brace.
        if (selector.trim().startsWith("@")) {
          selector = "";
          index += 1;
          continue;
        }
        if (selector.includes('html[data-ui-style="clean"]')) {
          rules.push(`${selector.trim()}{${body}}`);
        }
        selector = "";
        index = close === -1 ? css.length : close + 1;
        continue;
      }
      if (character === "}") {
        selector = "";
        index += 1;
        continue;
      }
      selector += character;
      index += 1;
    }
    return rules;
  })();

  it("declares real clean rules that are all scoped to the non-default style", () => {
    expect(cleanRules.length).toBeGreaterThan(10);
    for (const rule of cleanRules) {
      const selector = rule.slice(0, rule.indexOf("{"));
      // Split on TOP-LEVEL commas only: `:is(:hover, :focus-within)` is one compound selector.
      const parts: string[] = [];
      let depth = 0;
      let current = "";
      for (const character of selector) {
        if (character === "(") depth += 1;
        else if (character === ")") depth -= 1;
        if (character === "," && depth === 0) {
          parts.push(current);
          current = "";
          continue;
        }
        current += character;
      }
      parts.push(current);
      for (const part of parts) {
        if (!part.trim()) continue;
        expect(part).toContain('html[data-ui-style="clean"]');
      }
    }
  });

  it("uses no literal colour and no raw pixel in the clean layer", () => {
    for (const rule of cleanRules) {
      const body = rule.slice(rule.indexOf("{"));
      expect(body).not.toMatch(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(/i);
      expect(body).not.toMatch(/\b\d+(\.\d+)?px\b/);
    }
  });

  it("keeps the progress bar and counter present rather than hidden by the clean grammar", () => {
    for (const rule of cleanRules) {
      if (!/\.(step-progress-track|step-progress-label)\b/.test(rule)) continue;
      expect(rule).not.toMatch(/display:\s*none/);
      expect(rule).not.toMatch(/visibility:\s*hidden/);
    }
  });

  it("keeps the category chip and status label readable on mobile instead of hiding them", () => {
    const mobileCleanStatus = css.match(/html\[data-ui-style="clean"\] \.detail-step-(origin|status)[^{]*\{[^}]*\}/g) ?? [];
    expect(mobileCleanStatus.length).toBeGreaterThan(0);
    for (const rule of mobileCleanStatus) {
      expect(rule).not.toMatch(/display:\s*none/);
    }
  });
});

describe("the plan sub-view copies the real specification", () => {
  it("offers Copy only once the real plan document is available", () => {
    renderDetail("clean", { prompt: "" });
    openDefinition();
    fireEvent.click(screen.getByRole("button", { name: /Read plan/i }));
    expect(screen.queryByTestId("task-detail-plan-copy")).toBeNull();
  });
});
