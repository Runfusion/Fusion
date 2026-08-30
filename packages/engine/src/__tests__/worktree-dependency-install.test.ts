import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunCommandResult } from "@fusion/core";
import {
  DEPENDENCY_INSTALL_RECORD_FILENAME,
  dependencyEvidenceFingerprint,
  detectUnrecognizedDependencyEvidence,
  ensureWorktreeDependencies,
  readDependencyInstallRecord,
  recordPlannerDependencyResolution,
  resolveWorktreeDependencyReadiness,
} from "../worktree/worktree-dependency-install.js";

const temporaryRoots: string[] = [];

function fixture(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "fn-258-dependency-"));
  temporaryRoots.push(root);
  mkdirSync(join(root, ".git"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content);
  return root;
}

function availableEnv(...binaries: string[]): NodeJS.ProcessEnv {
  const bin = mkdtempSync(join(tmpdir(), "fn-258-bin-"));
  temporaryRoots.push(bin);
  for (const binary of binaries) writeFileSync(join(bin, binary), "");
  return { PATH: bin };
}

function success(): RunCommandResult {
  return { stdout: "", stderr: "", exitCode: 0, signal: null, bufferExceeded: false, timedOut: false };
}

function failure(stderr = "failed"): RunCommandResult {
  return { stdout: "", stderr, exitCode: 1, signal: null, bufferExceeded: false, timedOut: false };
}

function options(root: string, env: NodeJS.ProcessEnv, runner = vi.fn().mockResolvedValue(success())) {
  return {
    worktreePath: root,
    settings: {},
    taskId: "FN-258",
    store: { logEntry: vi.fn().mockResolvedValue(undefined) },
    taskEnv: env,
    runConfiguredCommand: runner,
  };
}

afterEach(() => {
  while (temporaryRoots.length) rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
});

describe("worktree dependency installation", () => {
  it("records a static site as not-needed without spawning a command", async () => {
    const root = fixture({ "index.html": "<!doctype html>" });
    const runner = vi.fn();
    const readiness = await ensureWorktreeDependencies(options(root, availableEnv(), runner));

    expect(readiness.readiness).toBe("not-needed");
    expect(runner).not.toHaveBeenCalled();
    expect(readDependencyInstallRecord(root)).toMatchObject({ version: 1, entries: [] });
  });

  it.each([
    ["node pnpm", { "pnpm-lock.yaml": "lock", "package.json": "{}" }, ["pnpm"], "pnpm install --frozen-lockfile"],
    ["node npm", { "package-lock.json": "lock", "package.json": "{}" }, ["npm"], "npm install"],
    ["node yarn", { "yarn.lock": "lock", "package.json": "{}" }, ["yarn"], "yarn install --frozen-lockfile"],
    ["node bun", { "bun.lock": "lock", "package.json": "{}" }, ["bun"], "bun install --frozen-lockfile"],
    ["bare node", { "package.json": "{}" }, ["npm"], "npm install"],
    ["uv", { "uv.lock": "lock" }, ["uv"], "uv sync --frozen"],
    ["poetry", { "poetry.lock": "lock" }, ["poetry"], "poetry install --no-interaction"],
    ["pipenv", { "Pipfile.lock": "lock" }, ["pipenv"], "pipenv sync"],
    ["pip", { "requirements.txt": "requests" }, ["pip"], "pip install -r requirements.txt"],
    ["rust locked", { "Cargo.toml": "[package]", "Cargo.lock": "lock" }, ["cargo"], "cargo fetch --locked"],
    ["rust unlocked", { "Cargo.toml": "[package]" }, ["cargo"], "cargo fetch"],
    ["go", { "go.mod": "module example" }, ["go"], "go mod download"],
    ["php", { "composer.json": "{}" }, ["composer"], "composer install --no-interaction"],
    ["ruby", { Gemfile: "source 'https://rubygems.org'" }, ["bundle"], "bundle install"],
    ["dotnet", { "project.csproj": "<Project />" }, ["dotnet"], "dotnet restore"],
    ["maven", { "pom.xml": "<project />" }, ["mvn"], "mvn -B -q dependency:go-offline"],
    ["gradle", { gradlew: "#!/bin/sh" }, [], "./gradlew --no-daemon dependencies"],
    ["elixir", { "mix.exs": "defmodule Example do end" }, ["mix"], "mix deps.get"],
    ["flutter", { "pubspec.yaml": "name: example" }, ["flutter", "dart"], "flutter pub get"],
    ["dart", { "pubspec.yaml": "name: example" }, ["dart"], "dart pub get"],
    ["swift", { "Package.swift": "// swift-tools-version: 5.9" }, ["swift"], "swift package resolve"],
  ] as const)("runs the exact %s command", async (_label, files, binaries, expectedCommand) => {
    const root = fixture(files);
    const runner = vi.fn().mockResolvedValue(success());
    const readiness = await ensureWorktreeDependencies(options(root, availableEnv(...binaries), runner));

    expect(readiness.readiness).toBe("satisfied");
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledWith(expectedCommand, root, 300_000, expect.any(Object));
  });

  it("runs each detected ecosystem family exactly once for a polyglot repository", async () => {
    const root = fixture({ "package.json": "{}", "requirements.txt": "requests" });
    const runner = vi.fn().mockResolvedValue(success());
    const readiness = await ensureWorktreeDependencies(options(root, availableEnv("npm", "pip"), runner));

    expect(readiness.readiness).toBe("satisfied");
    expect(runner.mock.calls.map(([command]) => command)).toEqual(["npm install", "pip install -r requirements.txt"]);
  });

  it("records a missing binary as unresolved without spawning", async () => {
    const root = fixture({ "go.mod": "module example" });
    const runner = vi.fn();
    const readiness = await ensureWorktreeDependencies(options(root, availableEnv(), runner));

    expect(readiness.readiness).toBe("unresolved");
    expect(readiness.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ ecosystem: "go", outcome: "toolchain-missing" }),
    ]));
    expect(runner).not.toHaveBeenCalled();
  });

  it("memoizes a satisfied matrix row and re-arms it when its fingerprint changes", async () => {
    const root = fixture({ "pnpm-lock.yaml": "first", "package.json": "{}" });
    const runner = vi.fn().mockResolvedValue(success());
    const initial = options(root, availableEnv("pnpm"), runner);
    await ensureWorktreeDependencies(initial);
    await ensureWorktreeDependencies(initial);
    writeFileSync(join(root, "pnpm-lock.yaml"), "second");
    await ensureWorktreeDependencies(initial);

    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("retries a frozen Node install exactly once without the frozen flag", async () => {
    const root = fixture({ "pnpm-lock.yaml": "lock", "package.json": "{}" });
    const runner = vi.fn().mockResolvedValueOnce(failure("ERR_PNPM_OUTDATED_LOCKFILE")).mockResolvedValueOnce(success());
    const readiness = await ensureWorktreeDependencies(options(root, availableEnv("pnpm"), runner));

    expect(readiness.readiness).toBe("satisfied");
    expect(runner.mock.calls.map(([command]) => command)).toEqual([
      "pnpm install --frozen-lockfile",
      "pnpm install --no-frozen-lockfile",
    ]);
  });

  it("marks remaining rows budget-exhausted when the per-worktree budget is spent", async () => {
    const root = fixture({ "package.json": "{}", "requirements.txt": "requests" });
    const runner = vi.fn().mockResolvedValue(success());
    const now = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValueOnce(600_000);
    const readiness = await ensureWorktreeDependencies({ ...options(root, availableEnv("npm", "pip"), runner), now });

    expect(readiness.readiness).toBe("unresolved");
    expect(runner).toHaveBeenCalledTimes(1);
    expect(readiness.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ ecosystem: "python-pip", outcome: "budget-exhausted" }),
    ]));
  });

  it("treats named and generic out-of-matrix evidence as unrecognized", async () => {
    const namedRoot = fixture({ "flake.nix": "{}" });
    const genericRoot = fixture({ "something.lock": "opaque" });
    const namedRunner = vi.fn();
    const genericRunner = vi.fn();

    expect((await ensureWorktreeDependencies(options(namedRoot, availableEnv(), namedRunner))).readiness).toBe("unrecognized");
    expect((await ensureWorktreeDependencies(options(genericRoot, availableEnv(), genericRunner))).readiness).toBe("unrecognized");
    expect(detectUnrecognizedDependencyEvidence(genericRoot)).toEqual(["something.lock"]);
    expect(namedRunner).not.toHaveBeenCalled();
    expect(genericRunner).not.toHaveBeenCalled();
  });

  it("does not mistake plain build files or matrix lockfiles for unrecognized evidence", async () => {
    const makeRoot = fixture({ Makefile: "all:" });
    const cmakeRoot = fixture({ "CMakeLists.txt": "cmake_minimum_required(VERSION 3.20)" });
    const cargoRoot = fixture({ "Cargo.toml": "[package]", "Cargo.lock": "lock" });

    expect((await ensureWorktreeDependencies(options(makeRoot, availableEnv(), vi.fn()))).readiness).toBe("not-needed");
    expect((await ensureWorktreeDependencies(options(cmakeRoot, availableEnv(), vi.fn()))).readiness).toBe("not-needed");
    const cargo = await ensureWorktreeDependencies(options(cargoRoot, availableEnv("cargo"), vi.fn().mockResolvedValue(success())));
    expect(cargo.readiness).toBe("satisfied");
    expect(cargo.evidence).toEqual([]);
  });

  it("keeps unrecognized evidence blocking alongside a successful matrix row", async () => {
    const root = fixture({ "package.json": "{}", "flake.nix": "{}" });
    const readiness = await ensureWorktreeDependencies(options(root, availableEnv("npm"), vi.fn().mockResolvedValue(success())));

    expect(readiness.readiness).toBe("unrecognized");
    expect(readiness.evidence).toEqual(["flake.nix"]);
  });

  it("makes configured init authoritative and records its success or failure", async () => {
    const successRoot = fixture({ "flake.nix": "{}", "package.json": "{}" });
    const successRunner = vi.fn().mockResolvedValue(success());
    const successReadiness = await ensureWorktreeDependencies({
      ...options(successRoot, availableEnv(), successRunner),
      settings: { worktreeInitCommand: "bootstrap-project" },
    });
    expect(successReadiness.readiness).toBe("satisfied");
    expect(successRunner).toHaveBeenCalledWith("bootstrap-project", successRoot, 300_000, expect.any(Object));

    const failedRoot = fixture({ "flake.nix": "{}" });
    const failedReadiness = await ensureWorktreeDependencies({
      ...options(failedRoot, availableEnv(), vi.fn().mockResolvedValue(failure())),
      settings: { worktreeInitCommand: "bootstrap-project" },
    });
    expect(failedReadiness.readiness).toBe("unresolved");
    expect(failedReadiness.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ ecosystem: "configured-init-command", outcome: "install-failed" }),
    ]));
  });

  it("only lets a planner close evidence from an engine-observed success or reasoned none", async () => {
    const installRoot = fixture({ "flake.nix": "one" });
    await ensureWorktreeDependencies(options(installRoot, availableEnv(), vi.fn()));
    expect(recordPlannerDependencyResolution({
      worktreePath: installRoot,
      action: "install",
      command: "nix develop --command true",
      result: success(),
    }).readiness).toBe("satisfied");

    const failedRoot = fixture({ "flake.nix": "one" });
    await ensureWorktreeDependencies(options(failedRoot, availableEnv(), vi.fn()));
    expect(recordPlannerDependencyResolution({
      worktreePath: failedRoot,
      action: "install",
      command: "nix develop --command true",
      result: failure(),
    }).readiness).toBe("unrecognized");

    const noneRoot = fixture({ "something.lock": "one" });
    await ensureWorktreeDependencies(options(noneRoot, availableEnv(), vi.fn()));
    expect(recordPlannerDependencyResolution({
      worktreePath: noneRoot,
      action: "none",
      reason: "This lockfile is documentation-only and has no install step.",
    }).readiness).toBe("satisfied");
    writeFileSync(join(noneRoot, "something.lock"), "two");
    const plan = [];
    const evidence = ["something.lock"];
    expect(resolveWorktreeDependencyReadiness(noneRoot, plan, evidence).readiness).toBe("unrecognized");
    expect(dependencyEvidenceFingerprint(noneRoot, evidence)).not.toBe("");
  });

  it("writes the record below the private Git directory without dirtying a real worktree", async () => {
    const root = mkdtempSync(join(tmpdir(), "fn-258-dependency-git-"));
    temporaryRoots.push(root);
    execFileSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(join(root, "index.html"), "ok");
    execFileSync("git", ["add", "index.html"], { cwd: root });
    execFileSync("git", ["-c", "user.name=Fusion Test", "-c", "user.email=fusion@example.test", "commit", "-qm", "fixture"], { cwd: root });
    await ensureWorktreeDependencies(options(root, availableEnv(), vi.fn()));

    expect(readDependencyInstallRecord(root)).not.toBeNull();
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" })).toBe("");
    expect(() => readDependencyInstallRecord(join(root, DEPENDENCY_INSTALL_RECORD_FILENAME))).not.toThrow();
  });
});
