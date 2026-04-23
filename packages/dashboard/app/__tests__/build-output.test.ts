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
  });
});
