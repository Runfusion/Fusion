import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync as realReadFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const manifestOverrides = vi.hoisted(() => new Map<string, string>());

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync(path: Parameters<typeof actual.existsSync>[0]) {
      const pathString = String(path);
      if (manifestOverrides.has(pathString)) {
        return true;
      }
      if (pathString.endsWith("/package.json") && !pathString.includes("fn-scaffold-version-")) {
        return false;
      }
      return actual.existsSync(path);
    },
    readFileSync(path: Parameters<typeof actual.readFileSync>[0], ...args: Parameters<typeof actual.readFileSync>[1][]) {
      const pathString = String(path);
      const manifest = manifestOverrides.get(pathString);
      if (manifest !== undefined) {
        return manifest;
      }
      return actual.readFileSync(path, ...args);
    },
  };
});

import { runPluginNew } from "../commands/plugin-scaffold.js";

const scaffoldModuleDir = dirname(fileURLToPath(new URL("../commands/plugin-scaffold.ts", import.meta.url)));
const tmpBase = join(tmpdir(), `fn-scaffold-version-${Date.now()}-${Math.random().toString(36).slice(2)}`);

function ancestorManifestPath(index: number): string {
  let directory = scaffoldModuleDir;
  for (let current = 0; current < index; current += 1) {
    directory = resolve(directory, "..");
  }
  return join(directory, "package.json");
}

async function scaffoldVersion(outputName: string): Promise<string> {
  const output = join(tmpBase, outputName);
  await runPluginNew("version-fixture", { output });
  const manifest = JSON.parse(realReadFileSync(join(output, "package.json"), "utf-8")) as {
    devDependencies: Record<string, string>;
  };
  return manifest.devDependencies["@runfusion/fusion"];
}

describe("plugin scaffold Fusion caret version characterization", () => {
  beforeEach(() => {
    manifestOverrides.clear();
    mkdirSync(tmpBase, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it("stops before the ninth ancestor and reaches the eighth", async () => {
    manifestOverrides.set(
      ancestorManifestPath(8),
      JSON.stringify({ name: "@runfusion/fusion", version: "9.9.9" }),
    );
    expect(await scaffoldVersion("ninth-ancestor")).toBe("^0.39.0");

    manifestOverrides.clear();
    manifestOverrides.set(
      ancestorManifestPath(7),
      JSON.stringify({ name: "@runfusion/fusion", version: "9.9.9" }),
    );
    expect(await scaffoldVersion("eighth-ancestor")).toBe("^9.9.9");
  });

  it("falls back when no matching Fusion manifest exists", async () => {
    manifestOverrides.set(
      ancestorManifestPath(2),
      JSON.stringify({ name: "@fusion/dashboard", version: "1.0.0" }),
    );

    const version = await scaffoldVersion("foreign-manifest");
    expect(version).toBe("^0.39.0");
    expect(version).not.toBe("^1.0.0");
  });
});
