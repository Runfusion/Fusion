import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAllAppCss } from "../test/cssFixture";

function getStandaloneDisplayModeBlock(css: string): string {
  const match = /@media\s*\(\s*display-mode:\s*standalone\s*\)\s*\{/.exec(css);
  expect(match).toBeTruthy();

  const start = match!.index;
  const open = css.indexOf("{", start);
  let depth = 1;
  let i = open + 1;

  while (i < css.length && depth > 0) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") depth--;
    i++;
  }

  return css.slice(start, i);
}

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

  it("CSS includes display-mode: standalone rule with a :root token override only", () => {
    const cssContent = loadAllAppCss();
    const standaloneBlock = getStandaloneDisplayModeBlock(cssContent);

    expect(standaloneBlock).toContain("@media (display-mode: standalone)");
    expect(standaloneBlock).toMatch(/:root\s*\{[\s\S]*?--standalone-bottom-gap:\s*0px/);
    expect(standaloneBlock).not.toContain("#root {");
  });

  it("CSS defines --standalone-bottom-gap token in :root", () => {
    const cssContent = loadAllAppCss();

    // Token defined in :root; standalone mode currently overrides to 0 (no extra gap beyond safe-area).
    expect(cssContent).toContain("--standalone-bottom-gap: 0px");
  });

  it("CSS applies standalone bottom gap via scoped mobile layout rules, not global #root padding", () => {
    const cssContent = loadAllAppCss();

    expect(cssContent).toMatch(/\.project-content--with-mobile-nav\s*\{[^}]*var\(--standalone-bottom-gap\)/);
    expect(cssContent).toMatch(/\.executor-status-bar\s*\{[^}]*var\(--standalone-bottom-gap\)/);
    expect(cssContent).not.toMatch(/#root\s*\{[^}]*var\(--standalone-bottom-gap\)/);
  });

  it("service worker contains lifecycle handlers and versioned cache name", () => {
    const swSource = readFileSync(resolve(__dirname, "../public/sw.js"), "utf8");

    expect(swSource).toContain('addEventListener("install"');
    expect(swSource).toContain('addEventListener("fetch"');
    expect(swSource).toContain('addEventListener("activate"');
    expect(swSource).toMatch(/fusion-cache-v\d+/);
  });

  it("service worker bypasses SSE requests instead of trying to cache them", () => {
    const swSource = readFileSync(resolve(__dirname, "../public/sw.js"), "utf8");

    expect(swSource).toContain('text/event-stream');
    expect(swSource).toContain('url.pathname === "/api/events"');
    expect(swSource).toContain('url.pathname.startsWith("/api/events/")');
    expect(swSource).toContain("if (isEventStreamRequest) {");
    expect(swSource).toContain("return;");
  });

  it("service worker revalidates navigation requests so index.html cannot stay stale", () => {
    const swSource = readFileSync(resolve(__dirname, "../public/sw.js"), "utf8");

    expect(swSource).toContain('request.mode === "navigate"');
    expect(swSource).toContain('request.destination === "document"');
    expect(swSource).toContain('url.pathname === "/index.html"');
    expect(swSource).toContain('[sw] navigation cache put failed');
  });

  it("service worker activates updated code immediately", () => {
    const swSource = readFileSync(resolve(__dirname, "../public/sw.js"), "utf8");

    expect(swSource).toContain("await self.skipWaiting()");
    expect(swSource).toContain("await self.clients.claim()");
  });

  describe("logo assets", () => {
    it("logo.svg uses ring + swoosh geometry matching Header.tsx brand mark", () => {
      const logoSvg = readFileSync(resolve(__dirname, "../public/logo.svg"), "utf8");

      // Must contain the outer ring (circle with r=52, matching Header.tsx header-logo)
      expect(logoSvg).toContain('cx="64"');
      expect(logoSvg).toContain('cy="64"');
      expect(logoSvg).toContain('r="52"');
      expect(logoSvg).toContain('stroke-width="8"');

      // Must contain the swoosh/comet path shape (d attribute from Header.tsx)
      // The path starts with M26 101C... and creates the comet-like swoosh
      expect(logoSvg).toContain('d="M26 101');
      expect(logoSvg).toContain("fill=\"currentColor\"");

      // Must use SVG namespace
      expect(logoSvg).toContain("xmlns=");
    });

    it("logo.svg does not contain retired 4-circle glyph pattern", () => {
      const logoSvg = readFileSync(resolve(__dirname, "../public/logo.svg"), "utf8");

      // The old 4-circle glyph used circles at (44,44), (84,44), (44,84), (84,84) with r=20
      // Verify these specific circle positions are NOT present
      expect(logoSvg).not.toContain("cx=\"44\"");
      expect(logoSvg).not.toContain("cy=\"44\"");
      expect(logoSvg).not.toContain("r=\"20\"");
    });

    it("PWA icon files exist with correct sizes", async () => {
      const fs = await import("node:fs");

      const icon192Path = resolve(__dirname, "../public/icons/icon-192.png");
      const icon512Path = resolve(__dirname, "../public/icons/icon-512.png");

      expect(fs.existsSync(icon192Path)).toBe(true);
      expect(fs.existsSync(icon512Path)).toBe(true);

      // Verify PNG files have reasonable size (not empty)
      const stats192 = fs.statSync(icon192Path);
      const stats512 = fs.statSync(icon512Path);

      expect(stats192.size).toBeGreaterThan(100);
      expect(stats512.size).toBeGreaterThan(100);
    });
  });
});
