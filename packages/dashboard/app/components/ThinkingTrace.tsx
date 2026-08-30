import React, { useCallback, useState, type MouseEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useTranslation } from "react-i18next";
import { markdownComponents } from "./AgentLogViewer";
import { linkifyFilePaths } from "../utils/filePathLinkify";
import "./ThinkingTrace.css";

export type ThinkingSection = { id: string; title: string | null; body: string };

type ParsedThinkingSection = { title: string | null; rawTitleLine?: string; lines: string[] };

function trimBlankEdges(value: string): string {
  return value.replace(/^(?:[\t ]*\r?\n)+|(?:\r?\n[\t ]*)+$/g, "");
}

/**
 * FNXC:ThinkingTrace 2026-08-22-16:56:
 * Providers can legitimately send consecutive titled thought headings without bodies. Preserve every title visibly so the operator can distinguish that upstream payload from Fusion hiding reasoning.
 *
 * FNXC:ThinkingTrace 2026-08-23-05:32:
 * FN-177's operator report showed titles-only payloads as empty accordion rows. Body-less headings now remain inline in flowing text; `inlinedHeadingCount` keeps Raw trace reachable for that exact upstream-only-titles signal without creating empty rows.
 */
export function parseThinkingTrace(text: string): { sections: ThinkingSection[]; inlinedHeadingCount: number } {
  const lines = text.split(/\r?\n/);
  const parsed: ParsedThinkingSection[] = [{ title: null, lines: [] }];
  let foundTitle = false;

  for (const line of lines) {
    const trimmed = line.trim();
    const bold = /^\*\*(.+?)\*\*$/.exec(trimmed);
    const atx = /^#{1,6}\s+(.+)$/.exec(trimmed);
    const title = (bold?.[1] ?? atx?.[1])?.trim();
    if (title) {
      foundTitle = true;
      parsed.push({ title, rawTitleLine: line, lines: [] });
    } else {
      parsed.at(-1)?.lines.push(line);
    }
  }

  if (!foundTitle) return { sections: [{ id: "s0", title: null, body: text }], inlinedHeadingCount: 0 };

  let inlinedHeadingCount = 0;
  let foldTargetIndex = 0;
  for (let index = 1; index < parsed.length; index += 1) {
    const section = parsed[index];
    if (section.title !== null && trimBlankEdges(section.lines.join("\n")).length === 0) {
      parsed[foldTargetIndex].lines.push(section.rawTitleLine ?? "", ...section.lines);
      section.title = null;
      section.lines = [];
      inlinedHeadingCount += 1;
    } else {
      foldTargetIndex = index;
    }
  }

  return {
    sections: parsed
      .map((section, index) => ({ id: `${index}:${section.title ?? ""}`, title: section.title, body: trimBlankEdges(section.lines.join("\n")) }))
      .filter((section) => section.title !== null || section.body.length > 0),
    inlinedHeadingCount,
  };
}

export function parseThinkingSections(text: string): ThinkingSection[] {
  return parseThinkingTrace(text).sections;
}

export function isInteractiveDisclosureTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest("a,button,input,textarea,select,summary,[role=\"button\"],[contenteditable=\"true\"]"));
}

type ThinkingTraceProps = {
  text: string;
  format?: "plain" | "markdown";
  className?: string;
  testId?: string;
};

function ThinkingTraceBody({ body, format }: Pick<ThinkingTraceProps, "format"> & { body: string }) {
  if (format === "markdown") {
    return <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{body}</ReactMarkdown></div>;
  }
  return <pre className="thinking-trace-plain">{linkifyFilePaths(body)}</pre>;
}

function ThinkingTraceSection({ section, format, open, onToggle }: {
  section: ThinkingSection;
  format: "plain" | "markdown";
  open: boolean;
  onToggle: (open: boolean) => void;
}) {
  const { t } = useTranslation("app");
  const handleClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (isInteractiveDisclosureTarget(event.target)) return;
    const details = event.currentTarget.closest("details");
    if (details?.open) onToggle(false);
  }, [onToggle]);
  return <details className="thinking-trace-section" data-testid="thinking-trace-section" open={open} onToggle={(event) => onToggle(event.currentTarget.open)}>
    <summary className="thinking-trace-section-summary">
      <span>{section.title ?? t("thinking.untitledSection", "Untitled reasoning")}</span>
      {!section.body && <span className="thinking-trace-section-empty">{t("thinking.noDetail", "No reasoning captured for this step")}</span>}
    </summary>
    {section.body && <div className="thinking-trace-section-body" onClick={handleClick}><ThinkingTraceBody body={section.body} format={format} /></div>}
  </details>;
}

export function ThinkingTrace({ text, format = "plain", className, testId }: ThinkingTraceProps) {
  const { t } = useTranslation("app");
  const { sections, inlinedHeadingCount } = parseThinkingTrace(text);
  const [explicitOpen, setExplicitOpen] = useState<Record<string, boolean>>({});
  const [showRaw, setShowRaw] = useState(false);
  if (text.trim().length === 0) return null;
  const titled = sections.some((section) => section.title !== null);
  const setAll = (open: boolean) => setExplicitOpen(Object.fromEntries(sections.map((section) => [section.id, open])));
  const rootClass = ["thinking-trace", className].filter(Boolean).join(" ");
  const hasHeader = titled || inlinedHeadingCount > 0;
  const rawToggle = <button type="button" className="btn btn-sm" data-testid="thinking-trace-raw-toggle" aria-pressed={showRaw} onClick={() => setShowRaw((current) => !current)}>{showRaw ? t("thinking.showSections", "Sectioned trace") : t("thinking.showRaw", "Raw trace")}</button>;

  if (!hasHeader) return <div className={rootClass} data-testid={testId}><ThinkingTraceBody body={sections[0]?.body ?? text} format={format} /></div>;

  const allOpen = sections.every((section) => explicitOpen[section.id] ?? true);
  /*
   * FNXC:ThinkingTrace 2026-08-23-05:32:
   * Raw trace is gated on inlined headings as well as surviving titled sections. Folding titles-only payloads must not hide the literal upstream capture or remove the operator's diagnostic escape hatch.
   */
  return <div className={rootClass} data-testid={testId}>
    <div className="thinking-trace-header">
      {titled && <span>{t("thinking.sectionCount", "{{count}} section", { count: sections.length })}</span>}
      <span className="thinking-trace-header-actions">
        {rawToggle}
        {titled && !showRaw && <button type="button" className="btn btn-sm" onClick={() => setAll(!allOpen)}>{allOpen ? t("thinking.collapseAll", "Collapse all") : t("thinking.expandAll", "Expand all")}</button>}
      </span>
    </div>
    {showRaw
      ? <pre className="thinking-trace-plain" data-testid="thinking-trace-raw">{linkifyFilePaths(text)}</pre>
      : titled
        ? sections.map((section) => <ThinkingTraceSection key={section.id} section={section} format={format} open={explicitOpen[section.id] ?? true} onToggle={(open) => setExplicitOpen((current) => ({ ...current, [section.id]: open }))} />)
        : <ThinkingTraceBody body={sections[0]?.body ?? text} format={format} />}
  </div>;
}
