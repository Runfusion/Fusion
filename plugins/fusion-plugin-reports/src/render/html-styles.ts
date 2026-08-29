import { escapeAttr } from "./escape.js";

export interface ReportBranding {
  accentColor?: string;
  logoDataUri?: string;
  logoTextColor?: string;
}

export const REPORT_STYLESHEET = `
:root {
  --space-xs: 4px; --space-sm: 8px; --space-md: 12px; --space-lg: 16px; --space-xl: 24px;
  --radius-sm: 4px; --radius-md: 8px; --radius-lg: 12px;
  --bg: #0d1117; --surface: #161b22; --card: #1f2733; --text: #e6edf3; --text-muted: #8b949e; --border: #30363d;
  --triage: #8b949e; --todo: #58a6ff; --in-progress: #d29922; --in-review: #a371f7; --done: #3fb950;
  --color-success: #3fb950; --color-error: #f85149; --color-warning: #d29922; --color-info: #58a6ff;
  --report-accent: #5b8def;
}
[data-theme="light"] {
  --bg: #ffffff; --surface: #f6f8fa; --card: #ffffff; --text: #1f2328; --text-muted: #59636e; --border: #d0d7de;
}
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
.report { max-width: 980px; margin: 0 auto; padding: var(--space-xl); }
.report-header, .report-section, .agent-card, .report-footer { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: var(--space-lg); margin-bottom: var(--space-lg); }
.report-title { margin: 0 0 var(--space-sm); font-size: 28px; }
.report-meta { display: flex; flex-wrap: wrap; gap: var(--space-sm); color: var(--text-muted); }
.pill { border-radius: 999px; padding: 2px 10px; border: 1px solid var(--border); }
.status { background: color-mix(in srgb, var(--report-accent) 22%, transparent); color: var(--report-accent); }
.section-title { margin: 0 0 var(--space-sm); font-size: 18px; }
.section-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: var(--space-md); }
.panel { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-md); padding: var(--space-md); }
ul { margin: var(--space-sm) 0 0; padding-left: 18px; }
`;

export function buildBrandingCss(branding: ReportBranding | undefined): string {
  if (!branding) return "";
  const accent = branding.accentColor ? `--report-accent: ${escapeAttr(branding.accentColor)};` : "";
  const logo = branding.logoTextColor ? `--report-logo-text: ${escapeAttr(branding.logoTextColor)};` : "";
  if (!accent && !logo) return "";
  return `:root { ${accent} ${logo} }`;
}
