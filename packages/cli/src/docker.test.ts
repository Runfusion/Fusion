import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const dockerfilePath = resolve(workspaceRoot, "Dockerfile");
const dockerignorePath = resolve(workspaceRoot, ".dockerignore");
const dockerDocsPath = resolve(workspaceRoot, "docs", "docker.md");

describe("Docker configuration", () => {
  it("has a Dockerfile with required production instructions", () => {
    expect(existsSync(dockerfilePath)).toBe(true);
    const dockerfile = readFileSync(dockerfilePath, "utf8");

    expect(dockerfile).toContain("FROM node:22");
    expect(dockerfile).toContain("ENTRYPOINT");
    expect(dockerfile).toContain("USER node");
    expect(dockerfile).toContain("HEALTHCHECK");
    expect(dockerfile).toContain("EXPOSE 4040");
    expect(dockerfile).toContain("CMD");
  });

  it("uses a multi-stage Docker build", () => {
    const dockerfile = readFileSync(dockerfilePath, "utf8");
    const fromInstructions = dockerfile.match(/^FROM\s+/gm) ?? [];
    expect(fromInstructions.length).toBeGreaterThanOrEqual(2);
  });

  it("installs git and uses deterministic pnpm installs", () => {
    const dockerfile = readFileSync(dockerfilePath, "utf8");

    expect(dockerfile).toMatch(/apt-get[^\n]*install[^\n]*git/);
    expect(dockerfile).toContain("pnpm install --frozen-lockfile");
  });

  it("has a .dockerignore with required exclusions", () => {
    expect(existsSync(dockerignorePath)).toBe(true);
    const dockerignore = readFileSync(dockerignorePath, "utf8");

    expect(dockerignore).toContain("node_modules/");
    expect(dockerignore).toContain(".git/");
    expect(dockerignore).toContain("dist/");
    expect(dockerignore).toContain(".fusion/");
  });

  it("does not exclude package manifests needed for install", () => {
    const dockerignore = readFileSync(dockerignorePath, "utf8");
    const dockerignoreLines = dockerignore
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));

    expect(dockerignoreLines).not.toContain("package.json");
    expect(dockerignoreLines).not.toContain("pnpm-lock.yaml");
  });

  it("has docker documentation for build, run, and environment variables", () => {
    expect(existsSync(dockerDocsPath)).toBe(true);
    const docs = readFileSync(dockerDocsPath, "utf8").toLowerCase();

    expect(docs).toContain("build");
    expect(docs).toContain("run");
    expect(docs).toContain("environment variables");
  });

  it("does not patch the CLI bundle at build time", () => {
    const dockerfile = readFileSync(dockerfilePath, "utf8");
    // The tsup bundle should be self-contained without runtime patches
    expect(dockerfile).not.toContain("sed -i");
    expect(dockerfile).not.toContain("node_modules/sqlite");
    expect(dockerfile).not.toContain("createRequire");
  });
});
