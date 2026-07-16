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
const roadmapPluginBundledPath = bundlePath.replace(
  "dist/bin.js",
  "dist/plugins/fusion-plugin-roadmap/bundled.js",
);
/*
FNXC:CliTests 2026-07-15-16:50:
hasBuiltDashboardAssets now requires reports/cli-printing-press/whatsapp-chat
bundled plugins plus the compound-engineering skill path (main FN-7956 bundles).
*/
const reportsPluginBundledPath = bundlePath.replace(
  "dist/bin.js",
  "dist/plugins/fusion-plugin-reports/bundled.js",
);
const cliPrintingPressPluginBundledPath = bundlePath.replace(
  "dist/bin.js",
  "dist/plugins/fusion-plugin-cli-printing-press/bundled.js",
);
const whatsappChatPluginBundledPath = bundlePath.replace(
  "dist/bin.js",
  "dist/plugins/fusion-plugin-whatsapp-chat/bundled.js",
);
const compoundEngineeringSkillPath = bundlePath.replace(
  "dist/bin.js",
  "dist/plugins/fusion-plugin-compound-engineering/skills/ce-brainstorm/SKILL.md",
);

function addAllRequiredAssets(): void {
  state.existingPaths.add(bundlePath);
  state.existingPaths.add(clientIndexPath);
  state.existingPaths.add(cursorPluginManifestPath);
  state.existingPaths.add(roadmapPluginBundledPath);
  state.existingPaths.add(reportsPluginBundledPath);
  state.existingPaths.add(cliPrintingPressPluginBundledPath);
  state.existingPaths.add(whatsappChatPluginBundledPath);
  state.existingPaths.add(compoundEngineeringSkillPath);
  state.existingPaths.add(openclawMcpSchemaServerPath);
  state.existingPaths.add(droidPluginMcpServerPath);
}

describe("hasBuiltDashboardAssets", () => {
  beforeEach(() => {
    state.existingPaths.clear();
    state.indexHtml = "<html><body><script src=\"assets/app.js\"></script></body></html>";
  });

  it("returns false when openclaw mcp-schema-server.cjs is missing", () => {
    addAllRequiredAssets();
    state.existingPaths.delete(openclawMcpSchemaServerPath);

    expect(hasBuiltDashboardAssets()).toBe(false);
  });

  it("returns false when droid mcp-schema-server.cjs is missing", () => {
    addAllRequiredAssets();
    state.existingPaths.delete(droidPluginMcpServerPath);

    expect(hasBuiltDashboardAssets()).toBe(false);
  });

  it("returns true when all required assets exist and dashboard stub marker is absent", () => {
    addAllRequiredAssets();

    expect(hasBuiltDashboardAssets()).toBe(true);
  });

  it("returns false when dashboard client index contains stub marker", () => {
    addAllRequiredAssets();
    state.indexHtml = dashboardClientStubMarker;

    expect(hasBuiltDashboardAssets()).toBe(false);
  });
});
