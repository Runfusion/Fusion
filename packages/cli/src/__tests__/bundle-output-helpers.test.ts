import { beforeEach, describe, expect, it, vi } from "vitest";

const state = {
  existingPaths: new Set<string>(),
  indexHtml: "",
};

vi.mock("node:fs", () => ({
  existsSync: (path: string) => state.existingPaths.has(path),
  readFileSync: () => state.indexHtml,
  execFileSync: vi.fn(),
  execSync: vi.fn(),
}));

import {
  bundlePath,
  clientIndexPath,
  dashboardClientStubMarker,
  droidPluginMcpServerPath,
  hasBuiltDashboardAssets,
  openclawMcpSchemaServerPath,
} from "./bundle-output-helpers";

const cursorPluginManifestPath = bundlePath.replace(
  "dist/bin.js",
  "dist/plugins/fusion-plugin-cursor-runtime/manifest.json",
);

describe("hasBuiltDashboardAssets", () => {
  beforeEach(() => {
    state.existingPaths.clear();
    state.indexHtml = "<html><body><script src=\"assets/app.js\"></script></body></html>";
  });

  it("returns false when openclaw mcp-schema-server.cjs is missing", () => {
    state.existingPaths.add(bundlePath);
    state.existingPaths.add(clientIndexPath);
    state.existingPaths.add(cursorPluginManifestPath);

    expect(hasBuiltDashboardAssets()).toBe(false);
  });

  it("returns false when droid mcp-schema-server.cjs is missing", () => {
    state.existingPaths.add(bundlePath);
    state.existingPaths.add(clientIndexPath);
    state.existingPaths.add(cursorPluginManifestPath);
    state.existingPaths.add(openclawMcpSchemaServerPath);

    expect(hasBuiltDashboardAssets()).toBe(false);
  });

  it("returns true when all required assets exist and dashboard stub marker is absent", () => {
    state.existingPaths.add(bundlePath);
    state.existingPaths.add(clientIndexPath);
    state.existingPaths.add(cursorPluginManifestPath);
    state.existingPaths.add(openclawMcpSchemaServerPath);
    state.existingPaths.add(droidPluginMcpServerPath);

    expect(hasBuiltDashboardAssets()).toBe(true);
  });

  it("returns false when dashboard client index contains stub marker", () => {
    state.existingPaths.add(bundlePath);
    state.existingPaths.add(clientIndexPath);
    state.existingPaths.add(cursorPluginManifestPath);
    state.existingPaths.add(openclawMcpSchemaServerPath);
    state.existingPaths.add(droidPluginMcpServerPath);
    state.indexHtml = dashboardClientStubMarker;

    expect(hasBuiltDashboardAssets()).toBe(false);
  });
});
