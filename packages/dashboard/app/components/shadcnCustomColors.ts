export type ShadcnCustomColorToken = {
  cssVar: string;
  label: string;
  defaultDark: string;
  defaultLight: string;
};

/*
FNXC:DashboardTheming 2026-06-20-18:25:
Shadcn custom colors are a security boundary: overrides apply only when the selected theme is shadcn-custom, missing tokens must fall back to the CSS base defaults, and only sanitized #RGB/#RRGGBB hex values may be written as inline CSS custom properties.
*/
export const SHADCN_CUSTOM_COLOR_TOKENS = [
  { cssVar: "--accent", label: "Accent", defaultDark: "#f97316", defaultLight: "#ea580c" },
  { cssVar: "--bg", label: "Background", defaultDark: "#09090b", defaultLight: "#ffffff" },
  { cssVar: "--surface", label: "Surface", defaultDark: "#0c0c0e", defaultLight: "#ffffff" },
  { cssVar: "--card", label: "Card", defaultDark: "#18181b", defaultLight: "#ffffff" },
  { cssVar: "--border", label: "Border", defaultDark: "#27272a", defaultLight: "#e4e4e7" },
  { cssVar: "--text", label: "Text", defaultDark: "#fafafa", defaultLight: "#09090b" },
  { cssVar: "--text-muted", label: "Muted text", defaultDark: "#a1a1aa", defaultLight: "#71717a" },
  { cssVar: "--todo", label: "Todo", defaultDark: "#60a5fa", defaultLight: "#2563eb" },
  { cssVar: "--in-progress", label: "In progress", defaultDark: "#38bdf8", defaultLight: "#0284c7" },
  { cssVar: "--in-review", label: "In review", defaultDark: "#34d399", defaultLight: "#16a34a" },
  { cssVar: "--triage", label: "Triage", defaultDark: "#f59e0b", defaultLight: "#d97706" },
  { cssVar: "--done", label: "Done", defaultDark: "#71717a", defaultLight: "#a1a1aa" },
  { cssVar: "--color-success", label: "Success", defaultDark: "#22c55e", defaultLight: "#16a34a" },
  { cssVar: "--color-warning", label: "Warning", defaultDark: "#f59e0b", defaultLight: "#d97706" },
  { cssVar: "--color-error", label: "Error", defaultDark: "#ef4444", defaultLight: "#dc2626" },
] as const satisfies readonly ShadcnCustomColorToken[];

const SHADCN_CUSTOM_COLOR_TOKEN_SET: ReadonlySet<string> = new Set(
  SHADCN_CUSTOM_COLOR_TOKENS.map((token) => token.cssVar),
);

const HEX_COLOR_PATTERN = /^#(?:[\da-f]{3}|[\da-f]{6})$/i;

export function isValidHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR_PATTERN.test(value.trim());
}

export function sanitizeShadcnCustomColors(
  map: unknown,
): Record<string, string> {
  if (!map || typeof map !== "object" || Array.isArray(map)) {
    return {};
  }

  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(map as Record<string, unknown>)) {
    if (!SHADCN_CUSTOM_COLOR_TOKEN_SET.has(key) || !isValidHexColor(value)) {
      continue;
    }
    sanitized[key] = value.trim();
  }
  return sanitized;
}

export function applyShadcnCustomColorOverrides(
  element: HTMLElement,
  map: unknown,
): Record<string, string> {
  const sanitized = sanitizeShadcnCustomColors(map);
  cleanupShadcnCustomColorOverrides(element);
  for (const [cssVar, value] of Object.entries(sanitized)) {
    element.style.setProperty(cssVar, value);
  }
  return sanitized;
}

export function cleanupShadcnCustomColorOverrides(element: HTMLElement): void {
  for (const token of SHADCN_CUSTOM_COLOR_TOKENS) {
    element.style.removeProperty(token.cssVar);
  }
}

export function getShadcnCustomDefaultValue(
  token: ShadcnCustomColorToken,
  themeMode: "dark" | "light" = "dark",
): string {
  return themeMode === "light" ? token.defaultLight : token.defaultDark;
}
