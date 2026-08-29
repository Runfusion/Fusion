import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import {
  dashboardClientAssetsDir,
  dashboardClientDistDir,
  ensureDashboardClientBuild,
} from "./build-output-setup";

describe("mobile build output chunking", () => {
  beforeAll(() => {
    // Clean worktrees and CI often start without dist/client; build explicitly so
    // chunking assertions always execute instead of being gated by ambient artifacts.
    ensureDashboardClientBuild();
  }, 180_000);

  test("creates vendor chunk files for core dependencies", () => {
    const files = readdirSync(dashboardClientAssetsDir);
    const jsFiles = files.filter((file) => file.endsWith(".js"));

    expect(jsFiles.length).toBeGreaterThan(2);
    expect(jsFiles.some((file) => /^vendor-react-[A-Za-z0-9_-]+\.js$/.test(file))).toBe(true);
    expect(jsFiles.some((file) => /^vendor-xterm-[A-Za-z0-9_-]+\.js$/.test(file))).toBe(true);
  });

  test("index.html references chunked asset scripts", () => {
    const indexHtml = readFileSync(resolve(dashboardClientDistDir, "index.html"), "utf8");

    expect(indexHtml).toContain("<script");
    expect(indexHtml).toMatch(/assets\/.+-[A-Za-z0-9_-]+\.js/);
    expect(indexHtml).toMatch(/assets\/vendor-react-[A-Za-z0-9_-]+\.js/);
    expect(indexHtml).toMatch(/assets\/vendor-xterm-[A-Za-z0-9_-]+\.js/);
  });

  test("ships Nerd Font symbol fallback asset and preloads it in dist index", () => {
    const bundledFontPath = resolve(
      dashboardClientDistDir,
      "fonts",
      "SymbolsNerdFontMono-Regular.ttf",
    );
    const indexHtml = readFileSync(resolve(dashboardClientDistDir, "index.html"), "utf8");

    expect(() => readFileSync(bundledFontPath)).not.toThrow();
    expect(indexHtml).toContain('/fonts/SymbolsNerdFontMono-Regular.ttf');
    expect(indexHtml).toContain('rel="preload"');
  });

  test("keeps theme-data stylesheet link after all other stylesheet links in head", () => {
    const indexHtml = readFileSync(resolve(dashboardClientDistDir, "index.html"), "utf8");
    const head = indexHtml.match(/<head>[\s\S]*?<\/head>/i)?.[0] ?? "";
    const themeLinkMatch = head.match(/<link[^>]*id=["']theme-data["'][^>]*rel=["']stylesheet["'][^>]*>/i)
      ?? head.match(/<link[^>]*rel=["']stylesheet["'][^>]*id=["']theme-data["'][^>]*>/i);

    expect(themeLinkMatch).toBeTruthy();
    const themeLink = themeLinkMatch![0];
    const themeIndex = head.indexOf(themeLink);

    const stylesheetRegex = /<link[^>]*rel=["']stylesheet["'][^>]*>/gi;
    const otherStylesheetIndexes: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = stylesheetRegex.exec(head)) !== null) {
      if (!m[0].includes('id="theme-data"') && !m[0].includes("id='theme-data'")) {
        otherStylesheetIndexes.push(m.index);
      }
    }

    const lastOtherStylesheetIndex = otherStylesheetIndexes.length === 0 ? -1 : Math.max(...otherStylesheetIndexes);
    expect(themeIndex).toBeGreaterThan(lastOtherStylesheetIndex);
  });
});
