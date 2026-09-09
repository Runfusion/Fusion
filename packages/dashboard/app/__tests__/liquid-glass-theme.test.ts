import { describe, expect, it } from "vitest";
import { COLOR_THEMES as CORE_COLOR_THEMES } from "@fusion/core";
import { COLOR_THEMES as DASHBOARD_COLOR_THEMES } from "../components/themeOptions";
import { readAppFile } from "../test/cssFixture";

const themeData = readAppFile("public/theme-data.css");
const dashboardIndexHtml = readAppFile("index.html");
const desktopIndexHtml = readAppFile("../../desktop/src/renderer/index.html");
const themeSelectorCss = readAppFile("components/ThemeSelector.css");
const liquidGlassCss = themeData.slice(
  themeData.indexOf("/* LIQUID GLASS"),
  themeData.indexOf("/* HORIZON", themeData.indexOf("/* LIQUID GLASS")),
);

function extractValidThemes(html: string): string[] {
  const match = html.match(/var validThemes = \[([\s\S]*?)\];/);
  if (!match) throw new Error("Could not find pre-hydration validThemes array");
  return [...match[1].matchAll(/["']([^"']+)["']/g)].map((entry) => entry[1]);
}

function extractRule(selector: string): string {
  const start = liquidGlassCss.indexOf(selector);
  if (start < 0) throw new Error(`Missing Liquid Glass selector: ${selector}`);
  const open = liquidGlassCss.indexOf("{", start);
  let depth = 1;
  for (let index = open + 1; index < liquidGlassCss.length; index += 1) {
    if (liquidGlassCss[index] === "{") depth += 1;
    if (liquidGlassCss[index] === "}") depth -= 1;
    if (depth === 0) return liquidGlassCss.slice(start, index + 1);
  }
  throw new Error(`Unclosed Liquid Glass selector: ${selector}`);
}

function extractMediaBlock(mediaFeature: string): string {
  const start = liquidGlassCss.indexOf(`@media (${mediaFeature})`);
  if (start < 0) throw new Error(`Missing Liquid Glass media query: ${mediaFeature}`);
  const nextMedia = liquidGlassCss.indexOf("@media (", start + 1);
  return liquidGlassCss.slice(start, nextMedia < 0 ? liquidGlassCss.length : nextMedia);
}

const functionalGlassTargets = [
  ".header",
  ".left-sidebar-nav",
  ".mobile-nav-bar",
  ".view-header",
  ".modal",
  ".floating-window",
  ".theme-dropdown-popover",
  ".task-context-menu",
  '[role="menu"]',
  '[role="listbox"]',
  ".btn",
  ".input",
  ".select",
  "button:not(:disabled)",
];

describe("Liquid Glass color theme", () => {
  it("keeps the canonical registry, selector metadata, and first-paint validators synchronized", () => {
    const ids = [...CORE_COLOR_THEMES];
    expect(ids.filter((id) => id === "liquid-glass")).toHaveLength(1);
    expect(DASHBOARD_COLOR_THEMES.map((theme) => theme.value)).toEqual(ids);
    expect(DASHBOARD_COLOR_THEMES).toContainEqual({
      value: "liquid-glass",
      label: "Liquid Glass",
      className: "theme-swatch-liquid-glass",
    });
    expect(extractValidThemes(dashboardIndexHtml)).toEqual(ids);
    expect(extractValidThemes(desktopIndexHtml)).toEqual(ids);
  });

  it("provides four concrete swatch samples in dark and light modes", () => {
    const dark = themeSelectorCss.match(/\.theme-swatch-liquid-glass\s*\{([\s\S]*?)\}/)?.[1] ?? "";
    const light = themeSelectorCss.match(/\[data-theme="light"\] \.theme-swatch-liquid-glass\s*\{([\s\S]*?)\}/)?.[1] ?? "";

    for (const block of [dark, light]) {
      for (const sample of [1, 2, 3, 4]) expect(block).toContain(`--swatch-sample-${sample}: oklch(`);
      expect(block).not.toContain("var(--");
    }
    expect(dark).not.toBe(light);
  });

  it("defines distinct readable dark and light token ramps", () => {
    const dark = extractRule('[data-color-theme="liquid-glass"]');
    const light = extractRule('[data-color-theme="liquid-glass"][data-theme="light"]');

    for (const block of [dark, light]) {
      for (const token of [
        "--bg:", "--surface:", "--surface-solid:", "--card:", "--card-hover:",
        "--border:", "--text:", "--text-muted:", "--todo:", "--in-progress:",
        "--in-review:", "--triage:", "--done:", "--color-success:",
        "--color-warning:", "--color-error:", "--accent:", "--accent-text:",
      ]) {
        expect(block).toContain(token);
      }
    }
    expect(dark).not.toBe(light);
    expect(dark).toContain("--font-primary: -apple-system");
    expect(dark).toContain("--radius-xl:");
    expect(dark).toContain("--transition-normal:");
  });

  it("uses regular glass only on functional surfaces and standard material on content", () => {
    const content = extractRule('[data-color-theme="liquid-glass"] :is(.column, .card)');
    const functional = extractRule('[data-color-theme="liquid-glass"] :is(\n  .header,');
    const controls = extractRule('[data-color-theme="liquid-glass"] :is(.btn, .input, .select, button:not(:disabled))');

    expect(content).toContain("background: var(--card)");
    expect(content).toContain("backdrop-filter: none");
    expect(content).toContain("-webkit-backdrop-filter: none");
    for (const surface of functionalGlassTargets.slice(0, 10)) {
      expect(functional).toContain(surface);
    }
    expect(functional).toContain("backdrop-filter: blur(var(--space-lg))");
    expect(functional).toContain("-webkit-backdrop-filter: blur(var(--space-lg))");
    expect(functional).toContain("color-mix(in oklch");
    expect(controls).toContain("backdrop-filter: blur(var(--space-sm))");
    expect(controls).toContain("transition:");
  });

  it("retains transparent click-through overlays and restores mobile modal paint", () => {
    expect(liquidGlassCss).toContain('.modal-overlay:not(.floating-window-overlay--modal)');
    expect(liquidGlassCss).toContain('.floating-window-overlay:not(.floating-window-overlay--modal)');
    expect(liquidGlassCss).toMatch(/\.floating-window-overlay:not\([\s\S]*?background: transparent;[\s\S]*?backdrop-filter: none;/);
    expect(liquidGlassCss).toContain("@media (max-width: 768px)");
    expect(liquidGlassCss).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.modal \{[\s\S]*?border: thin solid var\(--border\);/);
  });

  it.each([
    ["prefers-reduced-motion: reduce", "transition: none"],
    ["prefers-reduced-transparency: reduce", "background: var(--surface-solid)"],
    ["prefers-contrast: more", "border-color: var(--text)"],
    ["forced-colors: active", "forced-color-adjust: auto"],
  ])("provides the %s accessibility fallback", (mediaFeature, behavior) => {
    const block = extractMediaBlock(mediaFeature);
    expect(block).toContain(behavior);
    expect(block).toContain('[data-color-theme="liquid-glass"]');
  });

  it.each(["prefers-reduced-transparency: reduce", "forced-colors: active"])(
    "neutralizes every functional glass target for %s",
    (mediaFeature) => {
      const block = extractMediaBlock(mediaFeature);
      for (const target of functionalGlassTargets) expect(block).toContain(target);
      expect(block).toContain("backdrop-filter: none");
      expect(block).toContain("-webkit-backdrop-filter: none");
    },
  );

  it("uses local CSS materials without network resources or raw alpha colors", () => {
    expect(liquidGlassCss).not.toMatch(/url\s*\(/i);
    expect(liquidGlassCss).not.toMatch(/rgba?\s*\(/i);
    expect(liquidGlassCss).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    const pixelValues = [...liquidGlassCss.matchAll(/(?<![\w-])(\d+(?:\.\d+)?)px\b/g)].map((match) => match[0]);
    expect(pixelValues).toEqual(["768px"]);
  });
});
