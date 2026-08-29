/* @vitest-environment jsdom */
/*
FNXC:QuickAddActionRow 2026-08-13-07:38:
## Symptom Verification
At tablet widths the Quick Add row previously inherited the centered desktop layout. This declaration
guard requires the base desktop cluster and 769px–1024px and <=768px edge-to-edge overrides.

## Surface Enumeration
QuickEntryBox shares this stylesheet across Board, List, modal, Chat, and floating hosts. This test
covers sparse rendered groups, Save-last DOM order, and no spacer shell. jsdom cannot lay out flexbox,
so CSS assertions are a source-contract guard rather than visual layout proof.
*/
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { QuickEntryBox } from "../components/QuickEntryBox";

vi.mock("../api", () => ({
  fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] }),
  fetchSettings: vi.fn().mockResolvedValue({ modelPresets: [], autoSelectModelPreset: false, defaultPresetBySize: {} }),
  fetchAgents: vi.fn().mockResolvedValue([]),
  fetchWorkflowOptionalSteps: vi.fn().mockResolvedValue([]),
  uploadAttachment: vi.fn().mockResolvedValue({}),
  updateGlobalSettings: vi.fn().mockResolvedValue({}),
}));

vi.mock("lucide-react", () => ({
  Link: () => null,
  Paperclip: () => null,
  Brain: () => null,
  Lightbulb: () => null,
  ListTree: () => null,
  Sparkles: () => null,
  Save: () => null,
  Play: () => null,
  X: () => null,
  ChevronDown: () => null,
  ChevronUp: () => null,
  ChevronRight: () => null,
  Bot: () => null,
  Server: () => null,
  ArrowDown: () => null,
  ArrowUp: () => null,
  Flag: () => null,
  TriangleAlert: () => null,
  Zap: () => null,
  Eye: () => null,
  EyeOff: () => null,
  Github: () => null,
  Maximize2: () => null,
  Minimize2: () => null,
}));
vi.mock("../components/ModelSelectionModal", () => ({ ModelSelectionModal: () => null }));
vi.mock("../components/CustomModelDropdown", () => ({ CustomModelDropdown: () => null }));
vi.mock("../hooks/useComposerDictation", () => ({
  useComposerDictation: () => ({ micProps: { enabled: false, supported: false, state: "idle", start: vi.fn(), stop: vi.fn() } }),
}));

const css = readFileSync(resolve(__dirname, "../components/QuickEntryBox.css"), "utf8");

function ruleBody(selector: string): { body: string; index: number } {
  const index = css.indexOf(`${selector} {`);
  expect(index, `rule "${selector}" must exist`).toBeGreaterThan(-1);
  const start = css.indexOf("{", index) + 1;
  let depth = 1;
  let cursor = start;
  while (cursor < css.length && depth > 0) {
    if (css[cursor] === "{") depth += 1;
    if (css[cursor] === "}") depth -= 1;
    cursor += 1;
  }
  return { body: css.slice(start, cursor - 1), index };
}

function isInsideMediaQuery(index: number): boolean {
  const before = css.slice(0, index);
  const stack: boolean[] = [];
  for (const match of before.matchAll(/@media[^{]*\{|\{|\}/g)) {
    if (match[0].startsWith("@media")) stack.push(true);
    else if (match[0] === "{") stack.push(false);
    else stack.pop();
  }
  return stack.some(Boolean);
}

function mobileSection(): string {
  const marker = css.indexOf("Quick Entry Mobile Touch + Overflow Fixes");
  const start = css.indexOf("@media (max-width: 768px)", marker);
  const end = css.indexOf("\n@media", start + 1);
  expect(marker).toBeGreaterThan(-1);
  expect(start).toBeGreaterThan(marker);
  expect(end).toBeGreaterThan(start);
  return css.slice(start, end);
}

function tabletSection(): string {
  const start = css.indexOf("@media (min-width: 769px) and (max-width: 1024px)");
  expect(start, "tablet tier must exist").toBeGreaterThan(-1);
  const bodyStart = css.indexOf("{", start) + 1;
  let depth = 1;
  let cursor = bodyStart;
  while (cursor < css.length && depth > 0) {
    if (css[cursor] === "{") depth += 1;
    if (css[cursor] === "}") depth -= 1;
    cursor += 1;
  }
  expect(depth, "tablet tier must close").toBe(0);
  return css.slice(bodyStart, cursor - 1);
}

describe("QuickEntryBox action-row centering", () => {
  it("centers the desktop cluster without restoring its pre-fix split sizing", () => {
    const actions = ruleBody(".quick-entry-actions");
    expect(actions.body).toMatch(/justify-content:\s*center/);
    expect(isInsideMediaQuery(actions.index)).toBe(false);

    const primary = ruleBody(".quick-entry-primary-group");
    expect(primary.body).not.toMatch(/margin-left:\s*auto/);
    expect(primary.body).toMatch(/flex-wrap:\s*wrap/);
    expect(primary.body).toMatch(/justify-content:\s*flex-end/);

    const options = ruleBody(".quick-entry-options-group");
    expect(options.body).not.toMatch(/flex:\s*1\s+1\s+auto/);
    expect(options.body).not.toMatch(/(?:#[0-9a-f]{3,8}|rgba?\(|\d+(?:\.\d+)?px)/i);
    expect(primary.body).not.toMatch(/(?:#[0-9a-f]{3,8}|rgba?\(|\d+(?:\.\d+)?px)/i);
    expect(actions.body).not.toMatch(/(?:#[0-9a-f]{3,8}|rgba?\(|\d+(?:\.\d+)?px)/i);
  });

  it("uses the edge-to-edge mobile positioning contract at tablet widths", () => {
    const tablet = tabletSection();
    const forbiddenRawValues = /(?:#[0-9a-f]{3,8}|rgba?\(|\d+(?:\.\d+)?px)/i;
    expect(tablet).toMatch(/\.quick-entry-actions\s*\{[^}]*justify-content:\s*space-between[^}]*column-gap:\s*var\(--space-xs\)/);
    expect(tablet).toMatch(/\.quick-entry-options-group\s*\{[^}]*justify-content:\s*space-between[^}]*column-gap:\s*var\(--space-xs\)/);
    expect(tablet).toMatch(/\.quick-entry-primary-group\s*\{[^}]*gap:\s*var\(--space-xs\)[^}]*justify-content:\s*space-between[^}]*width:\s*100%[^}]*margin-left:\s*0/);
    expect(tablet).toMatch(/\.quick-entry-primary-group \.btn-icon\s*\{[^}]*min-width:\s*var\(--space-2xl\)/);
    expect(tablet).not.toMatch(/--quick-entry-action-row-height-mobile|touch-action|--space-lg/);
    expect(tablet).not.toMatch(forbiddenRawValues);
  });

  it("preserves the intentional <=768px edge-to-edge mobile layout", () => {
    const mobile = mobileSection();
    expect(mobile).toMatch(/\.quick-entry-actions\s*\{[^}]*justify-content:\s*space-between/);
    expect(mobile).toMatch(/\.quick-entry-options-group\s*\{[^}]*justify-content:\s*space-between/);
    expect(mobile).toMatch(/\.quick-entry-primary-group\s*\{[^}]*justify-content:\s*space-between[^}]*width:\s*100%[^}]*margin-left:\s*0/);
  });

  it("renders sibling groups with Save last and no empty spacer shell", () => {
    render(createElement(QuickEntryBox, { onCreate: vi.fn(), addToast: vi.fn(), tasks: [], projectId: "test-project" }));
    const toggle = screen.getByTestId("quick-entry-toggle");
    if (toggle.getAttribute("aria-expanded") !== "true") fireEvent.click(toggle);

    const actions = screen.getByTestId("quick-entry-actions");
    expect([...actions.children].map((child) => child.getAttribute("data-testid"))).toEqual([
      "quick-entry-options-group",
      "quick-entry-primary-group",
    ]);
    const actionButtons = [...actions.querySelectorAll("button[data-testid]")];
    expect(actionButtons.at(-1)?.getAttribute("data-testid")).toBe("quick-entry-save");
    expect([...actions.children].every((child) => child.textContent?.trim() || child.getAttribute("aria-label"))).toBe(true);
  });
});
