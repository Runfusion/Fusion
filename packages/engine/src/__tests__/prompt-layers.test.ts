import { describe, it, expect } from "vitest";
import {
  buildPromptLayers,
  collapsePromptLayers,
  buildRequestVolatileContext,
  appendRequestVolatileContext,
  withRequestVolatileContext,
  SESSION_CONTEXT_HEADING,
  SYSTEM_PROMPT_VOLATILE_FIELD_NAMES,
} from "../execution/prompt-layers.js";

/*
FNXC:PromptByteStability 2026-09-24-02:10 (RUFU-267):
RUFU-267 removed `memorySection`, `goalContext` and `performanceFeedback` from `PromptLayerInput` — the
serialized system prompt may now carry only config-time content, and those three inputs are
runtime-mutable. They compose through `buildRequestVolatileContext` and travel at the end of the lane's
request instead. The tests below cover both halves of that seam.
*/

describe("buildPromptLayers", () => {
  it("separates base prompt into stable layer", () => {
    const layers = buildPromptLayers({
      basePrompt: "You are a reviewer.",
    });

    expect(layers.stable).toBe("You are a reviewer.");
    expect(layers.dynamic).toBe("");
  });

  it("puts agent instructions into dynamic layer", () => {
    const layers = buildPromptLayers({
      basePrompt: "You are a reviewer.",
      agentInstructions: "Always check for SQL injection.",
    });

    expect(layers.stable).toBe("You are a reviewer.");
    expect(layers.dynamic).toContain("Always check for SQL injection.");
  });

  it("puts static memory instructions into dynamic layer", () => {
    const layers = buildPromptLayers({
      basePrompt: "You are a reviewer.",
      memoryInstructions: "## Agent Memory\n\nSearch memory before asking.",
    });

    expect(layers.stable).toBe("You are a reviewer.");
    expect(layers.dynamic).toContain("Agent Memory");
  });

  it("puts plugin contributions into dynamic layer", () => {
    const layers = buildPromptLayers({
      basePrompt: "You are a reviewer.",
      pluginContributions: "## Plugin: security\n\nScan for CVEs.",
    });

    expect(layers.stable).toBe("You are a reviewer.");
    expect(layers.dynamic).toContain("security");
  });

  it("combines multiple dynamic sections with double newlines", () => {
    const layers = buildPromptLayers({
      basePrompt: "Base.",
      agentInstructions: "Instructions.",
      memoryInstructions: "Memory.",
      pluginContributions: "Plugins.",
    });

    expect(layers.dynamic).toBe(
      "Memory.\n\n## Custom Instructions\n\nInstructions.\n\nPlugins."
    );
  });

  it("omits empty dynamic sections", () => {
    const layers = buildPromptLayers({
      basePrompt: "Base.",
      agentInstructions: "",
      memoryInstructions: "",
      pluginContributions: "Plugins.",
    });

    expect(layers.dynamic).toBe("Plugins.");
    expect(layers.dynamic).not.toContain("Custom Instructions");
  });

  it("produces deterministic output for identical inputs", () => {
    const input = {
      basePrompt: "Base.",
      agentInstructions: "Inst.",
      memoryInstructions: "Mem.",
      pluginContributions: "Plug.",
    };

    const layers1 = buildPromptLayers(input);
    const layers2 = buildPromptLayers(input);

    expect(layers1.stable).toBe(layers2.stable);
    expect(layers1.dynamic).toBe(layers2.dynamic);
  });

  it("accepts no volatile input names at all", () => {
    const input: Record<string, unknown> = { basePrompt: "Base." };
    for (const field of SYSTEM_PROMPT_VOLATILE_FIELD_NAMES) {
      input[field] = `## ${field}\n\nmutating`;
    }

    const layers = buildPromptLayers(input as never);
    const collapsed = collapsePromptLayers(layers);

    // Unknown keys are ignored by construction, so no volatile payload can reach the serialized prompt.
    expect(collapsed).toBe("Base.");
    expect(collapsed).not.toContain("mutating");
  });
});

describe("collapsePromptLayers", () => {
  it("returns stable when dynamic is empty", () => {
    const result = collapsePromptLayers({ stable: "Base.", dynamic: "" });
    expect(result).toBe("Base.");
  });

  it("joins stable and dynamic with double newline", () => {
    const result = collapsePromptLayers({
      stable: "Base.",
      dynamic: "Dynamic.",
    });
    expect(result).toBe("Base.\n\nDynamic.");
  });

  it("matches legacy buildSystemPromptWithInstructions output", () => {
    const layers = buildPromptLayers({
      basePrompt: "You are a reviewer.",
      agentInstructions: "Check for bugs.",
    });
    const collapsed = collapsePromptLayers(layers);

    expect(collapsed).toBe(
      "You are a reviewer.\n\n## Custom Instructions\n\nCheck for bugs."
    );
  });
});

describe("buildRequestVolatileContext", () => {
  it("returns an empty string when nothing is volatile", () => {
    expect(buildRequestVolatileContext({})).toBe("");
    expect(buildRequestVolatileContext({ goalContext: "  ", memorySection: "" })).toBe("");
  });

  it("labels the block as refreshed per-request runtime state", () => {
    const ctx = buildRequestVolatileContext({ goalContext: "## Active Goals\n\n- Ship RUFU-267" });

    expect(ctx.startsWith(SESSION_CONTEXT_HEADING)).toBe(true);
    expect(ctx).toContain("- Ship RUFU-267");
  });

  it("renders every volatile section in a fixed order", () => {
    const ctx = buildRequestVolatileContext({
      memorySection: "MEMORY",
      goalContext: "GOALS",
      identitySection: "IDENTITY",
      performanceFeedback: "RATINGS",
      selfImprovePrompt: "SELF-IMPROVE",
      policySections: ["POLICY-A", "POLICY-B"],
      taskReviewPolicy: "REVIEW-POLICY",
      requestBoardContext: "BOARD",
      memoryRecall: "RECALL",
    });

    const positions = ["MEMORY", "GOALS", "IDENTITY", "RATINGS", "REVIEW-POLICY", "BOARD", "RECALL", "SELF-IMPROVE"].map(
      (marker) => ctx.indexOf(marker),
    );
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(ctx.indexOf("POLICY-A")).toBeLessThan(ctx.indexOf("POLICY-B"));
  });

  it("changes byte-for-byte when runtime state changes and renders identically when it does not", () => {
    const stableInput = { memorySection: "## Agent Memory\n\n- keep tests green" };
    expect(buildRequestVolatileContext(stableInput)).toBe(buildRequestVolatileContext(stableInput));
    expect(buildRequestVolatileContext(stableInput)).not.toBe(
      buildRequestVolatileContext({ memorySection: "## Agent Memory\n\n- new note" }),
    );
  });
});

describe("appendRequestVolatileContext", () => {
  it("leaves the request untouched when there is no volatile context", () => {
    expect(appendRequestVolatileContext("Do the work.", "")).toBe("Do the work.");
  });

  it("appends after the request's own text", () => {
    const out = appendRequestVolatileContext("Do the work.", "## Session Context\n\n- goals");
    expect(out.startsWith("Do the work.\n\n")).toBe(true);
    expect(out).toContain("goals");
  });

  it("withRequestVolatileContext renders and appends in one step", () => {
    const out = withRequestVolatileContext("Do the work.", { goalContext: "## Active Goals\n\n- ship" });
    expect(out).toBe(appendRequestVolatileContext("Do the work.", buildRequestVolatileContext({ goalContext: "## Active Goals\n\n- ship" })));
  });

  it("keeps the serialized system prompt prefix intact while the tail changes", () => {
    const layers = buildPromptLayers({ basePrompt: "ROLE PROMPT.", agentInstructions: "CONFIG." });
    const head = collapsePromptLayers(layers);

    const turnOne = withRequestVolatileContext("user message one", { goalContext: "## Active Goals\n\n- A" });
    const turnTwo = withRequestVolatileContext("user message one", { goalContext: "## Active Goals\n\n- B" });

    expect(turnOne).not.toBe(turnTwo);
    expect(turnOne).not.toContain(head);
    expect(head).toBe(collapsePromptLayers(buildPromptLayers({ basePrompt: "ROLE PROMPT.", agentInstructions: "CONFIG." })));
  });
});

/*
FNXC:OperatorLanguage 2026-09-16-13:05:
RUFU PR review: the lane prompt seam must carry the operator-language directive for every lane
(executor task logs, reviewer verdicts, triage planning) while unset/"auto" stays byte-identical.
The directive is settings-derived (config-time), so it stays in the serialized system prompt.
*/
describe("operator language directive in prompt layers", () => {
  it("appends the directive to the dynamic layer when provided", () => {
    const layers = buildPromptLayers({
      basePrompt: "You are an executor.",
      agentInstructions: "Ship the change.",
      operatorLanguageDirective: "## Operator Language\n\nWrite operator-facing prose in Slovak.",
    });
    expect(layers.stable).toBe("You are an executor.");
    expect(layers.dynamic).toContain("## Operator Language");
    expect(collapsePromptLayers(layers)).toContain("Write operator-facing prose in Slovak.");
  });

  it("keeps the prompt byte-identical when the directive is absent or blank (auto/unset)", () => {
    const base = { basePrompt: "You are an executor.", agentInstructions: "Ship the change." };
    const without = collapsePromptLayers(buildPromptLayers(base));
    const blank = collapsePromptLayers(buildPromptLayers({ ...base, operatorLanguageDirective: "  " }));
    expect(blank).toBe(without);
  });
});
