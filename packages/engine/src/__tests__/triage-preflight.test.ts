import { describe, expect, it, vi } from "vitest";

import { createGhostBugProbeExec } from "../triage.js";
import {
  extractCitedConstructs,
  isBugFixShape,
  probeCitedConstructs,
  runGhostBugPreflight,
  runProbePositiveControl,
} from "../triage-domain/triage-preflight.js";

const task = { title: "fix: typecheck error", description: "desc" };
const options = (exec: ReturnType<typeof vi.fn>) => ({ cwd: process.cwd(), exec });

function controlMatched(argv: string[]): { stdout: string; stderr: string; exitCode: number } {
  if (argv[1] === "ls-files") return { stdout: "src/App.ts\n", stderr: "", exitCode: 0 };
  if (argv[1] === "show") return { stdout: "export const knownControl = true;\n", stderr: "", exitCode: 0 };
  return { stdout: "src/App.ts:1:export const knownControl = true;", stderr: "", exitCode: 0 };
}

describe("triage-preflight", () => {
  it("isBugFixShape matrix", () => {
    expect(isBugFixShape({ title: "fix: broken typecheck", description: "x" })).toBe(true);
    expect(isBugFixShape({ title: "chore", description: "compile error appears" })).toBe(true);
    expect(isBugFixShape({ title: "refactor", description: "cleanup" })).toBe(false);
    expect(isBugFixShape({ title: null, description: "" })).toBe(false);
  });

  it("extracts constructs and dedupes", () => {
    const prompt = [
      "Use `secrets_sync.handle()` and `foo_bar` in packages/core/src/secrets-sync.ts:12",
      "```ts",
      "import { x } from 'y'",
      "const a = b",
      "```",
      "pnpm --filter @fusion/core test",
      "pnpm --filter @fusion/core test",
    ].join("\n");
    const constructs = extractCitedConstructs(prompt);
    expect(constructs.some((c) => c.kind === "identifier" && c.raw === "secrets_sync.handle()")).toBe(true);
    expect(constructs.some((c) => c.filePath === "packages/core/src/secrets-sync.ts" && c.line === 12)).toBe(true);
    expect(constructs.some((c) => c.kind === "snippet" && c.raw.includes("import"))).toBe(true);
    expect(constructs.filter((c) => c.kind === "command")).toHaveLength(1);
  });

  it("caps extracted constructs at 20", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `\`value_${i}.x\``).join("\n");
    expect(extractCitedConstructs(lines)).toHaveLength(20);
  });

  it("uses shell-free repository-wide argv and passes the source-less packages reproduction", async () => {
    const exec = vi.fn(async (argv: string[]) => ({ stdout: `src/App.ts:1:${argv[5]}`, stderr: "", exitCode: 0 }));
    const decision = await runGhostBugPreflight(task, "`Task.CompletedTask`\n`MyFixture.RunOnUiThreadAsync`", options(exec));
    expect(decision).toMatchObject({ decision: "pass", reason: "construct_found_or_inconclusive" });
    for (const argv of exec.mock.calls.map(([argv]) => argv as string[])) {
      expect(Array.isArray(argv)).toBe(true);
      expect(argv[0]).toBe("git");
      expect(argv.join(" ")).not.toMatch(/packages\/|\|\| true|\||&&|;|\$\(|`/);
    }
  });

  it("classifies exit codes and output without treating stderr as a match", async () => {
    const exec = vi.fn()
      .mockResolvedValueOnce({ stdout: "hit", stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 1 })
      .mockResolvedValueOnce({ stdout: "", stderr: "fatal: bad pathspec", exitCode: 1 })
      .mockResolvedValueOnce({ stdout: "", stderr: "fatal", exitCode: 128 })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });
    const findings = await probeCitedConstructs([
      { kind: "identifier", raw: "found_item" },
      { kind: "identifier", raw: "missing_item" },
      { kind: "snippet", raw: "bad pathspec" },
      { kind: "snippet", raw: "not a repository" },
      { kind: "snippet", raw: "legacy result" },
    ], options(exec));
    expect(findings.map(({ matched, probeError }) => ({ matched, probeError }))).toEqual([
      { matched: true, probeError: undefined },
      { matched: false, probeError: undefined },
      { matched: false, probeError: "probe_command_failed" },
      { matched: false, probeError: "probe_command_failed" },
      { matched: false, probeError: "exit_code_unavailable" },
    ]);
  });

  it("fails open for rejected execution and non-executed commands", async () => {
    const exec = vi.fn().mockRejectedValue(new Error("spawn failed"));
    const findings = await probeCitedConstructs([{ kind: "command", raw: "pnpm dangerous" }], options(exec));
    expect(findings[0]).toMatchObject({ matched: false, probeError: "command_probes_not_executed" });
    expect(exec).not.toHaveBeenCalled();
    const decision = await runGhostBugPreflight(task, "`foo_bar`", options(exec));
    expect(decision).toMatchObject({ decision: "pass", reason: "no_definitive_probe_signal" });
  });

  it("keeps leading-dash raw values as data and refuses unsafe values without execution", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 1 });
    const leadingDash = await probeCitedConstructs([{ kind: "snippet", raw: "-not-an-option" }], options(exec));
    expect(leadingDash[0].probeError).toBeUndefined();
    expect(exec.mock.calls[0][0].slice(0, 6)).toEqual(["git", "grep", "-nF", "-e", "-not-an-option", "--"]);
    exec.mockClear();
    const unsafe = await probeCitedConstructs([
      { kind: "snippet", raw: "bad\ninput" },
      { kind: "identifier", raw: "file", filePath: "src/../secret.ts" },
    ], options(exec));
    expect(unsafe.every((finding) => finding.probeError === "unsafe_construct")).toBe(true);
    expect(exec).not.toHaveBeenCalled();
  });

  it("truncates large stdout before retaining findings", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "x".repeat(200 * 1024), stderr: "", exitCode: 0 });
    const [finding] = await probeCitedConstructs([{ kind: "identifier", raw: "large_output" }], options(exec));
    expect(finding.output).toHaveLength(512);
    expect(finding.output?.endsWith("…[truncated]")).toBe(true);
  });

  it("deletes only when all probes are missing and the positive control matches", async () => {
    const exec = vi.fn((argv: string[]) => argv[1] === "grep" && argv[4] !== "export const knownControl = true;"
      ? Promise.resolve({ stdout: "", stderr: "", exitCode: 1 })
      : Promise.resolve(controlMatched(argv)));
    const decision = await runGhostBugPreflight(task, "`foo_bar`", options(exec));
    expect(decision).toMatchObject({ decision: "delete", reason: "all_cited_constructs_missing_on_main" });
  });

  it("passes when positive control is unmatched or unavailable", async () => {
    const unmatched = vi.fn((argv: string[]) => argv[1] === "grep" && argv[4] !== "export const knownControl = true;"
      ? Promise.resolve({ stdout: "", stderr: "", exitCode: 1 })
      : Promise.resolve(argv[1] === "grep" ? { stdout: "", stderr: "", exitCode: 1 } : controlMatched(argv)));
    expect(await runGhostBugPreflight(task, "`foo_bar`", options(unmatched))).toMatchObject({ decision: "pass", reason: "probe_control_failed" });
    for (const lsFiles of [{ stdout: "", stderr: "", exitCode: 1 }, { stdout: "", stderr: "", exitCode: 0 }]) {
      const unavailable = vi.fn((argv: string[]) => argv[1] === "grep"
        ? Promise.resolve({ stdout: "", stderr: "", exitCode: 1 })
        : Promise.resolve(lsFiles));
      expect(await runGhostBugPreflight(task, "`foo_bar`", options(unavailable))).toMatchObject({ decision: "pass", reason: "probe_control_failed" });
    }
  });

  it("makes show failures and unusable sampled content unavailable", async () => {
    const showFails = vi.fn((argv: string[]) => {
      if (argv[1] === "ls-files") return Promise.resolve({ stdout: "src/App.ts\n", stderr: "", exitCode: 0 });
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 1 });
    });
    expect(await runProbePositiveControl(options(showFails))).toBe("unavailable");
    const noSample = vi.fn((argv: string[]) => argv[1] === "ls-files"
      ? Promise.resolve({ stdout: "src/App.ts\n", stderr: "", exitCode: 0 })
      : Promise.resolve({ stdout: "tiny\n", stderr: "", exitCode: 0 }));
    expect(await runProbePositiveControl(options(noSample))).toBe("unavailable");
  });

  it("does not run the positive control when a construct already matches", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "src/a.ts:1:foo_bar", stderr: "", exitCode: 0 });
    await runGhostBugPreflight(task, "`foo_bar`", options(exec));
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("runs a positive control with argv-only sampled text", async () => {
    const exec = vi.fn((argv: string[]) => Promise.resolve(controlMatched(argv)));
    expect(await runProbePositiveControl(options(exec))).toBe("matched");
    const grep = exec.mock.calls.map(([argv]) => argv as string[]).find((argv) => argv[1] === "grep")!;
    expect(grep.slice(0, 6)).toEqual(["git", "grep", "-nF", "-e", "export const knownControl = true;", "--"]);
  });

  it("adapts execFile rejections into exit-code results without a shell", async () => {
    const rejecting = vi.fn().mockRejectedValue({ code: 1, stdout: "", stderr: "" });
    const probe = createGhostBugProbeExec(rejecting);
    await expect(probe(["git", "grep", "needle"], { cwd: "/repo", timeoutMs: 123 })).resolves.toEqual({ stdout: "", stderr: "", exitCode: 1 });
    expect(rejecting).toHaveBeenCalledWith("git", ["grep", "needle"], expect.objectContaining({ cwd: "/repo", timeout: 123, maxBuffer: 1024 * 1024, shell: false }));
    await expect(createGhostBugProbeExec(vi.fn().mockRejectedValue({ stdout: "", stderr: "fatal" }))(["git", "status"])).resolves.toEqual({ stdout: "", stderr: "fatal" });
  });

  it("passes non bug-shape tasks", async () => {
    const exec = vi.fn();
    const decision = await runGhostBugPreflight({ title: "docs", description: "desc" }, "`foo_bar`", options(exec));
    expect(decision.decision).toBe("pass");
    expect(exec).not.toHaveBeenCalled();
  });
});
