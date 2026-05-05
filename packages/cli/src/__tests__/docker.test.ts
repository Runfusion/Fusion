import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const workspaceRoot = resolve(import.meta.dirname, "../../../..");
const dockerfilePath = resolve(workspaceRoot, "Dockerfile");
const dockerignorePath = resolve(workspaceRoot, ".dockerignore");
const dockerDocsPath = resolve(workspaceRoot, "docs", "docker.md");
const architectureDocsPath = resolve(workspaceRoot, "docs", "architecture.md");

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

  it("documents managed docker node provisioning architecture and endpoint boundaries", () => {
    expect(existsSync(architectureDocsPath)).toBe(true);
    const docs = readFileSync(architectureDocsPath, "utf8");

    expect(docs).toContain("### Docker Node Provisioning");
    expect(docs).toContain("register-docker-provisioning-routes.ts");
    expect(docs).toContain("register-docker-node-routes.ts");
    expect(docs).toContain("/api/docker/provision");
    expect(docs).toContain("/api/docker/deprovision");
    expect(docs).toContain("/api/docker/containers/:containerId/start");
    expect(docs).toContain("/api/docker/containers/:containerId/stop");
    expect(docs).toContain("/api/docker/containers/:containerId/restart");
    expect(docs).toContain("/api/docker/containers/:containerId/status");
  });

  it("documents mesh node port convention and docker guide cross-reference", () => {
    const architectureDocs = readFileSync(architectureDocsPath, "utf8");
    const dockerDocs = readFileSync(dockerDocsPath, "utf8");

    expect(architectureDocs).toContain("default to **`4041`**");
    expect(architectureDocs).toContain("**`4040` remains reserved**");
    expect(dockerDocs).toContain("[Architecture → Docker Node Provisioning]");
    expect(dockerDocs).toContain("This document is about containerizing Fusion itself");
  });

  it("does not patch the CLI bundle at build time", () => {
    const dockerfile = readFileSync(dockerfilePath, "utf8");
    // The tsup bundle should be self-contained without runtime patches
    expect(dockerfile).not.toContain("sed -i");
    expect(dockerfile).not.toContain("node_modules/sqlite");
    expect(dockerfile).not.toContain("createRequire");
  });
});
