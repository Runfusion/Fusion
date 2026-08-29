import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  VIEW_SOURCE_MAP,
  loadViewChunkManifest,
  resetViewChunkManifestCache,
} from "../view-chunk-manifest";

function makeClientDir(name: string): string {
  return join(tmpdir(), `fn-4782-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

afterEach(() => {
  resetViewChunkManifestCache();
});

describe("view chunk manifest", () => {
  it("keeps Command Center mapped with css assets for Vite runtime in-app navigation", () => {
    const clientDir = makeClientDir("command-center-runtime");
    mkdirSync(join(clientDir, ".vite"), { recursive: true });
    writeFileSync(
      join(clientDir, ".vite", "manifest.json"),
      JSON.stringify({
        [VIEW_SOURCE_MAP["command-center"]]: {
          file: "assets/CommandCenter-runtime.js",
          css: ["assets/CommandCenter-runtime.css"],
        },
      }),
    );

    // FNXC:CommandCenterStyling 2026-06-19-10:01: Vite's __vitePreload runtime consumes the dynamic entry's css array when the user navigates to Command Center inside an already-loaded dashboard. This assertion keeps that in-app navigation surface distinct from the served-index persisted-view preload path.
    expect(VIEW_SOURCE_MAP["command-center"]).toBe("components/command-center/CommandCenter.tsx");
    expect(loadViewChunkManifest(clientDir)["command-center"]).toEqual({
      file: "/assets/CommandCenter-runtime.js",
      css: ["/assets/CommandCenter-runtime.css"],
    });

    rmSync(clientDir, { recursive: true, force: true });
  });

  it("resolves hashed chunk paths and css assets", () => {
    const clientDir = makeClientDir("resolve");
    mkdirSync(join(clientDir, ".vite"), { recursive: true });
    writeFileSync(
      join(clientDir, ".vite", "manifest.json"),
      JSON.stringify({
        [VIEW_SOURCE_MAP.agents]: { file: "assets/AgentsView-abc123.js" },
        [VIEW_SOURCE_MAP.chat]: { file: "assets/ChatView-def456.js", css: ["assets/ChatView-def456.css"] },
        [VIEW_SOURCE_MAP["command-center"]]: {
          file: "assets/CommandCenter-abc123.js",
          css: ["assets/CommandCenter-abc123.css"],
        },
        [VIEW_SOURCE_MAP.reliability]: {
          file: "assets/ReliabilityView-ghi789.js",
          css: ["assets/ReliabilityView-ghi789.css"],
        },
      }),
    );

    const map = loadViewChunkManifest(clientDir);
    expect(map.agents).toEqual({ file: "/assets/AgentsView-abc123.js", css: [] });
    expect(map.chat).toEqual({ file: "/assets/ChatView-def456.js", css: ["/assets/ChatView-def456.css"] });
    expect(map["command-center"]).toEqual({
      file: "/assets/CommandCenter-abc123.js",
      css: ["/assets/CommandCenter-abc123.css"],
    });
    expect(map.reliability).toEqual({
      file: "/assets/ReliabilityView-ghi789.js",
      css: ["/assets/ReliabilityView-ghi789.css"],
    });

    rmSync(clientDir, { recursive: true, force: true });
  });

  it("returns empty map when manifest file is missing", () => {
    const clientDir = makeClientDir("missing");
    mkdirSync(clientDir, { recursive: true });

    const map = loadViewChunkManifest(clientDir);
    expect(map).toEqual({});

    rmSync(clientDir, { recursive: true, force: true });
  });

  it("returns partial map when source entry is absent", () => {
    const clientDir = makeClientDir("partial");
    mkdirSync(join(clientDir, ".vite"), { recursive: true });
    writeFileSync(
      join(clientDir, ".vite", "manifest.json"),
      JSON.stringify({
        [VIEW_SOURCE_MAP.agents]: { file: "assets/AgentsView-abc123.js" },
      }),
    );

    const map = loadViewChunkManifest(clientDir);
    expect(map.agents).toEqual({ file: "/assets/AgentsView-abc123.js", css: [] });
    expect(map.chat).toBeUndefined();

    rmSync(clientDir, { recursive: true, force: true });
  });

  it("cache is invalidated by reset", () => {
    const clientDir = makeClientDir("cache");
    mkdirSync(join(clientDir, ".vite"), { recursive: true });
    const manifestPath = join(clientDir, ".vite", "manifest.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        [VIEW_SOURCE_MAP.agents]: { file: "assets/AgentsView-old.js" },
      }),
    );

    const first = loadViewChunkManifest(clientDir);
    expect(first.agents).toEqual({ file: "/assets/AgentsView-old.js", css: [] });

    resetViewChunkManifestCache();
    writeFileSync(
      manifestPath,
      JSON.stringify({
        [VIEW_SOURCE_MAP.agents]: { file: "assets/AgentsView-new.js" },
      }),
    );
    const refreshed = loadViewChunkManifest(clientDir);
    expect(refreshed.agents).toEqual({ file: "/assets/AgentsView-new.js", css: [] });

    rmSync(clientDir, { recursive: true, force: true });
  });

  it("cache auto-invalidates when manifest mtime changes", () => {
    const clientDir = makeClientDir("mtime");
    mkdirSync(join(clientDir, ".vite"), { recursive: true });
    const manifestPath = join(clientDir, ".vite", "manifest.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        [VIEW_SOURCE_MAP.agents]: { file: "assets/AgentsView-old.js" },
      }),
    );

    const first = loadViewChunkManifest(clientDir);
    expect(first.agents).toEqual({ file: "/assets/AgentsView-old.js", css: [] });

    writeFileSync(
      manifestPath,
      JSON.stringify({
        [VIEW_SOURCE_MAP.agents]: { file: "assets/AgentsView-new.js" },
      }),
    );
    // Force a distinctly newer mtime so the cache key changes even on
    // coarse-grained filesystems.
    const future = new Date(Date.now() + 5_000);
    utimesSync(manifestPath, future, future);

    const refreshed = loadViewChunkManifest(clientDir);
    expect(refreshed.agents).toEqual({ file: "/assets/AgentsView-new.js", css: [] });

    rmSync(clientDir, { recursive: true, force: true });
  });
});
