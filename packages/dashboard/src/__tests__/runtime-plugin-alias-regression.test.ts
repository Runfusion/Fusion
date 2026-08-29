import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

describe("FN-3298 regression: dashboard vitest runtime plugins resolve from source", () => {
  it("aliases hermes/openclaw/paperclip runtime plugin imports to src entrypoints", () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const vitestConfigPath = join(testDir, "..", "..", "vitest.config.ts");
    const config = readFileSync(vitestConfigPath, "utf8");

    expect(config).toContain('"@fusion-plugin-examples/hermes-runtime": resolve(');
    expect(config).toContain('"../../plugins/fusion-plugin-hermes-runtime/src/index.ts"');

    expect(config).toContain('"@fusion-plugin-examples/openclaw-runtime": resolve(');
    expect(config).toContain('"../../plugins/fusion-plugin-openclaw-runtime/src/index.ts"');

    expect(config).toContain('"@fusion-plugin-examples/paperclip-runtime": resolve(');
    expect(config).toContain('"../../plugins/fusion-plugin-paperclip-runtime/src/index.ts"');

    expect(config).not.toContain('fusion-plugin-hermes-runtime/dist/index.js');
    expect(config).not.toContain('fusion-plugin-openclaw-runtime/dist/index.js');
    expect(config).not.toContain('fusion-plugin-paperclip-runtime/dist/index.js');
  });

  // FN-3888/FN-6111 regression: bundled dashboard views must not depend on
  // plugins/*/dist/, which goes stale when plugin source is edited without a
  // manual rebuild and surfaces in the UI as "Bundled plugin view unavailable".
  it("aliases bundled dashboard view plugin imports to src in vite and vitest configs", () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const dashboardDir = join(testDir, "..", "..");

    for (const configFile of ["vite.config.ts", "vitest.config.ts"]) {
      const config = readFileSync(join(dashboardDir, configFile), "utf8");
      expect(
        config,
        `${configFile} must alias the dependency-graph dashboard-view to src`,
      ).toContain('"@fusion-plugin-examples/dependency-graph/dashboard-view": resolve(');
      expect(config).toContain(
        '"../../plugins/fusion-plugin-dependency-graph/src/dashboard-view.tsx"',
      );
      expect(config).not.toContain("fusion-plugin-dependency-graph/dist/");
      expect(
        config,
        `${configFile} must alias the compound-engineering dashboard-view to src`,
      ).toContain('"@fusion-plugin-examples/compound-engineering/dashboard-view": resolve(');
      expect(config).toContain(
        '"../../plugins/fusion-plugin-compound-engineering/src/dashboard-view.tsx"',
      );
      expect(config).toContain('"@fusion-plugin-examples/compound-engineering": resolve(');
      expect(config).toContain(
        '"../../plugins/fusion-plugin-compound-engineering/src/index.ts"',
      );
      expect(config).not.toContain("fusion-plugin-compound-engineering/dist/");
      expect(
        config,
        `${configFile} must alias the linear-import dashboard-view to src`,
      ).toContain('"@fusion-plugin-examples/linear-import/dashboard-view": resolve(');
      expect(config).toContain(
        '"../../plugins/fusion-plugin-linear-import/src/dashboard-view.tsx"',
      );
      expect(config).toContain('"@fusion-plugin-examples/linear-import": resolve(');
      expect(config).toContain(
        '"../../plugins/fusion-plugin-linear-import/src/index.ts"',
      );
      expect(config).not.toContain("fusion-plugin-linear-import/dist/");
    }
  });
});
