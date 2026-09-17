/*
FNXC:TaskCardAgentHalo 2026-09-16-22:50:
FN-490 — l'indicateur « agent au travail » ne doit plus animer `box-shadow` (propriété non composable :
un repaint de la carte et de sa zone d'ombre à chaque frame, pour chaque carte active). Le halo est porté
par `.card.agent-active::before` avec une ombre STATIQUE et n'anime que `opacity`.
Ces cas couvrent une par une les lignes de la Surface Enumeration du spec : hôte de la classe, thème par
défaut, thèmes lumineux (factory, neon-city), thèmes volontairement plats, reduced-motion, breakpoints,
et le contrôle négatif des surfaces Liste restées statiques (FN-6529).
*/
import { render } from "@testing-library/react";
import type { Task } from "@fusion/core";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../api", () => ({
  fetchWorkflowSettingValues: vi.fn().mockResolvedValue({ stored: {}, effective: {}, orphaned: [] }),
}));
vi.mock("../ProviderIcon", () => ({ ProviderIcon: () => null }));
vi.mock("../PrCreateModal", () => ({ PrCreateModal: () => null }));
vi.mock("../../hooks/useTaskDiffStats", () => ({ useTaskDiffStats: () => ({ stats: null, loading: false }) }));
vi.mock("../../hooks/useBadgeWebSocket", () => ({ useBadgeWebSocket: () => ({ badgeUpdates: new Map(), isConnected: true, subscribeToBadge: vi.fn(), unsubscribeFromBadge: vi.fn() }) }));
vi.mock("../../hooks/useBatchBadgeFetch", () => ({ getFreshBatchData: vi.fn(() => null) }));
vi.mock("../../hooks/useConfirm", () => ({ useConfirm: () => ({ confirmWithCheckbox: async (options?: { checkbox?: { defaultChecked?: boolean } }) => ({ choice: "cancel" as const, checkboxValue: options?.checkbox?.defaultChecked ?? false }), confirm: vi.fn(), confirmWithChoice: vi.fn() }) }));

import { TaskCard } from "../TaskCard";
import { listComponentFiles, loadAllAppCss, loadComponentCss, loadThemeDataCss, readAppFile } from "../../test/cssFixture";

// ---------------------------------------------------------------------------
// Minimal CSS reader: rules with their enclosing at-rule prelude, plus keyframes.
// ---------------------------------------------------------------------------

interface CssRule {
  /** Full selector list, comments stripped and whitespace collapsed. */
  selector: string;
  /** Declaration block body. */
  body: string;
  /** Enclosing at-rule prelude (e.g. `@media (prefers-reduced-motion: reduce)`), or null at top level. */
  atRule: string | null;
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function splitBlocks(source: string): { prelude: string; body: string }[] {
  const blocks: { prelude: string; body: string }[] = [];
  let preludeStart = 0;
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    if (char === "{") {
      const prelude = source.slice(preludeStart, i).trim();
      let depth = 1;
      let j = i + 1;
      while (j < source.length && depth > 0) {
        if (source[j] === "{") depth++;
        else if (source[j] === "}") depth--;
        j++;
      }
      blocks.push({ prelude, body: source.slice(i + 1, j - 1) });
      i = j;
      preludeStart = i;
      continue;
    }
    if (char === "}") {
      i++;
      preludeStart = i;
      continue;
    }
    i++;
  }
  return blocks;
}

function collectRules(css: string): { rules: CssRule[]; keyframes: Map<string, string> } {
  const rules: CssRule[] = [];
  const keyframes = new Map<string, string>();

  const walk = (source: string, atRule: string | null) => {
    for (const { prelude, body } of splitBlocks(source)) {
      const normalized = prelude.replace(/\s+/g, " ").trim();
      if (normalized.startsWith("@keyframes")) {
        keyframes.set(normalized.replace(/^@keyframes\s+/, "").trim(), body);
        continue;
      }
      if (normalized.startsWith("@")) {
        walk(body, normalized);
        continue;
      }
      rules.push({ selector: prelude.replace(/\s+/g, " ").trim(), body, atRule });
    }
  };

  walk(stripComments(css), null);
  return { rules, keyframes };
}

/** All `property: value` declarations of a block, ignoring nested keyframe steps. */
function declarations(body: string): { property: string; value: string }[] {
  const flat = body.replace(/\{[^{}]*\}/g, "");
  return flat
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const colon = entry.indexOf(":");
      return { property: entry.slice(0, colon).trim(), value: entry.slice(colon + 1).trim() };
    })
    .filter((decl) => decl.property.length > 0);
}

/** All properties declared anywhere inside a @keyframes block (across every step). */
function keyframeProperties(body: string): string[] {
  const properties: string[] = [];
  for (const step of body.match(/\{[^{}]*\}/g) ?? []) {
    for (const decl of declarations(step.slice(1, -1))) properties.push(decl.property);
  }
  return properties;
}

function selectorEntries(selector: string): string[] {
  return selector.split(",").map((entry) => entry.trim());
}

const taskCardCss = loadComponentCss("TaskCard.css");
const listViewCss = loadComponentCss("ListView.css");
const themeDataCss = loadThemeDataCss();
const allAppCss = loadAllAppCss();

const taskCard = collectRules(taskCardCss);
const listView = collectRules(listViewCss);
const themeData = collectRules(themeDataCss);

const RETIRED_KEYFRAMES = [
  "agent-glow",
  "agent-glow-factory",
  "agent-glow-factory-light",
  "neon-agent-pulse",
  "neon-agent-pulse-light",
];

/** Flat themes relevés à l'étape 0 : ils neutralisent explicitement le pseudo-élément. */
const FLAT_THEMES = [
  "factory-mono",
  "shadcn",
  "shadcn-ember",
  "shadcn-custom",
  "shadcn-blue",
  "shadcn-green",
  "shadcn-red",
  "shadcn-purple",
  "shadcn-pink",
  "shadcn-orange",
  "shadcn-yellow",
  "shadcn-mono",
  "shadcn-mono-red",
  "shadcn-mono-blue",
  "shadcn-mono-green",
  "shadcn-mono-purple",
  "shadcn-mono-pink",
  "shadcn-mono-orange",
  "shadcn-mono-yellow",
  "shadcn-black",
  "shadcn-gray",
  "shadcn-gray-blue",
];

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-490",
    title: "Halo",
    description: "Agent halo",
    prompt: "# Plan\n",
    column: "in-progress",
    status: "executing",
    dependencies: [],
    steps: [],
    currentStep: 0,
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
    ...overrides,
  } as Task;
}

describe("FN-490 agent halo", () => {
  // (a) Hôte unique de `.card.agent-active`
  it("renders agent-active on a live card and never on an idle one", () => {
    const active = render(<TaskCard task={task()} projectId="p1" onOpenDetail={vi.fn()} addToast={vi.fn()} />);
    expect(active.container.querySelector(".card")?.className).toContain("agent-active");
    active.unmount();

    const idle = render(
      <TaskCard task={task({ id: "FN-491", column: "todo", status: null } as Partial<Task>)} projectId="p1" onOpenDetail={vi.fn()} addToast={vi.fn()} />,
    );
    expect(idle.container.querySelector(".card")?.className).not.toContain("agent-active");
  });

  // (b) Thème par défaut : la carte ne porte plus ni animation ni ombre propre.
  it("keeps the card itself animation-free and shadow-free while declaring the halo variables", () => {
    const base = taskCard.rules.filter((rule) => rule.atRule === null && selectorEntries(rule.selector).includes(".card.agent-active"));
    expect(base).toHaveLength(1);

    const decls = declarations(base[0].body);
    expect(decls.find((decl) => decl.property === "animation")?.value).toBe("none");
    expect(decls.some((decl) => decl.property === "box-shadow")).toBe(false);
    for (const variable of ["--agent-halo-color", "--agent-halo-blur", "--agent-halo-strength", "--agent-halo-duration"]) {
      expect(decls.some((decl) => decl.property === variable)).toBe(true);
    }
  });

  // (c) Les keyframes partagés n'interpolent que l'opacité.
  it("defines agent-halo keyframes that only interpolate opacity", () => {
    const body = taskCard.keyframes.get("agent-halo");
    expect(body).toBeDefined();
    const properties = keyframeProperties(body as string);
    expect(properties.length).toBeGreaterThan(0);
    expect(new Set(properties)).toEqual(new Set(["opacity"]));
  });

  /*
  (d) Assertion symptôme : reproduit la condition d'origine. Sur `main`, cinq @keyframes
  référencés par des sélecteurs `agent-active` interpolaient `box-shadow`.
  */
  it("never animates a non-composited property from any agent-active surface", () => {
    const sources = [taskCard, themeData, collectRules(allAppCss)];
    let checked = 0;

    for (const source of sources) {
      for (const rule of source.rules) {
        if (!rule.selector.includes("agent-active")) continue;
        for (const decl of declarations(rule.body)) {
          if (decl.property !== "animation" && decl.property !== "animation-name") continue;
          const names = decl.value.split(/\s+/).filter((token) => source.keyframes.has(token));
          for (const name of names) {
            checked++;
            const properties = new Set(keyframeProperties(source.keyframes.get(name) as string));
            expect({ name, properties: [...properties] }).toEqual({ name, properties: ["opacity"] });
          }
        }
      }
    }

    expect(checked).toBeGreaterThan(0);
    const combined = `${taskCardCss}\n${themeDataCss}\n${allAppCss}`;
    for (const retired of RETIRED_KEYFRAMES) {
      expect(combined).not.toContain(`@keyframes ${retired}`);
      expect(combined).not.toContain(`animation: ${retired}`);
    }
  });

  // (e) Aucun thème ne réintroduit une animation sur la carte.
  it("declares no theme-level animation other than none on agent-active cards", () => {
    const offenders = themeData.rules
      .filter((rule) => rule.selector.includes(".card.agent-active"))
      .flatMap((rule) =>
        declarations(rule.body)
          .filter((decl) => decl.property.startsWith("animation") && decl.value !== "none")
          .map((decl) => `${rule.selector} { ${decl.property}: ${decl.value} }`),
      );
    expect(offenders).toEqual([]);
  });

  // (f) neon-city garde son identité bi-colore par une ombre statique.
  it("keeps neon-city bi-color identity as a static pseudo-element shadow", () => {
    for (const prefix of ['[data-color-theme="neon-city"]', '[data-color-theme="neon-city"][data-theme="light"]']) {
      const selector = `${prefix} .card.agent-active::before`;
      const rules = themeData.rules.filter((rule) => selectorEntries(rule.selector).includes(selector));
      expect(rules.length, selector).toBe(1);
      const decls = declarations(rules[0].body);
      expect(decls.some((decl) => decl.property === "box-shadow")).toBe(true);
      expect(decls.some((decl) => decl.property.startsWith("animation"))).toBe(false);
    }
  });

  // (g) Recensement source : seuls deux composants émettent la classe.
  it("keeps agent-active confined to the two known component hosts", () => {
    const hosts = listComponentFiles()
      .filter((file) => !file.includes("__tests__"))
      .filter((file) => readAppFile(`components/${file}`).includes("agent-active"));
    expect(hosts).toEqual(["ListView.tsx", "TaskCard.tsx"]);
  });

  // (h) Thèmes volontairement plats : le pseudo-élément est neutralisé en dark ET en light.
  it.each(FLAT_THEMES)("neutralizes the halo pseudo-element for the flat theme %s", (theme) => {
    for (const mid of ["", '[data-theme="light"]']) {
      const selector = `[data-color-theme="${theme}"]${mid} .card.agent-active::before`;
      const rule = themeData.rules.find((entry) => selectorEntries(entry.selector).includes(selector));
      expect(rule, selector).toBeDefined();
      expect(declarations((rule as CssRule).body).find((decl) => decl.property === "content")?.value).toBe("none");
    }
  });

  // (i) prefers-reduced-motion fige le halo.
  it("freezes the halo at a fixed opacity under prefers-reduced-motion", () => {
    const rule = taskCard.rules.find(
      (entry) =>
        entry.atRule !== null &&
        entry.atRule.includes("prefers-reduced-motion") &&
        selectorEntries(entry.selector).includes(".card.agent-active::before"),
    );
    expect(rule).toBeDefined();
    const decls = declarations((rule as CssRule).body);
    expect(decls.find((decl) => decl.property === "animation")?.value).toBe("none");
    expect(decls.find((decl) => decl.property === "opacity")?.value).toBeDefined();
  });

  // (j) Aucun fork par breakpoint : desktop, mobile et docks partagent la même racine.
  it("forks no agent-active rule on a breakpoint media query", () => {
    const forked = taskCard.rules
      .filter((rule) => rule.selector.includes("agent-active") && rule.atRule !== null && !rule.atRule.includes("prefers-reduced-motion"))
      .map((rule) => `${rule.atRule} ${rule.selector}`);
    expect(forked).toEqual([]);
  });

  // (k) Contrôle négatif : les surfaces Liste restent statiques (FN-6529).
  it("leaves the list surfaces static and halo-free", () => {
    const listSelectors = [".list-row.agent-active", ".list-view--cards .list-card.agent-active"];
    for (const selector of listSelectors) {
      const rules = listView.rules.filter((rule) => selectorEntries(rule.selector).includes(selector));
      expect(rules.length, selector).toBeGreaterThan(0);
      for (const rule of rules) {
        expect(declarations(rule.body).some((decl) => decl.property.startsWith("animation"))).toBe(false);
      }
    }
    const pseudo = listView.rules.filter((rule) => rule.selector.includes("agent-active::before"));
    expect(pseudo).toEqual([]);
  });
});
