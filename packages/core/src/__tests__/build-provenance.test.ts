/*
FNXC:BuildProvenance 2026-11-01-03:18 (RUFU-359):
Acceptance suite for the build-freshness signal. Everything that decides a verdict is driven by
INJECTED pure inputs against a fixed clock, so no test here waits on disk or spawns a real git
subprocess — with one deliberate exception: `resolveFusionWorkspaceRoot`'s packaged-install case runs
against a real `mkdtemp` tree precisely so the real `node:fs` helpers stay exercised. Mocking `fs`
would have proven only that a mock agrees with itself, which is the wrong proof for the guard whose
entire job is to survive an installation shape nobody tested.

The stale fixture uses the operator's real measured numbers (bundle mtime 2026-10-09T22:45:21Z vs
HEAD 2026-10-10T04:34:39+02:00, `rev-list` 5) because this suite is the `## Symptom Verification`
assertion that the original silence is gone.
*/

import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BUILD_STALE_GRACE_MS,
  FUSION_WORKSPACE_PACKAGE_NAME,
  collectBuildProvenance,
  evaluateBuildProvenance,
  formatBuildProvenanceWarning,
  reportBuildProvenance,
  resolveFusionWorkspaceRoot,
} from "../build-provenance.js";

/** The operator's measured deployment, verbatim. */
const MEASURED_BUNDLE_MTIME_ISO = "2026-10-09T22:45:21.000Z";
const MEASURED_HEAD_SHA = "24da32eba1c0d3f2b1c4d5e6f7089a0b1c2d3e4f";
const MEASURED_HEAD_TIME_ISO = "2026-10-10T04:34:39+02:00";
const MEASURED_BUNDLE_MTIME_MS = Date.parse(MEASURED_BUNDLE_MTIME_ISO);
const MEASURED_HEAD_TIME_MS = Date.parse(MEASURED_HEAD_TIME_ISO);
const MEASURED_COMMITS_BEHIND = 5;

const OWNED_ROOT = "/repo/fusion";
const ARTIFACT = `${OWNED_ROOT}/packages/cli/dist/bin.js`;

/**
 * Sentinel-based overrides, NOT `??`: a `null` override means "this probe failed", which is the
 * behaviour most of these fixtures exist to test, and `null ?? default` would silently answer
 * "this probe succeeded" instead.
 */
const PROBE_SUCCEEDED = Symbol("probe-succeeded");

function makeGitResponder(overrides: {
  toplevel?: string | null;
  head?: string | null;
  count?: string | null;
} = {}) {
  const toplevel = overrides.toplevel === undefined ? PROBE_SUCCEEDED : overrides.toplevel;
  const head = overrides.head === undefined ? PROBE_SUCCEEDED : overrides.head;
  const count = overrides.count === undefined ? PROBE_SUCCEEDED : overrides.count;
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const runGit = vi.fn(async (args: string[], cwd: string) => {
    calls.push({ args, cwd });
    if (args[0] === "rev-parse") return toplevel === PROBE_SUCCEEDED ? OWNED_ROOT : (toplevel as string | null);
    if (args[0] === "log") return head === PROBE_SUCCEEDED ? `${MEASURED_HEAD_SHA}\t${MEASURED_HEAD_TIME_ISO}` : (head as string | null);
    if (args[0] === "rev-list") return count === PROBE_SUCCEEDED ? String(MEASURED_COMMITS_BEHIND) : (count as string | null);
    return null;
  });
  return { calls, runGit };
}

function makeReportHarness(git: ReturnType<typeof makeGitResponder>, options: {
  bundleMtimeMs?: number;
  statNull?: boolean;
  workspaceRoot?: string | null;
  sink?: { recordRunAuditEvent: ReturnType<typeof vi.fn> } | null;
  logThrows?: boolean;
} = {}) {
  const statFile = vi.fn(async () =>
    options.statNull ? null : { mtimeMs: options.bundleMtimeMs ?? MEASURED_BUNDLE_MTIME_MS },
  );
  const warn = vi.fn((message: string) => {
    if (options.logThrows) throw new Error(`sink exploded: ${message}`);
  });
  const auditSink = options.sink ?? { recordRunAuditEvent: vi.fn().mockResolvedValue(undefined) };
  return {
    statFile,
    warn,
    auditSink,
    workspaceRoot: options.workspaceRoot === undefined ? OWNED_ROOT : options.workspaceRoot,
    git,
  };
}

async function runReport(
  harness: ReturnType<typeof makeReportHarness>,
  artifactPath = ARTIFACT,
) {
  return reportBuildProvenance({
    artifactPath,
    sink: harness.auditSink,
    log: { warn: harness.warn },
    statFile: harness.statFile,
    runGit: harness.git.runGit,
    resolveWorkspaceRoot: () => harness.workspaceRoot,
  });
}

describe("evaluateBuildProvenance — the pure verdict rule", () => {
  it("calls a bundle built at or after HEAD fresh and says nothing", () => {
    const p = evaluateBuildProvenance({
      artifactPath: ARTIFACT,
      bundleMtimeMs: MEASURED_HEAD_TIME_MS + 1_000,
      headCommitTimeMs: MEASURED_HEAD_TIME_MS,
      nowMs: MEASURED_HEAD_TIME_MS + 60_000,
    });
    expect(p.verdict).toBe("fresh");
  });

  it("treats a HEAD exactly at the grace edge as fresh and one millisecond past it as stale", () => {
    const insideGrace = evaluateBuildProvenance({
      artifactPath: ARTIFACT,
      bundleMtimeMs: MEASURED_HEAD_TIME_MS - BUILD_STALE_GRACE_MS,
      headCommitTimeMs: MEASURED_HEAD_TIME_MS,
      nowMs: MEASURED_HEAD_TIME_MS,
    });
    const outsideGrace = evaluateBuildProvenance({
      artifactPath: ARTIFACT,
      bundleMtimeMs: MEASURED_HEAD_TIME_MS - BUILD_STALE_GRACE_MS - 1,
      headCommitTimeMs: MEASURED_HEAD_TIME_MS,
      nowMs: MEASURED_HEAD_TIME_MS,
    });
    expect(insideGrace.verdict).toBe("fresh");
    expect(outsideGrace.verdict).toBe("stale");
  });

  it("reports the measured deployment as stale with its real age", () => {
    const p = evaluateBuildProvenance({
      artifactPath: ARTIFACT,
      bundleMtimeMs: MEASURED_BUNDLE_MTIME_MS,
      headCommitTimeMs: MEASURED_HEAD_TIME_MS,
      commitsBehind: MEASURED_COMMITS_BEHIND,
      nowMs: MEASURED_HEAD_TIME_MS,
    });
    expect(p.verdict).toBe("stale");
    expect(p.ageMs).toBe(MEASURED_HEAD_TIME_MS - MEASURED_BUNDLE_MTIME_MS);
    expect(p.commitsBehind).toBe(MEASURED_COMMITS_BEHIND);
  });

  it("answers unknown, never fresh, when HEAD time is missing or unparseable", () => {
    const missing = evaluateBuildProvenance({
      artifactPath: ARTIFACT,
      bundleMtimeMs: MEASURED_BUNDLE_MTIME_MS,
      nowMs: MEASURED_HEAD_TIME_MS,
    });
    const unparseable = evaluateBuildProvenance({
      artifactPath: ARTIFACT,
      bundleMtimeMs: MEASURED_BUNDLE_MTIME_MS,
      headCommitTimeMs: Number.NaN,
      nowMs: MEASURED_HEAD_TIME_MS,
    });
    expect(missing.verdict).toBe("unknown");
    expect(unparseable.verdict).toBe("unknown");
    // `unknown` still falls back to the wall clock so the age remains reportable.
    expect(missing.ageMs).toBe(MEASURED_HEAD_TIME_MS - MEASURED_BUNDLE_MTIME_MS);
  });
});

describe("formatBuildProvenanceWarning", () => {
  it("names both timestamps, the 9-character sha, the commit count, and the operator remedy", () => {
    const line = formatBuildProvenanceWarning({
      artifactPath: ARTIFACT,
      bundleMtime: MEASURED_BUNDLE_MTIME_ISO,
      headSha: MEASURED_HEAD_SHA,
      headTime: MEASURED_HEAD_TIME_ISO,
      commitsBehind: MEASURED_COMMITS_BEHIND,
      ageMs: MEASURED_HEAD_TIME_MS - MEASURED_BUNDLE_MTIME_MS,
      verdict: "stale",
    });
    expect(line).toContain("build provenance:");
    expect(line).toContain(MEASURED_BUNDLE_MTIME_ISO);
    expect(line).toContain(MEASURED_HEAD_TIME_ISO);
    expect(line).toContain(MEASURED_HEAD_SHA.slice(0, 9));
    expect(line).toContain(`~${MEASURED_COMMITS_BEHIND} commits`);
    expect(line).toContain("STALE");
    expect(line).toContain("operator action");
    // The call site owns the channel prefix, so the helper must not add one.
    expect(line.startsWith("build provenance:")).toBe(true);
  });

  it("omits the commit segment rather than rendering a contradictory ~0 when rev-list failed", () => {
    const line = formatBuildProvenanceWarning({
      artifactPath: ARTIFACT,
      bundleMtime: MEASURED_BUNDLE_MTIME_ISO,
      headSha: MEASURED_HEAD_SHA,
      headTime: MEASURED_HEAD_TIME_ISO,
      ageMs: MEASURED_HEAD_TIME_MS - MEASURED_BUNDLE_MTIME_MS,
      verdict: "stale",
    });
    expect(line).toContain("STALE");
    expect(line).not.toContain("~0 commits");
    expect(line).not.toContain("commits)");
  });

  it("renders human ages in one unit across day/hour/minute/second boundaries", () => {
    const render = (ageMs: number) =>
      / \(([^,)]+)[,)]/.exec(formatBuildProvenanceWarning({
        artifactPath: ARTIFACT,
        bundleMtime: MEASURED_BUNDLE_MTIME_ISO,
        headSha: MEASURED_HEAD_SHA,
        headTime: MEASURED_HEAD_TIME_ISO,
        ageMs,
        verdict: "stale",
      }))?.[1];
    expect(render(2 * 86_400_000)).toBe("2d");
    expect(render(8 * 3_600_000)).toBe("8h");
    expect(render(9 * 60_000)).toBe("9m");
    expect(render(45_000)).toBe("45s");
  });
});

describe("collectBuildProvenance — probe ordering and degradation", () => {
  it("parses `<sha>\\t<iso>` and derives --since from the injected artifact mtime", async () => {
    const git = makeGitResponder();
    const p = await collectBuildProvenance({
      artifactPath: ARTIFACT,
      statFile: async () => ({ mtimeMs: MEASURED_BUNDLE_MTIME_MS }),
      runGit: git.runGit,
      resolveWorkspaceRoot: () => OWNED_ROOT,
    });
    expect(p.verdict).toBe("stale");
    expect(p.headSha).toBe(MEASURED_HEAD_SHA);
    expect(p.headTime).toBe(MEASURED_HEAD_TIME_ISO);
    expect(p.bundleMtime).toBe(MEASURED_BUNDLE_MTIME_ISO);
    const revList = git.calls.find((call) => call.args[0] === "rev-list");
    expect(revList?.args).toEqual([
      "rev-list", "--count", "HEAD", `--since=${MEASURED_BUNDLE_MTIME_ISO}`,
    ]);
    // Identity and HEAD are read from the VERIFIED root, never from an operated-on working dir.
    expect(git.calls.find((call) => call.args[0] === "log")?.cwd).toBe(OWNED_ROOT);
  });

  it("keeps the STALE verdict when rev-list fails and reports no commit count", async () => {
    const git = makeGitResponder({ count: null });
    const p = await collectBuildProvenance({
      artifactPath: ARTIFACT,
      statFile: async () => ({ mtimeMs: MEASURED_BUNDLE_MTIME_MS }),
      runGit: git.runGit,
      resolveWorkspaceRoot: () => OWNED_ROOT,
    });
    expect(p.verdict).toBe("stale");
    expect(p.commitsBehind).toBeUndefined();
    const line = formatBuildProvenanceWarning(p);
    expect(line).toContain("STALE");
    expect(line).not.toContain("~0");
  });

  it("degrades an unparseable rev-list answer to no count rather than zero", async () => {
    const git = makeGitResponder({ count: "fatal: not a number\n" });
    const p = await collectBuildProvenance({
      artifactPath: ARTIFACT,
      statFile: async () => ({ mtimeMs: MEASURED_BUNDLE_MTIME_MS }),
      runGit: git.runGit,
      resolveWorkspaceRoot: () => OWNED_ROOT,
    });
    expect(p.verdict).toBe("stale");
    expect(p.commitsBehind).toBeUndefined();
  });

  it("returns unknown and never rejects when the git runner throws", async () => {
    const harness = makeReportHarness(makeGitResponder(), {});
    const p = await reportBuildProvenance({
      artifactPath: ARTIFACT,
      sink: harness.auditSink,
      log: { warn: harness.warn },
      statFile: async () => ({ mtimeMs: MEASURED_BUNDLE_MTIME_MS }),
      runGit: async () => {
        throw new Error("git exploded");
      },
      resolveWorkspaceRoot: () => OWNED_ROOT,
    });
    expect(p.verdict).toBe("unknown");
    expect(harness.warn).not.toHaveBeenCalled();
    expect(harness.auditSink.recordRunAuditEvent).not.toHaveBeenCalled();
  });

  it("returns unknown when the artifact cannot be stat'ed (no dist yet) and skips the count", async () => {
    const git = makeGitResponder();
    const p = await collectBuildProvenance({
      artifactPath: ARTIFACT,
      statFile: async () => null,
      runGit: git.runGit,
      resolveWorkspaceRoot: () => OWNED_ROOT,
    });
    expect(p.verdict).toBe("unknown");
    expect(p.ageMs).toBe(0);
  });
});

describe("reportBuildProvenance — the emit-once rule", () => {
  it("logs exactly one STALE line and writes exactly one audit row on the measured symptom", async () => {
    const harness = makeReportHarness(makeGitResponder(), {});
    const p = await runReport(harness);

    expect(p.verdict).toBe("stale");
    expect(harness.warn).toHaveBeenCalledTimes(1);
    const line = String(harness.warn.mock.calls[0]?.[0]);
    expect(line).toContain("build provenance:");
    expect(line).toContain(MEASURED_BUNDLE_MTIME_ISO);
    expect(line).toContain(MEASURED_HEAD_TIME_ISO);
    expect(line).toContain(MEASURED_HEAD_SHA.slice(0, 9));
    expect(line).toContain(`~${MEASURED_COMMITS_BEHIND} commits`);
    expect(line).toContain("STALE");

    const audit = harness.auditSink.recordRunAuditEvent;
    expect(audit).toHaveBeenCalledTimes(1);
    const event = audit.mock.calls[0]?.[0] as {
      agentId: string;
      runId: string;
      domain: string;
      mutationType: string;
      target: string;
      metadata: Record<string, unknown>;
    };
    expect(event.mutationType).toBe("build:provenance-stale");
    expect(event.agentId).toBe("boot");
    expect(event.runId).toBe("build-provenance");
    expect(event.domain).toBe("git");
    // Basename only — an absolute path would leak the operator's filesystem layout into the store.
    expect(event.target).toBe("bin.js");
    expect(Object.keys(event.metadata).sort()).toEqual(
      ["ageMs", "bundleMtime", "commitsBehind", "headSha", "headTime"],
    );
    expect(event.metadata.commitsBehind).toBe(MEASURED_COMMITS_BEHIND);
    expect(event.metadata.ageMs).toBe(MEASURED_HEAD_TIME_MS - MEASURED_BUNDLE_MTIME_MS);
    expect(JSON.stringify(event)).not.toContain(OWNED_ROOT);
  });

  it("stays completely silent when the bundle is newer than HEAD", async () => {
    const harness = makeReportHarness(makeGitResponder(), {
      bundleMtimeMs: MEASURED_HEAD_TIME_MS + 60_000,
    });
    const p = await runReport(harness);
    expect(p.verdict).toBe("fresh");
    expect(harness.warn).not.toHaveBeenCalled();
    expect(harness.auditSink.recordRunAuditEvent).not.toHaveBeenCalled();
  });

  it("stays silent when the bundle sits inside the grace window (a build in flight)", async () => {
    const harness = makeReportHarness(makeGitResponder(), {
      bundleMtimeMs: MEASURED_HEAD_TIME_MS - BUILD_STALE_GRACE_MS,
    });
    const p = await runReport(harness);
    expect(p.verdict).toBe("fresh");
    expect(harness.warn).not.toHaveBeenCalled();
    expect(harness.auditSink.recordRunAuditEvent).not.toHaveBeenCalled();
  });

  it("resolves and keeps the operator line when the audit sink throws", async () => {
    const harness = makeReportHarness(makeGitResponder(), {
      sink: { recordRunAuditEvent: vi.fn().mockRejectedValue(new Error("db down")) },
    });
    const p = await runReport(harness);
    expect(p.verdict).toBe("stale");
    expect(harness.warn).toHaveBeenCalledTimes(1);
    expect(harness.auditSink.recordRunAuditEvent).toHaveBeenCalledTimes(1);
  });

  it("resolves to unknown rather than throwing when the log sink itself throws", async () => {
    const harness = makeReportHarness(makeGitResponder(), { logThrows: true });
    const p = await runReport(harness);
    expect(p.verdict).toBe("unknown");
  });
});

describe("installation-ownership guard — the false-positive defence", () => {
  it("proves an unowned installation spawns zero git AND zero stat calls", async () => {
    const git = makeGitResponder({ toplevel: "/home/user/blog" });
    const harness = makeReportHarness(git, { workspaceRoot: null });
    const p = await runReport(harness, "/home/user/blog/node_modules/@runfusion/fusion/dist/bin.js");

    expect(p).toEqual({ artifactPath: "/home/user/blog/node_modules/@runfusion/fusion/dist/bin.js", ageMs: 0, verdict: "unknown" });
    expect(git.runGit).not.toHaveBeenCalled();
    expect(harness.statFile).not.toHaveBeenCalled();
    expect(harness.warn).not.toHaveBeenCalled();
    expect(harness.auditSink.recordRunAuditEvent).not.toHaveBeenCalled();
  });

  it("proves the documented packaged-install shape stays silent while git still answers a newer host HEAD", async () => {
    // The exact trap: `git rev-parse --show-toplevel` does NOT fail under a host project — it
    // returns the host's repository with a newer HEAD. Silence must come from ownership, not a crash.
    const git = makeGitResponder({ toplevel: "/home/user/blog", head: "abcd1234abcd1234abcd1234abcd1234abcd1234\t2026-10-10T04:34:39+02:00" });
    const harness = makeReportHarness(git, { workspaceRoot: null });
    const p = await runReport(harness, "/home/user/blog/node_modules/@runfusion/fusion/dist/bin.js");

    expect(p.verdict).toBe("unknown");
    expect(git.calls).toHaveLength(0);
    expect(git.runGit).not.toHaveBeenCalled();
    expect(harness.warn).not.toHaveBeenCalled();
    expect(harness.auditSink.recordRunAuditEvent).not.toHaveBeenCalled();
  });

  it("refuses a toplevel that sits outside the verified Fusion root (vendored checkout)", async () => {
    const git = makeGitResponder({ toplevel: "/elsewhere/outer-host-repo" });
    const harness = makeReportHarness(git, {});
    const p = await runReport(harness);

    expect(p.verdict).toBe("unknown");
    expect(harness.warn).not.toHaveBeenCalled();
    expect(harness.auditSink.recordRunAuditEvent).not.toHaveBeenCalled();
  });

  it("accepts a toplevel nested inside the verified root (a nested workspace member checkout)", async () => {
    const git = makeGitResponder({ toplevel: `${OWNED_ROOT}/packages/cli` });
    const harness = makeReportHarness(git, {});
    const p = await runReport(harness);
    expect(p.verdict).toBe("stale");
  });

  it("resolveFusionWorkspaceRoot rejects a real packaged-install tree without mocking node:fs", () => {
    // A real temp tree, so the REAL existsSync/readFileSync path is what is under test.
    const host = mkdtempSync(join(tmpdir(), "rufu359-host-"));
    try {
      const dist = join(host, "node_modules", "@runfusion", "fusion", "dist");
      mkdirSync(dist, { recursive: true });
      writeFileSync(join(host, "pnpm-workspace.yaml"), 'packages:\n  - "*"\n');
      writeFileSync(
        join(host, "package.json"),
        JSON.stringify({ name: "unrelated-host-project", version: "1.0.0" }),
      );
      writeFileSync(join(dist, "bin.js"), "#!/usr/bin/env node\n");

      expect(existsSync(join(host, "pnpm-workspace.yaml"))).toBe(true);
      expect(resolveFusionWorkspaceRoot(dist)).toBeNull();
    } finally {
      rmSync(host, { recursive: true, force: true });
    }
  });

  it("resolveFusionWorkspaceRoot accepts a real Fusion workspace tree", () => {
    const host = mkdtempSync(join(tmpdir(), "rufu359-fusion-"));
    try {
      const dist = join(host, "packages", "cli", "dist");
      mkdirSync(dist, { recursive: true });
      writeFileSync(join(host, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
      writeFileSync(join(host, "package.json"), JSON.stringify({ name: FUSION_WORKSPACE_PACKAGE_NAME }));
      writeFileSync(join(dist, "bin.js"), "#!/usr/bin/env node\n");
      expect(resolveFusionWorkspaceRoot(dist)).toBe(host);
    } finally {
      rmSync(host, { recursive: true, force: true });
    }
  });

  it("resolveFusionWorkspaceRoot resolves this repository by walking up, with no hardcoded path", () => {
    const resolved = resolveFusionWorkspaceRoot(fileURLToPath(new URL(".", import.meta.url)));
    expect(resolved).not.toBeNull();
    expect(existsSync(join(resolved as string, "pnpm-workspace.yaml"))).toBe(true);
  });

  it("resolveFusionWorkspaceRoot never throws on a nonexistent or empty start directory", () => {
    expect(resolveFusionWorkspaceRoot(join(tmpdir(), "rufu359-does-not-exist", "deeper"))).toBeNull();
    expect(() => resolveFusionWorkspaceRoot("")).not.toThrow();
  });
});

/*
FNXC:BuildProvenance 2026-11-01-03:23 (RUFU-359):
Everything above injects its probes, which leaves the DEFAULT git runner — `resolveGitBinary()` plus
`promisify(execFile)` and the real `%H%x09%cI` parsing — unexercised, and that is precisely the code
that runs in the field. This pair builds a real throwaway repository and calls the collector with NO
overrides, so the shipped plumbing itself is what answers both directions: a backdated artifact is
STALE with a real commit count, and a just-built artifact is silent. `GIT_CONFIG_GLOBAL=/dev/null` and
`GIT_CONFIG_NOSYSTEM=1` keep a developer's global config (signing, hooks, templates) out of the
subprocess, so the test cannot fail because of whose machine it runs on.
*/
const DAY_MS = 86_400_000;

async function git(cwd: string, args: string[], extraEnv: Record<string, string> = {}): Promise<string> {
  const { stdout } = await promisify(execFile)("git", args, {
    cwd,
    timeout: 15_000,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      ...extraEnv,
    },
  });
  return stdout.trim();
}

describe("build provenance over a real repository (default git runner)", () => {
  async function makeRealWorkspace(options: { artifactAgeMs: number }): Promise<{ dir: string; artifactPath: string }> {
    // realpathSync keeps the fixture path byte-identical to what `git rev-parse --show-toplevel`
    // reports, so the ownership check cannot disagree with the fixture over a symlinked TMPDIR.
    const dir = mkdtempSync(join(realpathSync(tmpdir()), "rufu359-real-"));
    writeFileSync(join(dir, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: FUSION_WORKSPACE_PACKAGE_NAME }));
    const dist = join(dir, "packages", "cli", "dist");
    mkdirSync(dist, { recursive: true });
    const artifactPath = join(dist, "bin.js");
    writeFileSync(artifactPath, "#!/usr/bin/env node\nconsole.log(1);\n");
    writeFileSync(join(dir, "README.md"), "# fixture\n");
    await git(dir, ["init", "-b", "main"]);
    await git(dir, ["add", "-A"]);
    // Commit timestamped one day ago; the artifact mtime is what the test moves around the grace edge.
    const commitIso = new Date(Date.now() - DAY_MS).toISOString();
    await git(dir, [
      "-c", "user.name=Fusion Test", "-c", "user.email=noreply@runfusion.ai",
      "-c", "commit.gpgsign=false",
      "commit", "-m", "fixture commit",
      `--date=${commitIso}`,
    ], {
      // %cI reads the COMMITTER date, which `--date=` alone does not move.
      GIT_COMMITTER_DATE: commitIso,
    });
    const stamp = (Date.now() - options.artifactAgeMs) / 1000;
    utimesSync(artifactPath, stamp, stamp);
    return { dir, artifactPath };
  }

  it("reports STALE with a real commit count for an artifact older than HEAD", async () => {
    const { dir, artifactPath } = await makeRealWorkspace({ artifactAgeMs: 2 * DAY_MS });
    try {
      const p = await collectBuildProvenance({ artifactPath });
      expect(p.verdict).toBe("stale");
      expect(p.commitsBehind).toBe(1);
      expect(p.headSha).toMatch(/^[0-9a-f]{40}$/);
      expect(formatBuildProvenanceWarning(p)).toMatch(/STALE[\s\S]*operator action/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stays fresh for an artifact built after the commit, exactly like a CI clone", async () => {
    const { dir, artifactPath } = await makeRealWorkspace({ artifactAgeMs: 0 });
    try {
      const p = await collectBuildProvenance({ artifactPath });
      expect(p.verdict).toBe("fresh");
      expect(p.commitsBehind).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

afterEach(() => {
  vi.clearAllMocks();
});
