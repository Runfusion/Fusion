import { readFileSync } from "node:fs";
import { extname } from "node:path";
import type { Report } from "../store/report-types.js";
import { escapeAttr } from "./escape.js";
import { buildBrandingCss, REPORT_STYLESHEET } from "./html-styles.js";
import { renderReportHtml, type ReportRecord, type ReportRenderOptions } from "./html-template.js";

const ALLOWLISTED_LINK_PREFIXES = ["https://runfusion.ai"];

function inferMime(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}

function toDataUri(path: string): string {
  const mime = inferMime(path);
  const bytes = readFileSync(path);
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

function removeScripts(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
}

function sanitizeExternalImages(html: string): string {
  return html.replace(/<img\b([^>]*?)\ssrc=["'](https?:[^"']+)["']([^>]*)>/gi, "<!-- stripped external image -->");
}

function assertNoExternalRefs(html: string): string {
  const matches = [...html.matchAll(/(href|src)\s*=\s*["'](https?:[^"']+)["']/gi)];
  const disallowed = matches.filter((m) => !ALLOWLISTED_LINK_PREFIXES.some((prefix) => m[2]?.startsWith(prefix)));
  if (disallowed.length === 0) return html;
  if (process.env.NODE_ENV !== "production") {
    throw new Error(`Standalone HTML contains external refs: ${disallowed.map((m) => m[2]).join(", ")}`);
  }
  return `${html}\n<!-- WARNING: stripped/retained external refs detected -->`;
}

function resolveBrandLogo(record: ReportRecord): string | undefined {
  const metadata = record.metadata && typeof record.metadata === "object" ? record.metadata as Record<string, unknown> : {};
  const settings = metadata.settings && typeof metadata.settings === "object" ? metadata.settings as Record<string, unknown> : {};
  const branding = settings.branding && typeof settings.branding === "object" ? settings.branding as Record<string, unknown> : {};
  const logoDataUri = typeof branding.logoDataUri === "string" ? branding.logoDataUri : undefined;
  const logoPath = typeof branding.logoPath === "string" ? branding.logoPath : undefined;
  if (logoDataUri?.startsWith("data:")) return logoDataUri;
  if (logoPath && !/^https?:/i.test(logoPath)) return toDataUri(logoPath);
  return undefined;
}

export function slugifyReportFilename(record: Pick<Report, "title" | "periodStart" | "periodEnd">): string {
  const base = `${record.title}-${record.periodStart}-${record.periodEnd}`.toLowerCase();
  const slug = base.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);
  return `${slug || "fusion-report"}.html`;
}

export function renderStandaloneReportHtml(record: ReportRecord, options: ReportRenderOptions = {}): string {
  const logoDataUri = resolveBrandLogo(record);
  const metadata = record.metadata && typeof record.metadata === "object" ? { ...(record.metadata as Record<string, unknown>) } : {};
  const settings = metadata.settings && typeof metadata.settings === "object" ? { ...(metadata.settings as Record<string, unknown>) } : {};
  const branding = settings.branding && typeof settings.branding === "object" ? { ...(settings.branding as Record<string, unknown>) } : {};
  if (logoDataUri) branding.logoDataUri = logoDataUri;
  settings.branding = branding;
  metadata.settings = settings;

  const html = renderReportHtml({ ...record, metadata }, { ...options, includeChrome: true });
  const styleBlock = `<style>${REPORT_STYLESHEET}\n${buildBrandingCss({ accentColor: typeof branding.accentColor === "string" ? branding.accentColor : undefined, logoDataUri: typeof branding.logoDataUri === "string" ? branding.logoDataUri : undefined, logoTextColor: typeof branding.logoTextColor === "string" ? branding.logoTextColor : undefined })}</style>`;
  const withSingleStyle = html.replace(/<style>[\s\S]*?<\/style>/i, styleBlock);
  const sanitized = sanitizeExternalImages(removeScripts(withSingleStyle));
  return assertNoExternalRefs(sanitized);
}
