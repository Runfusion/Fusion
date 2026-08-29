/**
 * FNXC:WorkflowOptionalSteps 2026-06-21-00:00:
 * One phase chip (pre-merge / post-merge) shared by every workflow-step surface so
 * the badge looks identical across the results tab, authoring panel, and dropdown.
 *
 * Shared phase chip for workflow steps (pre-merge / post-merge). Extracted from
 * WorkflowResultsTab so the node-editor optional-steps panel and the optional-step
 * dropdown render an identical badge without duplicating markup.
 */
import type { ReactNode } from "react";
import type { useTranslation } from "react-i18next";

import "./workflow-phase-badge.css";

export function phaseBadge(
  phase: "pre-merge" | "post-merge",
  id: string,
  prefix: string,
  t: ReturnType<typeof useTranslation>["t"],
): ReactNode {
  const phaseClass = phase === "post-merge" ? "phase-badge--post-merge" : "phase-badge--pre-merge";
  return (
    <span className={`phase-badge ${phaseClass}`} data-testid={`${prefix}-${id}`}>
      {phase === "post-merge"
        ? t("app:workflow.postMerge", "Post-merge")
        : t("app:workflow.preMerge", "Pre-merge")}
    </span>
  );
}
