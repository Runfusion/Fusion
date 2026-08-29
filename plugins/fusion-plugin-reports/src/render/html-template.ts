/**
 * Rendering approach: all agent/user text is escaped as plain text.
 * No markdown/HTML pass-through is allowed in this renderer.
 */
import type { CombinedReview } from "../review-types.js";
import type { Report } from "../store/report-types.js";
import { escapeAttr, escapeHtml } from "./escape.js";
import { buildBrandingCss, REPORT_STYLESHEET, type ReportBranding } from "./html-styles.js";

export interface ReportRecord extends Report {
  metadata: Record<string, unknown>;
}

export interface ReportRenderOptions {
  theme?: "dark" | "light" | "auto";
  includeChrome?: boolean;
}

interface ReportSectionsPayload {
  summary?: string;
  system?: SectionBuckets;
  perAgent?: Array<AgentSection>;
  dataCoverage?: string[];
}

interface SectionBuckets {
  wins?: string[];
  highlights?: string[];
  lowlights?: string[];
  proposals?: string[];
  deepDives?: string[];
}

interface AgentSection extends SectionBuckets {
  agentId: string;
  agentName?: string;
}

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean) : [];
}

function extract(record: ReportRecord): { sections: ReportSectionsPayload; order: string[]; enabled: Set<string>; branding: ReportBranding } {
  const metadata = asObj(record.metadata);
  const sections = asObj(metadata.sections);
  const settings = asObj(metadata.settings);
  const branding = asObj(settings.branding);
  const order = asStringArray(settings.sectionOrder);
  const enabled = new Set(asStringArray(settings.enabledSections));
  return {
    sections: {
      summary: asString(sections.summary),
      system: asObj(sections.system) as SectionBuckets,
      perAgent: Array.isArray(sections.perAgent)
        ? sections.perAgent.map((item) => {
          const agent = asObj(item);
          return {
            agentId: asString(agent.agentId) ?? "unknown",
            agentName: asString(agent.agentName),
            wins: asStringArray(agent.wins),
            highlights: asStringArray(agent.highlights),
            lowlights: asStringArray(agent.lowlights),
            proposals: asStringArray(agent.proposals),
            deepDives: asStringArray(agent.deepDives),
          };
        })
        : [],
      dataCoverage: asStringArray(sections.dataCoverage),
    },
    order,
    enabled,
    branding: {
      accentColor: asString(branding.accentColor),
      logoDataUri: asString(branding.logoDataUri),
      logoTextColor: asString(branding.logoTextColor),
    },
  };
}

function listSection(title: string, items: string[] | undefined, marker: string): string {
  if (!items || items.length === 0) return "";
  return `<section class="panel" data-section="${marker}"><h3>${escapeHtml(title)}</h3><ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></section>`;
}

function cadenceLabel(cadence: string): string {
  return cadence.charAt(0).toUpperCase() + cadence.slice(1);
}

export function renderReportHtml(record: ReportRecord, options: ReportRenderOptions = {}): string {
  const { sections, order, enabled, branding } = extract(record);
  const dataTheme = options.theme && options.theme !== "auto" ? options.theme : "dark";
  const includeChrome = options.includeChrome !== false;
  const title = asString(record.title) ?? "Fusion Activity Report";
  const summary = sections.summary ? `<section class="report-section" data-section="summary"><h2 class="section-title">Executive Summary</h2><p>${escapeHtml(sections.summary)}</p></section>` : "";
  const system = sections.system ?? {};
  const systemMap: Record<string, string> = {
    wins: listSection("Wins", system.wins, "system-wins"),
    highlights: listSection("Highlights", system.highlights, "system-highlights"),
    lowlights: listSection("Lowlights", system.lowlights, "system-lowlights"),
    proposals: listSection("Proposals", system.proposals, "system-proposals"),
    "deep-dives": listSection("Deep dives", system.deepDives, "system-deep-dives"),
  };
  const orderedKeys = order.length > 0 ? [...order, ...Object.keys(systemMap).filter((k) => !order.includes(k))] : Object.keys(systemMap);
  const systemSections = orderedKeys
    .filter((key) => key in systemMap)
    .filter((key) => enabled.size === 0 || enabled.has(key))
    .map((key) => systemMap[key])
    .join("");

  const perAgent = sections.perAgent ?? [];
  const perAgentHtml = (enabled.size === 0 || enabled.has("per-agent"))
    ? `<section class="report-section" data-section="agent-card"><h2 class="section-title">Per-agent sections</h2>${perAgent.map((agent) => `<article class="agent-card" data-agent-id="${escapeAttr(agent.agentId)}"><h3>${escapeHtml(agent.agentName ?? agent.agentId)}</h3><div class="section-grid">${listSection("Wins", agent.wins, "agent-wins")}${listSection("Highlights", agent.highlights, "agent-highlights")}${listSection("Lowlights", agent.lowlights, "agent-lowlights")}${listSection("Proposals", agent.proposals, "agent-proposals")}${listSection("Deep dives", agent.deepDives, "agent-deep-dives")}</div></article>`).join("")}</section>`
    : "";

  const coverage = sections.dataCoverage ?? ["Task board", "Agent activity", "Missions", "Run audit", "Workflow/test/build", "Manual notes"];
  const coverageSection = `<section class="report-footer" data-section="data-coverage"><h2 class="section-title">Data sources & coverage</h2><ul>${coverage.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></section>`;

  const review = (record.combinedReview as CombinedReview | null) ?? null;
  const reviewSection = review
    ? `<section class="report-footer" data-section="review-panel"><h2 class="section-title">Review panel summary</h2><p>${escapeHtml(review.overallVerdict)} — ${escapeHtml(review.consensusSummary)}</p><ul>${review.individual.map((member) => `<li>${escapeHtml(member.memberName)}: ${escapeHtml(member.verdict)}</li>`).join("")}</ul></section>`
    : "";

  const header = `<header class="report-header"><h1 class="report-title">${escapeHtml(title)}</h1><div class="report-meta"><span class="pill">${escapeHtml(cadenceLabel(record.cadence))}</span><span class="pill">${escapeHtml(record.periodStart)} → ${escapeHtml(record.periodEnd)}</span><span class="pill">Generated ${escapeHtml(record.generationCompletedAt ?? record.updatedAt)}</span><span class="pill status">${escapeHtml(record.status)}</span></div>${branding.logoDataUri ? `<p><img src="${escapeAttr(branding.logoDataUri)}" alt="Logo" style="max-height:36px"/></p>` : ""}</header>`;

  const article = `<article class="report">${header}${summary}${systemSections ? `<section class="report-section"><h2 class="section-title">System-wide rollup</h2><div class="section-grid">${systemSections}</div></section>` : ""}${perAgentHtml}${coverageSection}${reviewSection}</article>`;

  if (!includeChrome) return article;
  return `<!doctype html><html lang="en" data-theme="${escapeAttr(dataTheme)}"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>${escapeHtml(title)}</title><style>${REPORT_STYLESHEET}\n${buildBrandingCss(branding)}</style></head><body>${article}</body></html>`;
}
