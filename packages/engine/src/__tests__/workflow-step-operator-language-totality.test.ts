/*
FNXC:PromptSectionTotality 2026-10-22-15:32 (RUFU-707):
A project that never configured an operator language crashed every prompt-bearing workflow step.
`buildOperatorLanguageDirective` legitimately answers `undefined` for unset / empty / whitespace / `"auto"`,
and `"auto"` IS the shipped default (`DEFAULT_PROJECT_SETTINGS.operatorLanguage`), so the crash value was the
default value: the step's section join read `.trim()` off that `undefined` and threw
`TypeError: Cannot read properties of undefined (reading 'trim')`.

Measured on rtm3 (production, read-only): 28 cards carried
`Plan Review failed before producing a verdict: Cannot read properties of undefined (reading 'trim') | at
Array.filter | at runOnce (bin.js:296812:72) | at async executeWorkflowStep (bin.js:297392:26)`, with fresh
rows after the 14:42Z roll (KUBE-028 completedAt 15:06:05Z, KUBE-052 15:06:22Z, 15 priorAttempts each), and
`operatorLanguage: "auto"` on the kubernetes/aml/mw projects and globally.

This file pins the invariant at the PRODUCTION STEP SEAM — the same `(task, step, worktree, settings, …)`
positional call `executor-browser-verification.test.ts` makes — over every settings shape the seam receives.
Two rules this file exists to enforce:
1. No fixture here names a language to make a case pass. Every nullish case passes because the composition is
   total, and the language-bearing case is what proves the section still lands when configured.
2. Byte identity (RUFU-267): for a configured language the prompt is unchanged, and each nullish-shape prompt
   is a byte-exact prefix of the configured one — the only added tail is the instruction wrapper and the
   language section. The predicate drops a section; it never reorders or rewords one.
*/
import { beforeEach, describe, expect, it } from "vitest";
import "./executor-test-helpers.js";
import { buildOperatorLanguageDirective } from "@fusion/core";
import { TaskExecutor } from "../executor.js";
import {
  createMockStore,
  mockedCreateFnAgent,
  resetExecutorMocks,
} from "./executor-test-helpers.js";

const LANGUAGE_HEADING = "## Operator Language";
/** A concrete code: the directive body the operator-facing prose is built from. */
const SK_DIRECTIVE = buildOperatorLanguageDirective({ operatorLanguage: "sk" }) ?? "";

function captureSession(output = '{"verdict":"APPROVE","notes":"Reviewed the scoped work and found it correct."}') {
  const holder: { last?: { systemPrompt?: string } } = {};
  mockedCreateFnAgent.mockImplementation(async (opts: any) => {
    holder.last = { systemPrompt: opts.systemPrompt };
    const listeners: Array<(event: any) => void> = [];
    return {
      session: {
        state: {},
        subscribe: (fn: (event: any) => void) => {
          listeners.push(fn);
          return () => {};
        },
        prompt: async () => {
          for (const fn of listeners) {
            fn({
              type: "message_update",
              assistantMessageEvent: { type: "text_delta", partial: output, contentIndex: 0, delta: output },
            });
          }
        },
        dispose: () => {},
      },
    };
  });
  return holder;
}

function baseTask() {
  return {
    id: "RUFU-707",
    title: "Prompt-section totality witness",
    description: "compose a workflow-step prompt for a project that never set an operator language",
    column: "in-progress" as const,
    worktree: "/tmp/wt",
    branch: "fusion/rufu-707",
    baseCommitSha: "abc123",
    dependencies: [],
    steps: [{ name: "s", status: "in-progress" as const }],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/** The canonical Plan Review gate — the node that dies on rtm3. */
function planReviewStep() {
  return {
    id: "graph:plan-review-step",
    name: "Plan Review",
    description: "",
    mode: "prompt",
    phase: "pre-merge",
    gateMode: "gate",
    prompt: "Review the plan.",
    toolMode: "readonly",
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Drives the real seam. The 4th positional argument IS the settings object the composer reads — the composer
 * never re-reads it from the store — so an empty object here yields the `undefined` directive exactly as a
 * default-config project does. Mocking `store.getSettings` would not reproduce the defect.
 */
async function runStep(settings: Record<string, unknown> | undefined) {
  const store = createMockStore();
  store.getTask.mockImplementation(async (id: string) => baseTask({ id }));
  const executor = new TaskExecutor(store as any, "/tmp/test", {
    agentStore: { getAgent: async () => null, createAgent: async () => ({}) },
  } as any);
  const captured = captureSession();
  const result = await (executor as any).executeWorkflowStep(
    baseTask(),
    planReviewStep(),
    "/tmp/wt",
    settings,
    undefined,
    undefined,
  );
  return { result, systemPrompt: captured.last?.systemPrompt ?? "" };
}

/** The nullish shapes: each yields NO directive, so the section must simply be absent. */
const NULLISH_SHAPES: Array<[string, Record<string, unknown> | undefined]> = [
  ["empty settings object", {}],
  ["operatorLanguage empty string", { operatorLanguage: "" }],
  ["operatorLanguage whitespace only", { operatorLanguage: "   " }],
  ["operatorLanguage \"auto\" (the shipped default)", { operatorLanguage: "auto" }],
];

/*
 * An unknown code is NOT a nullish shape: `buildOperatorLanguageDirective` passes it through verbatim
 * (`LANGUAGE_NAMES[raw] ?? raw`), so `{ operatorLanguage: "zz" }` produces a section like any configured
 * language. Asserted next to the configured case rather than among the nullish ones.
 */
const UNKNOWN_CODE_DIRECTIVE = buildOperatorLanguageDirective({ operatorLanguage: "zz" }) ?? "";

describe("workflow-step prompt composition is total over an absent operator-language directive", () => {
  beforeEach(() => {
    resetExecutorMocks();
  });

  it("preflight: the builder really does answer undefined for the shapes the seam receives", () => {
    expect(buildOperatorLanguageDirective(undefined)).toBeUndefined();
    expect(buildOperatorLanguageDirective({})).toBeUndefined();
    expect(buildOperatorLanguageDirective({ operatorLanguage: "" })).toBeUndefined();
    expect(buildOperatorLanguageDirective({ operatorLanguage: "   " })).toBeUndefined();
    expect(buildOperatorLanguageDirective({ operatorLanguage: "auto" })).toBeUndefined();
    expect(SK_DIRECTIVE).toContain(LANGUAGE_HEADING);
  });

  it.each(NULLISH_SHAPES)("completes the step and emits no language section for %s", async (_label, settings) => {
    const { result, systemPrompt } = await runStep(settings);

    expect(result.success).toBe(true);
    expect(result.error ?? "").not.toMatch(/Cannot read properties of undefined/);
    expect(systemPrompt).not.toContain(LANGUAGE_HEADING);
  });

  it("keeps the language section when a language is configured", async () => {
    const { result, systemPrompt } = await runStep({ operatorLanguage: "sk" });

    expect(result.success).toBe(true);
    expect(systemPrompt).toContain(LANGUAGE_HEADING);
    expect(systemPrompt.endsWith(SK_DIRECTIVE)).toBe(true);
  });

  it("treats an unknown code as configured prose, not as an absent directive", async () => {
    expect(UNKNOWN_CODE_DIRECTIVE).toContain(LANGUAGE_HEADING);

    const { result, systemPrompt } = await runStep({ operatorLanguage: "zz" });

    expect(result.success).toBe(true);
    expect(systemPrompt.endsWith(UNKNOWN_CODE_DIRECTIVE)).toBe(true);
  });

  it("equals the configured prompt with exactly the language section removed", async () => {
    const configured = (await runStep({ operatorLanguage: "sk" })).systemPrompt;

    for (const [label, settings] of NULLISH_SHAPES) {
      const nullish = (await runStep(settings)).systemPrompt;
      /*
      The directive is the last section of the step's instruction blob, and this harness lane carries no other
      instruction sections — `buildSystemPromptWithInstructions` returns the base prompt alone when its blob is
      empty, so the nullish shape shows no `## Custom Instructions` wrapper while the configured shape does.
      That wrapper plus the directive is therefore the WHOLE delta: everything before it stays byte-identical,
      nothing reorders, nothing rewords (RUFU-267).
      */
      const addedTail = `\n\n## Custom Instructions\n\n${SK_DIRECTIVE}`;
      expect(configured.startsWith(nullish), `shape: ${label}`).toBe(true);
      expect(configured.endsWith(SK_DIRECTIVE), `shape: ${label}`).toBe(true);
      expect(configured.slice(nullish.length), `shape: ${label}`).toBe(addedTail);
    }
  });

  it("re-enters the same composition on a second dispatch of the same step session", async () => {
    // A step-session resume/retry re-runs this composition; it must be as total as the first entry.
    const first = await runStep({ operatorLanguage: "auto" });
    const second = await runStep({ operatorLanguage: "auto" });

    expect(first.result.success).toBe(true);
    expect(second.result.success).toBe(true);
    expect(second.systemPrompt).toBe(first.systemPrompt);
    expect(second.systemPrompt).not.toContain(LANGUAGE_HEADING);
  });
});
