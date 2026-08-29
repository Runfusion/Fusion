import { describe, it, expect } from "vitest";
import { pathToFileURL } from "node:url";
import { resolveDesktopBundlePluginDirs } from "../bundled-plugin-dirs.js";

/*
 * FNXC:DesktopRuntime 2026-07-07-12:30:
 * FN-7637: bundled-plugin-dirs.ts's resolveDesktopBundlePluginDirs takes an injectable
 * `resolveSpecifier` (defaulting to import.meta.resolve) purely so unit tests can drive it
 * deterministically without needing the real @fusion-plugin-examples/* packages built/staged
 * in this dev worktree. Asserts the manifest-id -> npm-package-short-name transform and the
 * "walk up two directories from the resolved dist/index.js entry to the package root"
 * derivation that the desktop wiring in local-runtime.ts / local-server.ts depends on.
 */
describe("resolveDesktopBundlePluginDirs", () => {
  it("maps a manifest id to its @fusion-plugin-examples/<short-name> package and walks up to the package root", () => {
    const fakeEntryPath = "/desktop/deploy/node_modules/@fusion-plugin-examples/hermes-runtime/dist/index.js";
    let requestedSpecifier: string | undefined;
    const dirs = resolveDesktopBundlePluginDirs("fusion-plugin-hermes-runtime", (specifier) => {
      requestedSpecifier = specifier;
      return pathToFileURL(fakeEntryPath).href;
    });

    expect(requestedSpecifier).toBe("@fusion-plugin-examples/hermes-runtime");
    expect(dirs).toEqual(["/desktop/deploy/node_modules/@fusion-plugin-examples/hermes-runtime"]);
  });

  it("returns an empty candidate list when the package is not resolvable (e.g. desktop does not bundle it)", () => {
    const dirs = resolveDesktopBundlePluginDirs("fusion-plugin-reports", () => {
      throw new Error("Cannot find package '@fusion-plugin-examples/reports'");
    });

    expect(dirs).toEqual([]);
  });

  it("derives the correct short name for every bundled plugin id shape", () => {
    const seen: string[] = [];
    const resolver = (specifier: string) => {
      seen.push(specifier);
      return pathToFileURL(`/x/node_modules/${specifier}/dist/index.js`).href;
    };

    resolveDesktopBundlePluginDirs("fusion-plugin-dependency-graph", resolver);
    resolveDesktopBundlePluginDirs("fusion-plugin-cli-printing-press", resolver);
    resolveDesktopBundlePluginDirs("fusion-plugin-openclaw-runtime", resolver);

    expect(seen).toEqual([
      "@fusion-plugin-examples/dependency-graph",
      "@fusion-plugin-examples/cli-printing-press",
      "@fusion-plugin-examples/openclaw-runtime",
    ]);
  });

  it("resolves for real using the default import.meta.resolve when the package genuinely is not installed", () => {
    // No injected resolver: exercises the real default (import.meta.resolve). This package is
    // not staged in this dev worktree, so the real resolver throws and this must fail soft to [].
    const dirs = resolveDesktopBundlePluginDirs("fusion-plugin-does-not-exist-in-this-worktree");
    expect(dirs).toEqual([]);
  });
});
