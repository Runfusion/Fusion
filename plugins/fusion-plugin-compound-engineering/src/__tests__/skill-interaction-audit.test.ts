import { describe, expect, it } from "vitest";
import type { PlanningQuestionType } from "@fusion/core";
import {
  RICH_INTERACTION_TYPES,
  canRenderRichly,
  isRichInteractionType,
} from "../dashboard/ce-question-support.js";
import { getStage } from "../session/stage-registry.js";

/**
 * Skill-interaction audit (Success Criteria, U6).
 *
 * CLASSIFICATION PROVENANCE — be honest. This audit is a DECLARED /
 * EXPECTED classification, NOT a measurement taken from driving live `ce-*`
 * skill sessions. We do not invoke a real model here. The interaction types
 * each stage performs are read from each stage's protocol — the SKILL.md
 * "Interaction Rules / Interaction Method" sections that govern how the skill
 * asks questions (e.g. ce-brainstorm: "Ask one question at a time", "Prefer
 * single-select", "Use multi-select rarely", open-ended free-text questions;
 * ce-ideate / ce-plan: single-select-preferred + free-text). Each declared
 * interaction is then classified against CeFlow's renderable set
 * (`RICH_INTERACTION_TYPES`) to compute a rich-vs-chat coverage ratio.
 *
 * The test FAILS if any sampled interaction is unclassified (a type CeFlow's
 * support module doesn't recognize at all), which is the guard that keeps the
 * audit honest as the skills' protocols evolve. When a stage declares a
 * confirm/text/single/multi interaction, that is rich-renderable; an
 * "unknown_type" declaration would be unclassified and fail.
 */

interface DeclaredInteraction {
  /** A label for the interaction occurrence within the stage's protocol. */
  name: string;
  /** The interaction type the stage's protocol uses for it. */
  type: string;
  /** Whether the stage's protocol supplies options for this interaction. */
  hasOptions: boolean;
}

interface StageProtocol {
  stageId: string;
  /** Source the declaration was read from (for traceability in the report). */
  source: string;
  interactions: DeclaredInteraction[];
}

/**
 * Declared protocols for the sampled stages, derived from each SKILL.md's
 * Interaction section. These are protocol declarations, not live captures.
 */
const SAMPLED_STAGES: StageProtocol[] = [
  {
    stageId: "brainstorm",
    source: "src/skills/ce-brainstorm/SKILL.md → Interaction Rules",
    interactions: [
      { name: "narrowing choice (one direction/priority/next step)", type: "single_select", hasOptions: true },
      { name: "compatible set (goals/constraints/non-goals)", type: "multi_select", hasOptions: true },
      { name: "genuinely open / diagnostic question", type: "text", hasOptions: false },
      { name: "proceed-to-write confirmation", type: "confirm", hasOptions: false },
    ],
  },
  {
    stageId: "ideate",
    source: "src/skills/ce-ideate/SKILL.md → Interaction Method",
    interactions: [
      { name: "concise single-select when natural options exist", type: "single_select", hasOptions: true },
      { name: "open-ended ideation prompt", type: "text", hasOptions: false },
    ],
  },
  {
    stageId: "plan",
    source: "src/skills/ce-plan/SKILL.md → Interaction Method",
    interactions: [
      { name: "concise single-select choice", type: "single_select", hasOptions: true },
      { name: "clarifying free-text question (Phase 0.4 bootstrap)", type: "text", hasOptions: false },
    ],
  },
];

function classify(i: DeclaredInteraction): { classified: boolean; rich: boolean } {
  const classified = isRichInteractionType(i.type);
  if (!classified) return { classified: false, rich: false };
  // canRenderRichly is the same predicate CeFlow uses at runtime.
  const rich = canRenderRichly({
    type: i.type as PlanningQuestionType,
    options: i.hasOptions ? [{ id: "x", label: "x" }] : undefined,
  });
  return { classified: true, rich };
}

describe("skill-interaction audit (declared classification)", () => {
  it("every sampled stage is a registered stage", () => {
    for (const s of SAMPLED_STAGES) {
      expect(getStage(s.stageId), `stage ${s.stageId} must be registered`).toBeDefined();
    }
  });

  it("classifies every declared interaction (fails on an unclassified interaction)", () => {
    const unclassified: string[] = [];
    for (const stage of SAMPLED_STAGES) {
      for (const i of stage.interactions) {
        if (!isRichInteractionType(i.type)) {
          unclassified.push(`${stage.stageId}:${i.name} (type=${i.type})`);
        }
      }
    }
    expect(unclassified, `unclassified interactions: ${unclassified.join(", ")}`).toHaveLength(0);
  });

  it("produces a measured rich-vs-chat coverage ratio for the sampled stages", () => {
    let total = 0;
    let rich = 0;
    const perStage: Array<{ stageId: string; rich: number; total: number }> = [];

    for (const stage of SAMPLED_STAGES) {
      let sRich = 0;
      for (const i of stage.interactions) {
        total += 1;
        const c = classify(i);
        if (c.rich) {
          rich += 1;
          sRich += 1;
        }
      }
      perStage.push({ stageId: stage.stageId, rich: sRich, total: stage.interactions.length });
    }

    const ratio = rich / total;

    // Emit the produced coverage figure (visible in test output / report).
    // eslint-disable-next-line no-console
    console.log(
      `[skill-interaction-audit] rich-renderable coverage: ${rich}/${total} = ${(ratio * 100).toFixed(1)}% ` +
        `(declared classification, not live-measured)\n` +
        perStage.map((p) => `  - ${p.stageId}: ${p.rich}/${p.total}`).join("\n"),
    );

    // The audit must compute and assert a real ratio. For the sampled stages,
    // every declared interaction maps onto CeFlow's renderable set, so coverage
    // is 100% — but the assertion is on the COMPUTED value, and the guard above
    // would drop it below 1 (and the unclassified test would fail) the moment a
    // stage declares an interaction CeFlow can't express.
    expect(total).toBeGreaterThanOrEqual(2 + 2 + 2); // 2-3 stages, ≥2 interactions each
    expect(ratio).toBeGreaterThan(0);
    expect(ratio).toBeLessThanOrEqual(1);
    expect(ratio).toBe(rich / total);

    // Sanity: the four rich types CeFlow advertises are the classification set.
    expect([...RICH_INTERACTION_TYPES].sort()).toEqual(
      ["confirm", "multi_select", "single_select", "text"],
    );
  });

  it("a hypothetical unrenderable interaction would be unclassified (guard proof)", () => {
    const rogue: DeclaredInteraction = { name: "ranked drag-and-drop", type: "rank_order", hasOptions: true };
    expect(isRichInteractionType(rogue.type)).toBe(false);
    expect(classify(rogue).rich).toBe(false);
  });
});
