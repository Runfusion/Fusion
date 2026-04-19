// @vitest-environment node

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectDevServerScripts } from "../dev-server-detect.js";

function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

describe("detectDevServerScripts", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "fn-dev-detect-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("detects dev script in root package.json", async () => {
    writeJson(path.join(tempDir, "package.json"), {
      scripts: { dev: "vite" },
      devDependencies: { vite: "^6.0.0" },
      private: true,
    });

    const result = await detectDevServerScripts(tempDir);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      name: "dev",
      command: "vite",
      source: "root",
    });
  });

  it("detects multiple matching scripts", async () => {
    writeJson(path.join(tempDir, "package.json"), {
      scripts: {
        dev: "vite",
        start: "next dev",
        preview: "vite preview",
      },
      devDependencies: { vite: "^6.0.0" },
      private: true,
    });

    const result = await detectDevServerScripts(tempDir);
    expect(result.candidates.map((candidate) => candidate.name).sort()).toEqual(["dev", "preview", "start"]);
  });

  it("returns empty candidates when no matching scripts", async () => {
    writeJson(path.join(tempDir, "package.json"), {
      scripts: { test: "vitest", build: "vite build" },
    });

    const result = await detectDevServerScripts(tempDir);
    expect(result.candidates).toEqual([]);
  });

  it("returns empty candidates when package.json does not exist", async () => {
    const result = await detectDevServerScripts(tempDir);
    expect(result.candidates).toEqual([]);
  });

  it("returns empty candidates when package.json has no scripts field", async () => {
    writeJson(path.join(tempDir, "package.json"), { name: "demo" });

    const result = await detectDevServerScripts(tempDir);
    expect(result.candidates).toEqual([]);
  });

  it("monorepo detection scans packages/*/package.json", async () => {
    writeJson(path.join(tempDir, "package.json"), { name: "root" });
    const pkgDir = path.join(tempDir, "packages", "web");
    mkdirSync(pkgDir, { recursive: true });
    writeJson(path.join(pkgDir, "package.json"), {
      name: "@demo/web",
      scripts: { dev: "vite" },
      devDependencies: { vite: "^6.0.0" },
      private: true,
    });

    const result = await detectDevServerScripts(tempDir);
    expect(result.candidates).toContainEqual(
      expect.objectContaining({
        name: "dev",
        source: "packages/web",
      }),
    );
  });

  it("monorepo detection scans apps/*/package.json", async () => {
    writeJson(path.join(tempDir, "package.json"), { name: "root" });
    const appDir = path.join(tempDir, "apps", "client");
    mkdirSync(appDir, { recursive: true });
    writeJson(path.join(appDir, "package.json"), {
      name: "client",
      scripts: { dev: "vite" },
      devDependencies: { vite: "^6.0.0" },
      private: true,
    });

    const result = await detectDevServerScripts(tempDir);
    expect(result.candidates).toContainEqual(
      expect.objectContaining({
        name: "dev",
        source: "apps/client",
      }),
    );
  });

  it("confidence scoring gives dev higher score than serve", async () => {
    writeJson(path.join(tempDir, "package.json"), {
      scripts: { dev: "vite", serve: "vite preview" },
      devDependencies: { vite: "^6.0.0" },
      private: true,
    });

    const result = await detectDevServerScripts(tempDir);
    const dev = result.candidates.find((candidate) => candidate.name === "dev");
    const serve = result.candidates.find((candidate) => candidate.name === "serve");

    expect(dev).toBeDefined();
    expect(serve).toBeDefined();
    expect((dev?.confidence ?? 0)).toBeGreaterThan(serve?.confidence ?? 0);
  });

  it("framework indicators boost confidence", async () => {
    writeJson(path.join(tempDir, "package.json"), { name: "root" });

    const withFrameworkDir = path.join(tempDir, "apps", "with-framework");
    mkdirSync(withFrameworkDir, { recursive: true });
    writeJson(path.join(withFrameworkDir, "package.json"), {
      scripts: { serve: "vite" },
      devDependencies: { vite: "^6.0.0" },
      private: true,
    });

    const withoutFrameworkDir = path.join(tempDir, "apps", "without-framework");
    mkdirSync(withoutFrameworkDir, { recursive: true });
    writeJson(path.join(withoutFrameworkDir, "package.json"), {
      scripts: { serve: "custom-server" },
      private: true,
    });

    const result = await detectDevServerScripts(tempDir);

    const withFramework = result.candidates.find((candidate) => candidate.source === "apps/with-framework");
    const withoutFramework = result.candidates.find((candidate) => candidate.source === "apps/without-framework");

    expect(withFramework).toBeDefined();
    expect(withoutFramework).toBeDefined();
    expect((withFramework?.confidence ?? 0)).toBeGreaterThan(withoutFramework?.confidence ?? 0);
  });

  it("results are sorted by confidence descending", async () => {
    writeJson(path.join(tempDir, "package.json"), {
      scripts: {
        preview: "vite preview",
        dev: "vite",
        serve: "vite serve",
      },
      devDependencies: { vite: "^6.0.0" },
      private: true,
    });

    const result = await detectDevServerScripts(tempDir);
    const confidences = result.candidates.map((candidate) => candidate.confidence);

    expect(confidences).toEqual([...confidences].sort((a, b) => b - a));
  });

  it("handles malformed package.json gracefully", async () => {
    writeFileSync(path.join(tempDir, "package.json"), "{invalid", "utf-8");

    const pkgDir = path.join(tempDir, "packages", "web");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(path.join(pkgDir, "package.json"), "{broken", "utf-8");

    const result = await detectDevServerScripts(tempDir);
    expect(result.candidates).toEqual([]);
  });
});
