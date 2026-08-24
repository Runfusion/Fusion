import React, { useCallback, useState, type MouseEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useTranslation } from "react-i18next";
import { markdownComponents } from "./AgentLogViewer";
import { linkifyFilePaths } from "../utils/filePathLinkify";
import "./ThinkingTrace.css";

export type ThinkingSection = { id: string; title: string | null; body: string };

function trimBlankEdges(value: string): string {
  return value.replace(/^(?:[\t ]*\r?\n)+|(?:\r?\n[\t ]*)+$/g, "");
}

/**
 * FNXC:ThinkingTrace 2026-08-22-16:56:
 * Providers can legitimately send consecutive titled thought headings without bodies. Preserve every title as a section so the operator can distinguish that upstream payload from Fusion hiding reasoning.
 */
export function parseThinkingSections(text: string): ThinkingSection[] {
  const lines = text.split(/\r?\n/);
  const parsed: Array<{ title: string | null; lines: string[] }> = [{ title: null, lines: [] }];
  let foundTitle = false;

  for (const line of lines) {
    const trimmed = line.trim();
    const bold = /^\*\*(.+?)\*\*$/.exec(trimmed);
    const atx = /^#{1,6}\s+(.+)$/.exec(trimmed);
    const title = (bold?.[1] ?? atx?.[1])?.trim();
    if (title) {
      foundTitle = true;
      parsed.push({ title, lines: [] });
    } else {
      parsed.at(-1)?.lines.push(line);
    }
  }

  if (!foundTitle) return [{ id: "s0", title: null, body: text }];
  return parsed
    .map((section, index) => ({ id: `${index}:${section.title ?? ""}`, title: section.title, body: trimBlankEdges(section.lines.join("\n")) }))
    .filter((section) => section.title !== null || section.body.length > 0);
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
    <div className="thinking-trace-section-body" onClick={handleClick}>
      {section.body ? <ThinkingTraceBody body={section.body} format={format} /> : <span className="thinking-trace-empty-message">{t("thinking.noDetail", "No reasoning captured for this step")}</span>}
    </div>
  </details>;
}

export function ThinkingTrace({ text, format = "plain", className, testId }: ThinkingTraceProps) {
  const { t } = useTranslation("app");
  const sections = parseThinkingSections(text);
  const [explicitOpen, setExplicitOpen] = useState<Record<string, boolean>>({});
  if (text.trim().length === 0) return null;
  const titled = sections.some((section) => section.title !== null);
  const setAll = (open: boolean) => setExplicitOpen(Object.fromEntries(sections.map((section) => [section.id, open])));
  const rootClass = ["thinking-trace", className].filter(Boolean).join(" ");
  if (!titled) return <div className={rootClass} data-testid={testId}><ThinkingTraceBody body={sections[0]?.body ?? text} format={format} /></div>;
  const allOpen = sections.every((section) => explicitOpen[section.id] ?? true);
  return <div className={rootClass} data-testid={testId}>
    <div className="thinking-trace-header"><span>{t("thinking.sectionCount", "{{count}} section", { count: sections.length })}</span><button type="button" className="btn btn-sm" onClick={() => setAll(!allOpen)}>{allOpen ? t("thinking.collapseAll", "Collapse all") : t("thinking.expandAll", "Expand all")}</button></div>
    {sections.map((section) => <ThinkingTraceSection key={section.id} section={section} format={format} open={explicitOpen[section.id] ?? true} onToggle={(open) => setExplicitOpen((current) => ({ ...current, [section.id]: open }))} />)}
  </div>;
}
