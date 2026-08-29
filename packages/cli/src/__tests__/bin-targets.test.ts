import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import fg from "fast-glob";
import { parse } from "yaml";

const cliRoot = join(__dirname, "..", "..");
const workspaceRoot = join(cliRoot, "..", "..");

type PackageManifest = {
  name?: string;
  bin?: string | Record<string, string>;
};

type WorkspacePackage = {
  dir: string;
  manifestPath: string;
  manifest: PackageManifest;
};

function loadWorkspacePatterns(): string[] {
  const workspaceManifestPath = join(workspaceRoot, "pnpm-workspace.yaml");
  const workspaceManifest = parse(readFileSync(workspaceManifestPath, "utf-8")) as {
    packages?: string[];
  };
  return workspaceManifest.packages ?? [];
}

function listWorkspacePackages(): WorkspacePackage[] {
  const packageJsonPaths = fg
    .sync(loadWorkspacePatterns().map((pattern) => `${pattern}/package.json`), {
      cwd: workspaceRoot,
      absolute: true,
      onlyFiles: true,
      unique: true,
    })
    .sort((a, b) => a.localeCompare(b));

  return packageJsonPaths.map((manifestPath) => ({
    dir: dirname(manifestPath),
    manifestPath,
    manifest: JSON.parse(readFileSync(manifestPath, "utf-8")) as PackageManifest,
  }));
}

function listBins(manifest: PackageManifest): Array<[string, string]> {
  if (!manifest.bin) return [];
  if (typeof manifest.bin === "string") {
    const fallbackName = manifest.name ?? "<anonymous-bin>";
    return [[fallbackName, manifest.bin]];
  }
  return Object.entries(manifest.bin);
}

describe("workspace bin targets", () => {
  const packagesWithBins = listWorkspacePackages().filter((pkg) => listBins(pkg.manifest).length > 0);

  it("covers all workspace packages that declare bins", () => {
    const packageNames = packagesWithBins.map((pkg) => pkg.manifest.name).sort();
    expect(packageNames).toEqual([
      "@runfusion/fusion",
      "runfusion.ai",
    ]);
  });

  it.each(
    packagesWithBins.flatMap((pkg) =>
      listBins(pkg.manifest).map(([binName, target]) => ({
        packageName: pkg.manifest.name ?? pkg.manifestPath,
        packageDir: pkg.dir,
        binName,
        target,
      })),
    ),
  )(
    '$packageName bin "$binName" points at a committed non-dist file',
    ({ packageDir, target }) => {
      const normalizedTarget = normalize(target).replace(/^\.([/\\])/, "");
      const resolvedTarget = join(packageDir, normalizedTarget);

      expect(normalizedTarget).not.toMatch(/^dist(?:[/\\]|$)/);
      expect(existsSync(resolvedTarget)).toBe(true);
    },
  );
});
