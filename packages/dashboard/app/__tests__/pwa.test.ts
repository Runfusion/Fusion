import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("PWA configuration", () => {
  it("manifest defines required PWA fields and icon sizes", () => {
    const manifestPath = resolve(__dirname, "../public/manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      name?: string;
      short_name?: string;
      start_url?: string;
      display?: string;
      icons?: Array<{ sizes?: string }>;
    };

    expect(manifest.name).toBe("Fusion");
    expect(manifest.short_name).toBe("Fusion");
    expect(manifest.start_url).toBe("/");
    expect(manifest.display).toBe("standalone");
    expect(Array.isArray(manifest.icons)).toBe(true);
    expect(manifest.icons?.some((icon) => icon.sizes?.includes("192"))).toBe(true);
    expect(manifest.icons?.some((icon) => icon.sizes?.includes("512"))).toBe(true);
  });

  it("index.html includes required PWA meta tags", () => {
    const indexHtml = readFileSync(resolve(__dirname, "../index.html"), "utf8");

    expect(indexHtml).toContain('<link rel="manifest"');
    expect(indexHtml).toContain("apple-mobile-web-app-capable");
  });

  it("viewport meta includes viewport-fit=cover for safe-area support", () => {
    const indexHtml = readFileSync(resolve(__dirname, "../index.html"), "utf8");

    expect(indexHtml).toMatch(/<meta\s+name="viewport"[^>]*content="[^"]*viewport-fit=cover[^"]*"/i);
  });

  it("CSS includes display-mode: standalone rule with safe-area-inset-bottom for PWA home bar spacing", () => {
    const cssContent = readFileSync(resolve(__dirname, "../styles.css"), "utf8");

    expect(cssContent).toMatch(/@media\s*\(\s*display-mode:\s*standalone\s*\)/);
    expect(cssContent).toMatch(/@media\s*\(\s*display-mode:\s*standalone\s*\)\s*\{[^}]*#root\s*\{[^}]*env\(safe-area-inset-bottom,\s*0px\)/);
  });

  it("CSS includes --standalone-bottom-gap token with 8px value in standalone mode", () => {
    const cssContent = readFileSync(resolve(__dirname, "../styles.css"), "utf8");

    // Token definition in :root
    expect(cssContent).toContain("--standalone-bottom-gap: 0px");
    // Token override in standalone mode sets 8px gap
    expect(cssContent).toMatch(/--standalone-bottom-gap:\s*8px/);
  });

  it("CSS uses additive bottom spacing in standalone mode (safe-area + gap)", () => {
    const cssContent = readFileSync(resolve(__dirname, "../styles.css"), "utf8");

    // #root should use var(--standalone-bottom-gap) in a calc expression for additive spacing
    expect(cssContent).toContain("var(--standalone-bottom-gap))");
  });

  it("service worker contains lifecycle handlers and versioned cache name", () => {
    const swSource = readFileSync(resolve(__dirname, "../public/sw.js"), "utf8");

    expect(swSource).toContain('addEventListener("install"');
    expect(swSource).toContain('addEventListener("fetch"');
    expect(swSource).toContain('addEventListener("activate"');
    expect(swSource).toMatch(/fusion-cache-v\d+/);
  });
});
