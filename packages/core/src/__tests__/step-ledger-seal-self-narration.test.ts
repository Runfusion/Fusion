import { describe, expect, it } from "vitest";
import {
  evaluateStepLedgerSeal,
  STEP_LEDGER_REFUSAL_MARKER_PREFIX,
  STEP_LEDGER_REOPEN_MARKER_PREFIX,
} from "../task-store/step-ledger-seal.js";

/*
FNXC:StepLedgerIntegrity 2026-09-01-00:35:
Two defects, one seam, both observed on live cards.

1. SELF-SEALING. The refusal narration quotes the marker it acted on, and the scan matches by
   substring, so the refusal line itself contains "Task marked done by agent". The next backward scan
   hit that newer line first and re-sealed on the seam's own output -- forever, because every further
   attempt appended another refusal that quoted the last one. Measured on FN-270 as a message nested
   inside itself, on a card that was resuming and reporting progress and still could not start a step.

2. HALF-WIRED RE-ENTRY. The seal documents a resume-after-unpause as re-entry, but only
   `run-implementation.ts` writes "Resumed agent session after unpause". The graph resume in
   `unpause-resume.ts` writes "Resuming execution after unpause", which matched nothing, so one of
   the two declared re-entry paths never worked.

Asserted through the evaluator because it is what every step transition consults; a card that cannot
lift its seal cannot run the work it was just handed.
*/

const DONE = "Task marked done by agent";
const entry = (action: string) => ({ action });

describe("the step ledger seal never reads its own narration as evidence", () => {
  it("stays sealed after a genuine completion", () => {
    expect(evaluateStepLedgerSeal([entry("Step 2 → done"), entry(DONE)]).sealed).toBe(true);
  });

  /*
  The exact production shape: a refusal quoting the completion marker, which a substring scan would
  match as a completion in its own right.
  */
  it("does not re-seal on the refusal it just wrote", () => {
    const refusal = `${STEP_LEDGER_REFUSAL_MARKER_PREFIX} in-progress for step 12 (Fix: x) — implementation ended at "${DONE}" and no new implementation session has started`;

    const log = [entry(DONE), entry(`${STEP_LEDGER_REOPEN_MARKER_PREFIX} — 2 remediation step(s) appended`), entry(refusal)];

    expect(evaluateStepLedgerSeal(log).sealed).toBe(false);
  });

  /* FN-270's nested shape: a refusal quoting a refusal quoting the marker. */
  it("does not re-seal on a refusal nested inside itself", () => {
    const inner = `${STEP_LEDGER_REFUSAL_MARKER_PREFIX} in-progress for step 12 (Fix: x) — implementation ended at "${DONE}" and no new implementation session has started`;
    const outer = `${STEP_LEDGER_REFUSAL_MARKER_PREFIX} in-progress for step 12 (Fix: x) — implementation ended at "${inner}" and no new implementation session has started`;

    const log = [entry(DONE), entry("Executor using model: test/model"), entry(inner), entry(outer)];

    expect(evaluateStepLedgerSeal(log).sealed).toBe(false);
  });

  /*
  Non-vacuous: skipping the refusal must not also skip the completion BEHIND it. A card that really
  completed and was never reopened has to stay sealed even once a refusal sits on top.
  */
  it("still finds a completion that lies behind a refusal", () => {
    const refusal = `${STEP_LEDGER_REFUSAL_MARKER_PREFIX} done for step 3 (Implement) — implementation ended at "${DONE}" and no new implementation session has started`;

    expect(evaluateStepLedgerSeal([entry(DONE), entry(refusal)]).sealed).toBe(true);
  });

  it.each([
    ["executor session", "Executor using model: openai-codex/gpt-5.6-terra (thinking effort: xhigh)"],
    ["implementation resume", "Resumed agent session after unpause (model: test/model)"],
    ["graph resume", "Resuming execution after unpause"],
    ["remediation append", `${STEP_LEDGER_REOPEN_MARKER_PREFIX} — 1 remediation step(s) appended after completion (wave 2)`],
  ])("lifts the seal on a %s", (_case, marker) => {
    expect(evaluateStepLedgerSeal([entry(DONE), entry(marker)]).sealed).toBe(false);
  });

  /* A forward lifecycle move is deliberately NOT re-entry; widening the list must stay a decision. */
  it("is not lifted by an ordinary lifecycle move", () => {
    const log = [entry(DONE), entry("Lifecycle move: in-review → in-progress (backward) — Code Review REVISE requested implementation fixes")];
    expect(evaluateStepLedgerSeal(log).sealed).toBe(true);
  });
});
