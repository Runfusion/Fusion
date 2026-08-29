import { useMemo } from "react";
import type { ReportRecord, SectionRef } from "./types.js";

export interface SectionDiff {
  added: SectionRef[];
  removed: SectionRef[];
  changed: SectionRef[];
  unchanged: SectionRef[];
}

const ALL_SECTIONS: Array<{ id: string; label: string }> = [
  { id: "summary", label: "Summary" },
  { id: "system-wins", label: "System wins" },
  { id: "system-highlights", label: "System highlights" },
  { id: "system-lowlights", label: "System lowlights" },
  { id: "system-proposals", label: "System proposals" },
  { id: "system-deep-dives", label: "System deep dives" },
  { id: "agent-card", label: "Per-agent" },
  { id: "data-coverage", label: "Data coverage" },
  { id: "review-panel", label: "Review panel" },
];

function extractValue(report: ReportRecord | undefined, id: string): unknown {
  if (!report) return undefined;
  switch (id) {
    case "summary": return report.metadata?.summary;
    case "system-wins": return report.metadata?.wins;
    case "system-highlights": return report.metadata?.highlights;
    case "system-lowlights": return report.metadata?.lowlights;
    case "system-proposals": return report.metadata?.proposals;
    case "system-deep-dives": return report.metadata?.deepDives;
    case "agent-card": return report.metadata?.perAgent;
    case "data-coverage": return report.metadata?.dataCoverage;
    case "review-panel": return report.combinedReview;
    default: return undefined;
  }
}

export function diffReportSections(a?: ReportRecord, b?: ReportRecord): SectionDiff {
  const added: SectionRef[] = [];
  const removed: SectionRef[] = [];
  const changed: SectionRef[] = [];
  const unchanged: SectionRef[] = [];

  for (const section of ALL_SECTIONS) {
    const left = extractValue(a, section.id);
    const right = extractValue(b, section.id);
    const ref: SectionRef = { id: section.id, label: section.label, hash: section.id };
    if (left == null && right != null) added.push(ref);
    else if (left != null && right == null) removed.push(ref);
    else if (JSON.stringify(left) !== JSON.stringify(right)) changed.push(ref);
    else unchanged.push(ref);
  }
  return { added, removed, changed, unchanged };
}

export function useReportSectionDiff(a?: ReportRecord, b?: ReportRecord): SectionDiff {
  return useMemo(() => diffReportSections(a, b), [a, b]);
}
