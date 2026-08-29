import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as realFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerStage, unregisterStage } from "../../session/stage-registry.js";

// Mock node:fs so we can observe/inject behaviour around readFileSync and
// accessSync without relying on vi.spyOn (ESM namespace exports are not
// configurable). The list scan probes readability with accessSync (no bytes
// read); readFileSync is only used when an artifact's content is actually
// fetched (readArtifactById). The hooks below default to passthrough and
// individual tests override them.
let readFileHook: ((path: realFs.PathOrFileDescriptor, original: typeof realFs.readFileSync, args: unknown[]) => unknown) | undefined;
let accessHook: ((path: realFs.PathLike, original: typeof realFs.accessSync, args: unknown[]) => unknown) | undefined;

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof realFs>();
  return {
    ...actual,
    readFileSync: (path: realFs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (readFileHook) return readFileHook(path, actual.readFileSync, args);
      return (actual.readFileSync as (...a: unknown[]) => unknown)(path, ...args);
    },
    accessSync: (path: realFs.PathLike, ...args: unknown[]) => {
      if (accessHook) return accessHook(path, actual.accessSync, args);
      return (actual.accessSync as (...a: unknown[]) => unknown)(path, ...args);
    },
  };
});

const { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, utimesSync } = realFs;
const { discoverArtifacts, readArtifactById } = await import("../discovery.js");

function makeRepo(): string {
  return mkdtempSync(join(tmpdir(), "ce-discovery-"));
}

describe("discoverArtifacts", () => {
  let root: string;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    unregisterStage("publish-check");
    readFileHook = undefined;
    accessHook = undefined;
    vi.restoreAllMocks();
  });

  it("returns registry-backed pipeline artifacts plus explicit knowledge collections", () => {
    root = makeRepo();
    writeFileSync(join(root, "STRATEGY.md"), "# Strategy");
    writeFileSync(join(root, "CONCEPTS.md"), "# Concepts");
    mkdirSync(join(root, "docs/ideation"), { recursive: true });
    writeFileSync(join(root, "docs/ideation/a.md"), "ideation a");
    writeFileSync(join(root, "docs/ideation/b.md"), "ideation b");
    mkdirSync(join(root, "docs/brainstorms"), { recursive: true });
    writeFileSync(join(root, "docs/brainstorms/requirements.md"), "requirements");
    mkdirSync(join(root, "docs/plans"), { recursive: true });
    writeFileSync(join(root, "docs/plans/plan1.md"), "plan 1");
    mkdirSync(join(root, "docs/work"), { recursive: true });
    writeFileSync(join(root, "docs/work/work.md"), "work");
    mkdirSync(join(root, "docs/debug"), { recursive: true });
    writeFileSync(join(root, "docs/debug/debug.md"), "debug");
    mkdirSync(join(root, "docs/solutions"), { recursive: true });
    writeFileSync(join(root, "docs/solutions/sol.md"), "solution");

    const result = discoverArtifacts(root);
    const byStage = Object.fromEntries(result.groups.map((g) => [g.stage, g]));

    expect(result.totalArtifacts).toBe(9);
    expect(result.totalErrors).toBe(0);
    expect(byStage.strategy.entries).toHaveLength(1);
    expect(byStage.concepts.entries).toHaveLength(1);
    expect(byStage.ideate.entries).toHaveLength(2);
    expect(byStage.plan.entries).toHaveLength(1);
    expect(byStage.plan.entries[0]).toMatchObject({ path: "docs/plans/plan1.md" });
    expect(byStage.brainstorm.entries).toHaveLength(1);
    expect(byStage.plan.label).toBe("Plan");
    expect(byStage.work.entries[0]).toMatchObject({ path: "docs/work/work.md" });
    expect(byStage.debug.entries[0]).toMatchObject({ path: "docs/debug/debug.md" });
    expect(byStage.compound.entries).toHaveLength(1);
    // Every group present is flagged present.
    expect(byStage.ideate.present).toBe(true);
    expect(byStage.brainstorm.entries[0]).toMatchObject({ path: "docs/brainstorms/requirements.md" });
    // All entries are artifacts in the happy path.
    expect(result.groups.flatMap((g) => g.entries).every((e) => e.kind === "artifact")).toBe(true);
  });

  it("orders directory artifacts by updatedAt DESC", () => {
    root = makeRepo();
    mkdirSync(join(root, "docs/plans"), { recursive: true });
    const older = join(root, "docs/plans/old.md");
    const newer = join(root, "docs/plans/new.md");
    writeFileSync(older, "old");
    writeFileSync(newer, "new");
    // Force deterministic mtimes: old < new.
    const now = Date.now();
    utimesSync(older, new Date(now - 10_000), new Date(now - 10_000));
    utimesSync(newer, new Date(now), new Date(now));

    const result = discoverArtifacts(root);
    const plan = result.groups.find((g) => g.stage === "plan")!;
    expect(plan.entries.map((e) => e.name)).toEqual(["new.md", "old.md"]);
  });

  it("reports a partial-discovery state: some categories present, others empty", () => {
    root = makeRepo();
    writeFileSync(join(root, "STRATEGY.md"), "# Strategy");
    mkdirSync(join(root, "docs/plans"), { recursive: true });
    writeFileSync(join(root, "docs/plans/p.md"), "plan");
    // No ideation / brainstorms / solutions / CONCEPTS.

    const result = discoverArtifacts(root);
    const populated = result.groups.filter((g) => g.entries.length > 0);
    const empty = result.groups.filter((g) => g.entries.length === 0);
    expect(populated.map((g) => g.stage).sort()).toEqual(["plan", "strategy"]);
    expect(empty.length).toBeGreaterThan(0);
    // Empty groups are still present in the result so the hub can render them.
    expect(result.groups).toHaveLength(8);
  });

  it("returns an all-empty result when nothing is present (first-run)", () => {
    root = makeRepo();
    const result = discoverArtifacts(root);
    expect(result.totalArtifacts).toBe(0);
    expect(result.totalErrors).toBe(0);
    expect(result.groups.every((g) => g.entries.length === 0 && !g.present)).toBe(true);
  });

  it("classifies both readiness states in the single unified plan collection", () => {
    root = makeRepo();
    mkdirSync(join(root, "docs/plans"), { recursive: true });
    writeFileSync(
      join(root, "docs/plans/requirements.md"),
      "---\nartifact_contract: ce-unified-plan/v1\nartifact_readiness: requirements-only\nproduct_contract_source: ce-brainstorm\n---\n# Requirements\n",
    );
    writeFileSync(
      join(root, "docs/plans/implementation.md"),
      "---\nartifact_contract: ce-unified-plan/v1\nartifact_readiness: implementation-ready\nproduct_contract_source: ce-plan\n---\n# Implementation\n",
    );

    const result = discoverArtifacts(root);
    const plan = result.groups.find((g) => g.stage === "plan")!;
    const requirementsOnly = plan.entries.find((e) => e.name === "requirements.md");
    const implementationReady = plan.entries.find((e) => e.name === "implementation.md");

    expect(requirementsOnly).toMatchObject({
      kind: "artifact",
      artifactContract: "ce-unified-plan/v1",
      artifactReadiness: "requirements-only",
      productContractSource: "ce-brainstorm",
    });
    expect(implementationReady).toMatchObject({
      kind: "artifact",
      artifactContract: "ce-unified-plan/v1",
      artifactReadiness: "implementation-ready",
      productContractSource: "ce-plan",
    });
    expect(result.totalErrors).toBe(0);
  });

  it("treats malformed frontmatter as null metadata without crashing discovery", () => {
    root = makeRepo();
    mkdirSync(join(root, "docs/plans"), { recursive: true });
    writeFileSync(join(root, "docs/plans/bad.md"), "---\nartifact_contract: ce-unified-plan/v1\n# missing closing fence\n# Body\n");

    const result = discoverArtifacts(root);
    const plan = result.groups.find((g) => g.stage === "plan")!;

    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]).toMatchObject({
      kind: "artifact",
      artifactContract: null,
      artifactReadiness: null,
      productContractSource: null,
    });
    expect(result.totalErrors).toBe(0);
  });

  it("represents an unreadable artifact as an error entry, not a crash or silent drop", () => {
    root = makeRepo();
    mkdirSync(join(root, "docs/plans"), { recursive: true });
    const readable = join(root, "docs/plans/good.md");
    writeFileSync(readable, "good");

    // Simulate a malformed/unreadable artifact: the specific file throws when
    // the list scan probes readability (accessSync).
    accessHook = (path, original, args) => {
      if (typeof path === "string" && path.endsWith("good.md")) {
        throw new Error("EIO: simulated read failure");
      }
      return (original as (...a: unknown[]) => unknown)(path, ...args);
    };

    const result = discoverArtifacts(root);
    const plan = result.groups.find((g) => g.stage === "plan")!;
    expect(plan.entries).toHaveLength(1);
    const entry = plan.entries[0];
    expect(entry.kind).toBe("error");
    expect(entry.kind === "error" && entry.error).toContain("simulated read failure");
    expect(result.totalErrors).toBe(1);
    expect(result.totalArtifacts).toBe(0);
  });

  it("ignores unrelated files and does not read outside the conventional locations", () => {
    root = makeRepo();
    // Conventional artifact that SHOULD be read.
    writeFileSync(join(root, "STRATEGY.md"), "# Strategy");
    mkdirSync(join(root, "docs/ideation"), { recursive: true });
    writeFileSync(join(root, "docs/ideation/keep.md"), "keep");
    // Unrelated files that must NOT be read.
    writeFileSync(join(root, "README.md"), "readme"); // root-level non-conventional .md
    writeFileSync(join(root, "package.json"), "{}");
    writeFileSync(join(root, "docs/ideation/notes.txt"), "non-md, ignore"); // non-.md in a scanned dir
    mkdirSync(join(root, "secrets"), { recursive: true });
    writeFileSync(join(root, "secrets/secret.md"), "TOP SECRET"); // outside the allowlist
    mkdirSync(join(root, "docs/random"), { recursive: true });
    writeFileSync(join(root, "docs/random/r.md"), "unrelated"); // docs subtree but not conventional

    const opened: string[] = [];
    // The list scan probes readability with accessSync (no bytes read); track
    // exactly which paths it touches.
    accessHook = (path, original, args) => {
      if (typeof path === "string") opened.push(path);
      return (original as (...a: unknown[]) => unknown)(path, ...args);
    };

    const result = discoverArtifacts(root);

    // Only the two conventional artifacts were probed.
    expect(opened.some((p) => p.endsWith("STRATEGY.md"))).toBe(true);
    expect(opened.some((p) => p.endsWith(join("ideation", "keep.md")))).toBe(true);
    // Nothing outside the allowlist was opened.
    expect(opened.some((p) => p.includes(`${join("secrets", "secret.md")}`))).toBe(false);
    expect(opened.some((p) => p.endsWith("README.md"))).toBe(false);
    expect(opened.some((p) => p.endsWith("package.json"))).toBe(false);
    expect(opened.some((p) => p.endsWith("notes.txt"))).toBe(false);
    expect(opened.some((p) => p.includes(join("random", "r.md")))).toBe(false);

    expect(result.totalArtifacts).toBe(2);
  });

  it("rejects symlinked conventional directories and artifact children before reading", () => {
    root = makeRepo();
    const outside = makeRepo();
    try {
      mkdirSync(join(root, "docs"), { recursive: true });
      mkdirSync(join(outside, "plans"), { recursive: true });
      writeFileSync(join(outside, "plans/escape.md"), "outside plan");
      symlinkSync(join(outside, "plans"), join(root, "docs/plans"), "dir");

      let result = discoverArtifacts(root);
      let plan = result.groups.find((g) => g.stage === "plan")!;
      expect(plan.entries).toHaveLength(1);
      expect(plan.entries[0]).toMatchObject({ kind: "error", path: "docs/plans" });
      expect(result.totalArtifacts).toBe(0);

      rmSync(join(root, "docs/plans"), { recursive: true, force: true });
      mkdirSync(join(root, "docs/plans"), { recursive: true });
      writeFileSync(join(outside, "secret.md"), "outside secret");
      symlinkSync(join(outside, "secret.md"), join(root, "docs/plans/linked.md"));

      result = discoverArtifacts(root);
      plan = result.groups.find((g) => g.stage === "plan")!;
      expect(plan.entries).toHaveLength(1);
      expect(plan.entries[0]).toMatchObject({ kind: "error", path: "docs/plans/linked.md" });
      expect(result.totalArtifacts).toBe(0);
      expect(result.totalErrors).toBe(1);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("keeps traversal rejection in place for forged plan ids", () => {
    root = makeRepo();
    writeFileSync(join(root, "secrets.md"), "secret");

    expect(readArtifactById(root, "plan:../../secrets.md")).toBeUndefined();
  });

  it("discovers artifacts for a runtime-registered stage", () => {
    registerStage({
      stageId: "publish-check",
      order: 550,
      skillId: "ce-publish-check",
      artifactLocation: "docs/publish-check/",
      icon: "FileCheck",
      label: "Publish Check",
    });
    root = makeRepo();
    mkdirSync(join(root, "docs/publish-check"), { recursive: true });
    writeFileSync(join(root, "docs/publish-check/result.md"), "# Ready");

    const result = discoverArtifacts(root);
    expect(result.groups.find((group) => group.stage === "publish-check")).toMatchObject({
      label: "Publish Check",
      entries: [expect.objectContaining({ path: "docs/publish-check/result.md" })],
    });
  });
});

describe("readArtifactById", () => {
  let root: string;

  beforeEach(() => {
    root = makeRepo();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("reads a conventional file artifact", () => {
    writeFileSync(join(root, "STRATEGY.md"), "# Strategy body");
    const res = readArtifactById(root, "strategy:STRATEGY.md");
    expect(res).toBeDefined();
    expect(res && "content" in res && res.content).toContain("Strategy body");
  });

  it("reads a directory artifact's immediate Markdown child with readiness metadata", () => {
    mkdirSync(join(root, "docs/plans"), { recursive: true });
    writeFileSync(
      join(root, "docs/plans/p.md"),
      "---\nartifact_contract: ce-unified-plan/v1\nartifact_readiness: requirements-only\nproduct_contract_source: ce-brainstorm\n---\nplan body",
    );
    const res = readArtifactById(root, "plan:docs/plans/p.md");
    expect(res && "content" in res && res.content).toContain("plan body");
    expect(res && "content" in res && res.artifact).toMatchObject({
      artifactContract: "ce-unified-plan/v1",
      artifactReadiness: "requirements-only",
      productContractSource: "ce-brainstorm",
    });
  });

  it("refuses a forged id that escapes the conventional location", () => {
    writeFileSync(join(root, "secrets.md"), "secret");
    // Attempt to traverse out of docs/plans into the repo root.
    expect(readArtifactById(root, "plan:../../secrets.md")).toBeUndefined();
    // Wrong stage/path pairing for a file location.
    expect(readArtifactById(root, "strategy:CONCEPTS.md")).toBeUndefined();
    // Unknown stage.
    expect(readArtifactById(root, "bogus:whatever.md")).toBeUndefined();
  });

  it("refuses a symlinked artifact child when reading by id", () => {
    const outside = makeRepo();
    try {
      mkdirSync(join(root, "docs/plans"), { recursive: true });
      writeFileSync(join(outside, "secret.md"), "outside secret");
      symlinkSync(join(outside, "secret.md"), join(root, "docs/plans/linked.md"));

      expect(readArtifactById(root, "plan:docs/plans/linked.md")).toEqual({
        error: "Symlink artifacts are not allowed in CE discovery",
      });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses a nested path under a directory location (non-immediate child)", () => {
    mkdirSync(join(root, "docs/plans/sub"), { recursive: true });
    writeFileSync(join(root, "docs/plans/sub/deep.md"), "deep");
    expect(readArtifactById(root, "plan:docs/plans/sub/deep.md")).toBeUndefined();
  });
});
