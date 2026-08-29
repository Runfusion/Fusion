import { redactSecrets } from "@fusion/core";

export interface ReportScrubContext {
  rootDir?: string;
  projectName?: string;
  homeDir?: string;
}

export interface ScrubbableReport {
  userPrompt?: string;
  summary?: string;
  body?: string;
  context?: Record<string, unknown>;
  [key: string]: unknown;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * FNXC:ReportPipeline 2026-07-16-12:00:
 * Reports cross a privacy boundary when they leave Fusion for GitHub. Every
 * textual field is scrubbed here and is scrubbed again immediately before
 * egress so an edited draft cannot reintroduce paths, project identity, or
 * credentials.
 *
 * FNXC:ReportPipeline 2026-07-16-18:30:
 * Free-form prompts and collected task/log context can contain PII as well as
 * credentials. Remove email addresses and likely personal names before a
 * report can leave Fusion; this protection is mandatory in every mode.
 */
export function scrubReportText(text: string | undefined, context: ReportScrubContext = {}): string {
  if (!text) return "";
  let scrubbed = redactSecrets(text);
  const namedValues = [context.rootDir, context.homeDir, context.projectName]
    .filter((value): value is string => Boolean(value?.trim()))
    .sort((a, b) => b.length - a.length);

  for (const value of namedValues) {
    scrubbed = scrubbed.replace(new RegExp(escapeRegExp(value), "gi"), "[REDACTED]");
  }

  // Home-directory usernames and absolute paths are identifying even when the
  // caller cannot provide a fully resolved local root directory.
  return scrubbed
    .replace(/data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]+/gi, "[REDACTED_BINARY]")
    .replace(/(?:~|\/Users|\/home)\/[A-Za-z0-9._-]+(?:\/[\w .@+=,~:/-]*)?/g, "[REDACTED_PATH]")
    .replace(/(?:[A-Za-z]:\\|\\\\[^\\/]+\\[^\\/]+|\/(?:[\w .@+=,~-]+\/)+[\w .@+=,~-]*)/g, "[REDACTED_PATH]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]")
    .replace(/\b(?:name|user(?:name)?|author|owner|reporter)\s*[:=]\s*[A-Za-z][A-Za-z'’-]*(?:\s+[A-Za-z][A-Za-z'’-]*){0,2}/gi, (match) => `${match.slice(0, match.search(/[:=]/) + 1)} [REDACTED_NAME]`)
    .replace(/\b[A-Z][a-z'’-]+\s+[A-Z][a-z'’-]+\b/g, "[REDACTED_NAME]");
}

function scrubValue(value: unknown, context: ReportScrubContext): unknown {
  /*
  FNXC:ReportPipeline 2026-07-18-14:30:
  Draft bodies are user-editable and therefore untrusted on the file route.
  Never make a generic data-URL exception here: only the separately validated
  typed screenshot upload path may preserve binary pixels. Every report string,
  including a pasted image URL, remains subject to the mandatory text scrub.
  */
  if (typeof value === "string") return scrubReportText(value, context);
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, context));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrubValue(item, context)]));
  }
  return value;
}

/** Scrub every textual payload field, including nested gathered context. */
export function scrubReportPayload<T extends object>(report: T, context: ReportScrubContext = {}): T {
  return scrubValue(report, context) as T;
}
