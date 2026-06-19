import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BUNDLED_PLUGIN_IDS } from "../bundled-plugin-install.js";
import { findStaleBundledPlugins } from "../bundled-plugin-freshness.js";
import { ALL_STAGED_BUNDLED_IDS } from "../staged-bundled-plugin-ids.js";

const older = new Date("2026-01-01T00:00:00.000Z");
const newer = new Date("2026-01-01T00:01:00.000Z");

describe("bundled plugin build freshness", () => {
  let tempRoot: string | null = null;

  afterEach(() => {
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = null;
    }
  });

  function makeTempPluginsRoot(): string {
    tempRoot = mkdtempSync(join(tmpdir(), "bundled-plugin-freshness-"));
    return tempRoot;
  }

  function writePluginFile(pluginsRoot: string, pluginId: string, relativePath: string, content = "// test fixture\n") {
    const fullPath = join(pluginsRoot, pluginId, relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
    return fullPath;
  }

  it("reports stale compiled dist while allowing fresh and dist-absent plugins", () => {
    const pluginsRoot = makeTempPluginsRoot();

    const staleSrc = writePluginFile(pluginsRoot, "fixture-stale", "src/index.ts");
    const staleDist = writePluginFile(pluginsRoot, "fixture-stale", "dist/index.js");
    utimesSync(staleDist, older, older);
    utimesSync(staleSrc, newer, newer);

    const freshSrc = writePluginFile(pluginsRoot, "fixture-fresh", "src/index.ts");
    const freshDist = writePluginFile(pluginsRoot, "fixture-fresh", "dist/index.js");
    utimesSync(freshSrc, older, older);
    utimesSync(freshDist, newer, newer);

    writePluginFile(pluginsRoot, "fixture-dist-absent", "src/index.ts");

    const stale = findStaleBundledPlugins(["fixture-stale", "fixture-fresh", "fixture-dist-absent"], {
      pluginsRoot,
    });

    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({ id: "fixture-stale" });
    expect(stale[0]?.reason).toContain("run pnpm build");
  });

  it("keeps the live staged bundled-plugin set fresh after build", () => {
    expect(findStaleBundledPlugins(ALL_STAGED_BUNDLED_IDS)).toEqual([]);
  });

  it("keeps the auto-install list covered by the staged bundled-plugin set", () => {
    const staged = new Set<string>(ALL_STAGED_BUNDLED_IDS);
    const missingFromStagedSet = BUNDLED_PLUGIN_IDS.filter((id) => !staged.has(id));

    expect(missingFromStagedSet).toEqual([]);

    /*
     * FNXC:BundledPlugins 2026-06-17-22:06:
     * The staged set intentionally remains a superset today: droid/acp runtimes are shipped for explicit runtime selection but are not part of the default auto-install list. Use subset coverage, not equality, until product requirements say those runtimes should auto-install.
     */
    expect(new Set(BUNDLED_PLUGIN_IDS)).not.toEqual(staged);
    expect(ALL_STAGED_BUNDLED_IDS).toEqual(expect.arrayContaining(["fusion-plugin-droid-runtime", "fusion-plugin-acp-runtime"]));
  });
});
