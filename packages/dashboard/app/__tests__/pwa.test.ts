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
