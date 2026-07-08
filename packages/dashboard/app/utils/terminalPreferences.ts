export const TERMINAL_PREFERENCES_KEY = "kb-terminal-preferences";
export const LEGACY_TERMINAL_FONT_SIZE_KEY = "kb-terminal-font-size";
export const DEFAULT_TERMINAL_FONT_SIZE = 14;
export const MIN_TERMINAL_FONT_SIZE = 8;
export const MAX_TERMINAL_FONT_SIZE = 32;

export const TERMINAL_SYMBOLS_FONT_FAMILY = '"Fusion Terminal Nerd Font Symbols"';

/*
FNXC:Terminal 2026-06-18-15:38:
FN-6659 recurrence #5 showed the FN-6638 66.76px diagnostic compared only symbols-inclusive stacks: symbols-first, symbols-last, and system-mono all still contained the loaded unicode-range symbols @font-face. Real iOS Safari therefore implicated the symbols face's mere presence in xterm's measured font shorthand, not stack order. Keep xterm's measured family symbols-free for every preset and both terminal surfaces; a separate DOM glyph CSS layer may append the symbols face where it does not feed xterm's ASCII cell measurement.
*/
export const XTERM_FONT_FAMILY =
  '"MesloLGS NF", "MesloLGM Nerd Font", "JetBrainsMono Nerd Font", "FiraCode Nerd Font", "Hack Nerd Font", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';

export const TERMINAL_FONT_FAMILY_PRESETS = [
  {
    id: "nerd-font",
    label: "Nerd Font stack",
    css: XTERM_FONT_FAMILY,
  },
  {
    id: "system-mono",
    label: "System monospace",
    css: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
  },
  {
    id: "jetbrains-mono",
    label: "JetBrains Mono",
    css: '"JetBrains Mono", "JetBrainsMono Nerd Font", ui-monospace, SFMono-Regular, monospace',
  },
  {
    id: "fira-code",
    label: "Fira Code",
    css: '"Fira Code", "FiraCode Nerd Font", ui-monospace, SFMono-Regular, monospace',
  },
] as const;

export type TerminalFontFamily = (typeof TERMINAL_FONT_FAMILY_PRESETS)[number]["id"];
export type TerminalCursorStyle = "block" | "underline" | "bar";
export type TerminalRenderer = "auto" | "canvas";

export interface TerminalPreferences {
  fontFamily: TerminalFontFamily;
  fontSize: number;
  cursorStyle: TerminalCursorStyle;
  cursorBlink: boolean;
  renderer: TerminalRenderer;
}

/*
FNXC:Terminal 2026-06-16-23:35:
Terminal preferences are intentionally client-local: users can customize font, cursor, and renderer without introducing server settings schema. Reads must tolerate unavailable storage, corrupt JSON, unknown enum values, and legacy font-size data so opening the terminal never throws and always falls back to safe defaults.
*/
export const DEFAULT_TERMINAL_PREFERENCES: TerminalPreferences = {
  fontFamily: "nerd-font",
  fontSize: DEFAULT_TERMINAL_FONT_SIZE,
  cursorStyle: "block",
  cursorBlink: true,
  renderer: "auto",
};

export function clampTerminalFontSize(value: number): number {
  return Math.min(MAX_TERMINAL_FONT_SIZE, Math.max(MIN_TERMINAL_FONT_SIZE, value));
}

function stripTerminalSymbolsFontFamily(stack: string): string {
  return splitTerminalFontFamilies(stack)
    .filter((family) => family !== TERMINAL_SYMBOLS_FONT_FAMILY)
    .join(", ");
}

export function resolveTerminalFontFamily(fontFamily: TerminalFontFamily): string {
  const presetStack =
    TERMINAL_FONT_FAMILY_PRESETS.find((preset) => preset.id === fontFamily)?.css ??
    XTERM_FONT_FAMILY;

  /*
  FNXC:Terminal 2026-06-20-18:04:
  FN-6811 recurrence #6 keeps the symbols-free measured-family invariant defensive at the shared resolver boundary. Preset constants and tests should stay clean, but this filter prevents any future UI path from accidentally feeding the symbols-only face into xterm's ASCII cell measurement option.
  */
  return stripTerminalSymbolsFontFamily(presetStack);
}

export function resolveTerminalGlyphFontFamily(fontFamily: TerminalFontFamily): string {
  return `${resolveTerminalFontFamily(fontFamily)}, ${TERMINAL_SYMBOLS_FONT_FAMILY}`;
}

const CSS_GENERIC_FONT_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "emoji",
  "math",
  "fangsong",
]);

type TerminalFontFaceSet = {
  load?: (font: string, text?: string) => PromiseLike<unknown>;
  ready?: PromiseLike<unknown>;
};

export function splitTerminalFontFamilies(stack: string): string[] {
  return stack
    .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((family) => family.trim())
    .filter(Boolean);
}

function normalizeFontFamilyName(family: string): string {
  const trimmed = family.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function isLoadableConcreteFontFamily(family: string): boolean {
  const normalized = normalizeFontFamilyName(family).toLowerCase();
  return normalized !== "" && !CSS_GENERIC_FONT_FAMILIES.has(normalized);
}

function getDocumentFonts(): TerminalFontFaceSet | undefined {
  if (typeof document === "undefined") {
    return undefined;
  }
  return document.fonts;
}

async function settleFontLoad(fonts: TerminalFontFaceSet, font: string): Promise<boolean> {
  if (!fonts.load) {
    return false;
  }

  try {
    await fonts.load(font);
    return true;
  } catch {
    // Best-effort: strict iOS FontFaceSet parsing can reject one shorthand while
    // later declarations or fonts.ready still give xterm a safe remeasure point.
    return false;
  }
}

export async function waitForTerminalFontMetrics(
  fontSize: number,
  fontFamily: string,
  fonts: TerminalFontFaceSet | undefined = getDocumentFonts(),
): Promise<boolean> {
  if (!fonts?.load) {
    return false;
  }

  const fontSizeCss = `${fontSize}px`;
  const declarations = [
    `${fontSizeCss} ${fontFamily}`,
    ...splitTerminalFontFamilies(fontFamily)
      .filter(isLoadableConcreteFontFamily)
      .map((family) => `${fontSizeCss} ${family}`),
  ];

  /*
  FNXC:Terminal 2026-06-18-07:02:
  FN-6638 recurrence #4 showed font-stack order was inert: the supplied diagnostic measured AGENTS.md at the same 66.76px with symbols-first, symbols-last, and system-mono stacks while real iOS Safari still rendered wide ASCII cells. Treat FontFaceSet loading as best-effort and always leave callers free to reapply xterm font options; strict iOS WebKit can reject the long multi-family shorthand, and that rejection must not suppress DOM/canvas or WebGL metric invalidation for any preset.
  */
  const [fullStackDeclaration, ...individualDeclarations] = declarations;
  const fullStackLoaded = fullStackDeclaration
    ? await settleFontLoad(fonts, fullStackDeclaration)
    : false;

  if (!fullStackLoaded) {
    for (const declaration of individualDeclarations) {
      await settleFontLoad(fonts, declaration);
    }
  }

  try {
    await fonts.ready;
  } catch {
    // Continue to xterm remeasure even if the FontFaceSet settles rejected.
  }

  return true;
}

/*
FNXC:Terminal 2026-07-04-09:30:
FN-7561 (recurrence #3 of mobile inter-character spacing, after FN-7456's DOM
glyph-fallback fix and FN-7460's `text-size-adjust: none`) root cause: real
xterm.js's `OptionsService` setter is a strict no-op when a caller reassigns an
option to a value that already strictly-equals its current value (no
`onOptionChange` fires — see `@xterm/xterm` `common/services/OptionsService.ts`).
Both terminal surfaces reapply `terminal.options.fontFamily`/`fontSize` with the
SAME already-resolved value once `waitForTerminalFontMetrics()` settles, which is
the common case (the user never touched terminal preferences). That reassignment
never fires `onOptionChange`, so xterm's `CharSizeService` (canvas/DOM character
measurement) and `DomRenderer._setDefaultSpacing()` (the letter-spacing
compensation baked onto `.xterm-rows`) never recompute against the web font that
finished loading AFTER xterm's initial pre-load (fallback-font) measurement. The
stale pre-load cell metrics + compensation persist as visible excess
inter-character gaps on the very first mobile layout until an unrelated event
(resize/orientation/DPR change) happens to produce a genuine value change and
incidentally force a real remeasure — exactly the "only repairs itself after
keyboard toggle/orientation/reconnect" symptom reported for this recurrence.
Force a genuine (distinct-value) transition through a sentinel font family
before landing back on the resolved value so xterm's internal remeasure
pipeline always runs at least once against the now-settled font, regardless of
whether the resolved value already matches the terminal's current option value.
*/
const TERMINAL_FONT_REMEASURE_SENTINEL_FONT_FAMILY = "monospace";

export function forceTerminalFontRemeasure(
  terminal: { options: { fontFamily?: string } },
  fontFamily: string,
): void {
  const sentinel =
    fontFamily === TERMINAL_FONT_REMEASURE_SENTINEL_FONT_FAMILY
      ? `${TERMINAL_FONT_REMEASURE_SENTINEL_FONT_FAMILY}, monospace`
      : TERMINAL_FONT_REMEASURE_SENTINEL_FONT_FAMILY;
  terminal.options.fontFamily = sentinel;
  terminal.options.fontFamily = fontFamily;
}

/*
FNXC:Terminal 2026-07-05-12:40:
FN-7603 recurrence #5 root cause (grounded in the installed `@xterm/xterm@5.5.0`
source, see task doc key="xterm-source-audit" on FN-7603): xterm's
`CharSizeService` picks its character-measurement strategy at construction time
(inside `terminal.open()`) via `try { new OffscreenCanvasStrategy(optionsService) }
catch { new DomFallbackStrategy(document, helperContainer, optionsService) }`.
Whenever `OffscreenCanvas` + `CanvasRenderingContext2D.measureText()` reporting
`fontBoundingBoxAscent`/`fontBoundingBoxDescent` are available — true on
essentially every real modern mobile Safari/Chrome — the CANVAS strategy is
chosen, and `dimensions.css.cell.width` (which feeds `FitAddon.fit()`'s column
count AND `DomRenderer._setDefaultSpacing()`'s baked letter-spacing) is measured
via Canvas 2D `ctx.measureText("W")`. Separately, `DomRenderer._setDefaultSpacing()`
subtracts `WidthCache.get('W')` — an ENTIRELY SEPARATE, DOM-based measurement
(`offsetWidth` of a hidden 32x-repeated-"W" span) — from that canvas-measured
cell width to compute the compensating letter-spacing baked onto `.xterm-rows`.
Those are two DIFFERENT browser text-rendering pipelines (Canvas 2D vs CSS/DOM
layout) queried against the same font; real glyphs are painted 100% via DOM
(`DomRenderer` never draws through canvas), so the only way for the baked
spacing to reliably converge to the DOM's own natural (tight) glyph advance is
for BOTH measurements to go through the SAME (DOM) pipeline. FN-7456/FN-7460/
FN-7561/FN-7567 never touched which measurement strategy CharSizeService uses,
only WHEN/how often it remeasures — so this Canvas-vs-DOM divergence survived
all four prior fixes and can still bake a small-but-visible, non-zero,
systematic inter-character gap on the very first mobile layout even after every
prior remedy runs correctly. Force xterm onto the SAME (DOM) measurement
pipeline CharSizeService already ships as its own fallback strategy by making
`OffscreenCanvas` transiently unavailable for the synchronous duration of
`terminal.open()`, so `CharSizeService`'s constructor try-block throws and it
self-selects its own DOM-based `l` strategy — unifying `dimensions.css.cell.width`
and `WidthCache.get('W')` onto one measurement pipeline instead of adding any
hardcoded compensation. See `docs/solutions/ui-bugs/xterm-options-noop-remeasure-after-font-settle.md`
recurrence #5 section.
*/
export function withDomBasedTerminalCharacterMeasurement<T>(fn: () => T): T {
  if (typeof window === "undefined" || !("OffscreenCanvas" in window)) {
    // Nothing to hide — CharSizeService will already fall back to its DOM
    // strategy on its own (e.g. older WebKit without OffscreenCanvas support).
    return fn();
  }

  const descriptor = Object.getOwnPropertyDescriptor(window, "OffscreenCanvas");
  const originalValue = (window as unknown as Record<string, unknown>).OffscreenCanvas;

  try {
    delete (window as unknown as Record<string, unknown>).OffscreenCanvas;
  } catch {
    // Some environments define OffscreenCanvas as non-configurable; nothing
    // we can safely do, so proceed without forcing the DOM strategy.
    return fn();
  }

  try {
    return fn();
  } finally {
    if (descriptor) {
      Object.defineProperty(window, "OffscreenCanvas", descriptor);
    } else if (originalValue !== undefined) {
      (window as unknown as Record<string, unknown>).OffscreenCanvas = originalValue;
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTerminalFontFamily(value: unknown): value is TerminalFontFamily {
  return (
    typeof value === "string" &&
    TERMINAL_FONT_FAMILY_PRESETS.some((preset) => preset.id === value)
  );
}

function isTerminalCursorStyle(value: unknown): value is TerminalCursorStyle {
  return value === "block" || value === "underline" || value === "bar";
}

function isTerminalRenderer(value: unknown): value is TerminalRenderer {
  return value === "auto" || value === "canvas";
}

function readLegacyFontSize(): number | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  try {
    const savedFontSize = window.localStorage?.getItem?.(LEGACY_TERMINAL_FONT_SIZE_KEY);
    if (!savedFontSize) {
      return undefined;
    }

    const parsed = Number.parseInt(savedFontSize, 10);
    if (!Number.isFinite(parsed)) {
      return undefined;
    }

    return clampTerminalFontSize(parsed);
  } catch {
    return undefined;
  }
}

function normalizeTerminalPreferences(value: unknown): TerminalPreferences {
  const source = isObject(value) ? value : {};
  const rawFontSize = source.fontSize;
  const parsedFontSize =
    typeof rawFontSize === "number"
      ? rawFontSize
      : typeof rawFontSize === "string"
        ? Number.parseInt(rawFontSize, 10)
        : Number.NaN;

  return {
    fontFamily: isTerminalFontFamily(source.fontFamily)
      ? source.fontFamily
      : DEFAULT_TERMINAL_PREFERENCES.fontFamily,
    fontSize: Number.isFinite(parsedFontSize)
      ? clampTerminalFontSize(parsedFontSize)
      : DEFAULT_TERMINAL_PREFERENCES.fontSize,
    cursorStyle: isTerminalCursorStyle(source.cursorStyle)
      ? source.cursorStyle
      : DEFAULT_TERMINAL_PREFERENCES.cursorStyle,
    cursorBlink:
      typeof source.cursorBlink === "boolean"
        ? source.cursorBlink
        : DEFAULT_TERMINAL_PREFERENCES.cursorBlink,
    renderer: isTerminalRenderer(source.renderer)
      ? source.renderer
      : DEFAULT_TERMINAL_PREFERENCES.renderer,
  };
}

export function readTerminalPreferences(): TerminalPreferences {
  if (typeof window === "undefined") {
    return { ...DEFAULT_TERMINAL_PREFERENCES };
  }

  try {
    const savedPreferences = window.localStorage?.getItem?.(TERMINAL_PREFERENCES_KEY);
    if (savedPreferences) {
      return normalizeTerminalPreferences(JSON.parse(savedPreferences));
    }

    const legacyFontSize = readLegacyFontSize();
    if (legacyFontSize === undefined) {
      return { ...DEFAULT_TERMINAL_PREFERENCES };
    }

    const migratedPreferences = {
      ...DEFAULT_TERMINAL_PREFERENCES,
      fontSize: legacyFontSize,
    };
    window.localStorage?.setItem?.(
      TERMINAL_PREFERENCES_KEY,
      JSON.stringify(migratedPreferences),
    );
    return migratedPreferences;
  } catch {
    return { ...DEFAULT_TERMINAL_PREFERENCES };
  }
}

export function writeTerminalPreferences(
  patch: Partial<TerminalPreferences>,
): TerminalPreferences {
  const nextPreferences = normalizeTerminalPreferences({
    ...readTerminalPreferences(),
    ...patch,
  });

  if (typeof window === "undefined") {
    return nextPreferences;
  }

  try {
    window.localStorage?.setItem?.(
      TERMINAL_PREFERENCES_KEY,
      JSON.stringify(nextPreferences),
    );
    // Keep the retired scalar value in sync for any stale tab still reading it
    // while this deployment is hot-reloaded.
    window.localStorage?.setItem?.(
      LEGACY_TERMINAL_FONT_SIZE_KEY,
      String(nextPreferences.fontSize),
    );
  } catch {
    // Ignore persistence failures; callers still receive the normalized live value.
  }

  return nextPreferences;
}
