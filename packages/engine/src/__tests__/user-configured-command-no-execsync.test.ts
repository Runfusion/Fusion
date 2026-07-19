import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * FNXC:EngineProcessRules 2026-06-26-03:45:
 * User-configured command paths must stay on bounded async execution APIs; this focused registry intentionally excludes git-plumbing execSync call sites so deterministic repository checks can keep using synchronous child-process APIs where appropriate.
 *
 * Protected registry for user-configured commands:
 * - packages/engine/src/verification-utils.ts :: execWithProcessGroup — delegates command execution through the sandbox backend streaming API; caller-owned options must carry bounds.
 * - packages/engine/src/verification-utils.ts :: runVerificationCommand — runs configured test/build commands through execWithProcessGroup with timeout and VERIFICATION_COMMAND_MAX_BUFFER.
 * - packages/engine/src/run-verification-tool.ts :: runVerificationCommand — backs fn_run_verification with superviseSpawn and maxLifetimeMs.
 * - packages/engine/src/executor.ts :: runConfiguredCommand — runs settings.scripts, settings.setupScript, settings.worktreeInitCommand, and workflow script commands through backend.run with timeoutMs and maxBuffer.
 * - packages/engine/src/merger.ts :: runConfiguredMergeWorktreeCommand — runs configured merge-worktree commands through backend.run with timeoutMs and maxBuffer.
 * - FNXC:EngineTests 2026-06-27-10:05: U7c removed the legacy merger-side executePostMergeScriptStep path; the static guard must track only live user-configured command surfaces so registry drift fails for real protected functions, not deleted ones.
 * - packages/engine/src/routine-runner.ts :: executeCommand — runs configured automation/routine commands through backend.run with timeoutMs and maxBuffer.
 * - packages/engine/src/sandbox/native.ts :: NativeSandboxBackend.run — default sandbox backend uses superviseSpawn with maxLifetimeMs plus timeoutMs/maxBuffer enforcement.
 * - packages/engine/src/sandbox/bubblewrap-backend.ts :: BubblewrapBackend.run — isolating backend delegates to native fallback or runBwrapSpawn; runBwrapSpawn uses spawn with timeoutMs and maxBuffer enforcement.
 * - packages/engine/src/sandbox/bubblewrap-backend.ts :: BubblewrapBackend.runBwrapSpawn — concrete bubblewrap spawn path uses setTimeout(options.timeoutMs) and options.maxBuffer.
 * - packages/engine/src/sandbox/sandbox-exec-backend.ts :: SandboxExecBackend.run — macOS isolating backend uses async exec with timeout, maxBuffer, and signal.
 *
 * Explicit exclusions: git-only execSync in merger.ts, self-healing.ts, already-merged-detector.ts, integration-branch.ts, worktree-prune.ts, and executor.ts git merge-base ancestry checks. The guard slices only registry function bodies instead of asserting over whole files.
 */

type GuardEntry = {
  file: string;
  name: string;
  signature: string;
  requiredSafeguards: Array<{ label: string; pattern: RegExp }>;
};

const protectedCommandPaths: GuardEntry[] = [
  {
    file: "src/verification-utils.ts",
    name: "execWithProcessGroup",
    signature: "export async function execWithProcessGroup(",
    requiredSafeguards: [
      { label: "sandbox streaming backend", pattern: /backend\.runStreaming\(/ },
    ],
  },
  {
    /*
    FNXC:EngineProcessRules 2026-07-15-11:40:
    runVerificationCommand is a concurrency-slot wrapper; the actual user-configured
    command spawn lives in runVerificationCommandUnlocked (execWithProcessGroup + bounds).
    Guard the unlocked body so slot extraction cannot reintroduce unbounded exec.
    */
    file: "src/verification-utils.ts",
    name: "runVerificationCommandUnlocked",
    signature: "async function runVerificationCommandUnlocked(",
    requiredSafeguards: [
      { label: "execWithProcessGroup async runner", pattern: /execWithProcessGroup\(/ },
      { label: "timeout option", pattern: /timeout\s*:\s*timeoutMs/ },
      { label: "verification maxBuffer", pattern: /maxBuffer\s*:\s*VERIFICATION_COMMAND_MAX_BUFFER/ },
    ],
  },
  {
    file: "src/verification-utils.ts",
    name: "runVerificationCommand",
    signature: "export async function runVerificationCommand(",
    requiredSafeguards: [
      { label: "verification slot wrapper", pattern: /withVerificationSlot\(/ },
      { label: "unlocked runner", pattern: /runVerificationCommandUnlocked\(/ },
    ],
  },
  {
    file: "src/run-verification-tool.ts",
    name: "runVerificationCommandUnlocked",
    signature: "async function runVerificationCommandUnlocked(",
    requiredSafeguards: [
      { label: "superviseSpawn async runner", pattern: /superviseSpawn\(/ },
      { label: "process lifetime cap", pattern: /maxLifetimeMs\s*:/ },
    ],
  },
  {
    file: "src/run-verification-tool.ts",
    name: "runVerificationCommand",
    signature: "export async function runVerificationCommand(",
    requiredSafeguards: [
      { label: "verification slot wrapper", pattern: /withVerificationSlot\(/ },
      { label: "unlocked runner", pattern: /runVerificationCommandUnlocked\(/ },
    ],
  },
  {
    file: "src/executor.ts",
    name: "runConfiguredCommand",
    signature: "async function runConfiguredCommand(",
    requiredSafeguards: [
      { label: "sandbox backend.run", pattern: /backend\.run\(/ },
      { label: "timeoutMs option", pattern: /timeoutMs\s*,/ },
      { label: "maxBuffer option", pattern: /maxBuffer\s*:/ },
    ],
  },
  {
    file: "src/merger.ts",
    name: "runConfiguredMergeWorktreeCommand",
    signature: "async function runConfiguredMergeWorktreeCommand(",
    requiredSafeguards: [
      { label: "sandbox backend.run", pattern: /backend\.run\(/ },
      { label: "timeoutMs option", pattern: /timeoutMs\s*,/ },
      { label: "maxBuffer option", pattern: /maxBuffer\s*:/ },
    ],
  },
  {
    file: "src/routine-runner.ts",
    name: "executeCommand",
    signature: "private async executeCommand(",
    requiredSafeguards: [
      { label: "sandbox backend.run", pattern: /backend\.run\(/ },
      { label: "timeoutMs option", pattern: /timeoutMs\s*:/ },
      { label: "maxBuffer option", pattern: /maxBuffer\s*:/ },
    ],
  },
  {
    file: "src/sandbox/native.ts",
    name: "NativeSandboxBackend.run",
    signature: "async run(command: string, options: SandboxRunOptions)",
    requiredSafeguards: [
      { label: "superviseSpawn async runner", pattern: /superviseSpawn\(/ },
      { label: "process lifetime cap", pattern: /maxLifetimeMs\s*:/ },
      { label: "timeoutMs enforcement", pattern: /options\.timeoutMs/ },
      { label: "maxBuffer enforcement", pattern: /options\.maxBuffer/ },
    ],
  },
  {
    file: "src/sandbox/bubblewrap-backend.ts",
    name: "BubblewrapBackend.run",
    signature: "async run(command: string, options: SandboxRunOptions)",
    requiredSafeguards: [
      { label: "native fallback", pattern: /nativeBackend\.run\(/ },
      { label: "bounded bubblewrap runner", pattern: /runBwrapSpawn/ },
    ],
  },
  {
    file: "src/sandbox/bubblewrap-backend.ts",
    name: "BubblewrapBackend.runBwrapSpawn",
    signature: "private runBwrapSpawn(command: string, args: string[], options: SandboxRunOptions)",
    requiredSafeguards: [
      { label: "async spawn", pattern: /spawn\(/ },
      { label: "timeoutMs enforcement", pattern: /options\.timeoutMs/ },
      { label: "maxBuffer enforcement", pattern: /options\.maxBuffer/ },
    ],
  },
  {
    file: "src/sandbox/sandbox-exec-backend.ts",
    name: "SandboxExecBackend.run",
    signature: "async run(command: string, options: SandboxRunOptions)",
    requiredSafeguards: [
      { label: "async exec", pattern: /execAsync\(/ },
      { label: "timeout option", pattern: /timeout\s*:\s*options\.timeoutMs/ },
      { label: "maxBuffer option", pattern: /maxBuffer\s*:\s*options\.maxBuffer/ },
      { label: "abort signal", pattern: /signal\s*:\s*options\.signal/ },
    ],
  },
];

function readSource(file: string): string {
  return readFileSync(resolve(process.cwd(), file), "utf-8");
}

function sliceFunctionBody(source: string, signature: string, label: string): string {
  const signatureIndex = source.indexOf(signature);
  expect(signatureIndex, `${label}: registry signature must resolve to a real function`).toBeGreaterThanOrEqual(0);

  const paramsStart = source.indexOf("(", signatureIndex);
  expect(paramsStart, `${label}: function signature must have parameters`).toBeGreaterThanOrEqual(0);

  let parenDepth = 0;
  let paramsEnd = -1;
  for (let index = paramsStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "(") parenDepth += 1;
    if (char === ")") {
      parenDepth -= 1;
      if (parenDepth === 0) {
        paramsEnd = index;
        break;
      }
    }
  }
  expect(paramsEnd, `${label}: function parameters must close`).toBeGreaterThanOrEqual(0);

  let angleDepth = 0;
  let openBraceIndex = -1;
  for (let index = paramsEnd + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === "<") angleDepth += 1;
    if (char === ">" && angleDepth > 0) angleDepth -= 1;
    if (char === "{" && angleDepth === 0) {
      openBraceIndex = index;
      break;
    }
  }
  expect(openBraceIndex, `${label}: function body must have an opening brace`).toBeGreaterThanOrEqual(0);

  let depth = 0;
  let state: "code" | "single" | "double" | "template" | "line-comment" | "block-comment" = "code";
  let escaped = false;

  for (let index = openBraceIndex; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (state === "line-comment") {
      if (char === "\n") state = "code";
      continue;
    }
    if (state === "block-comment") {
      if (char === "*" && next === "/") {
        state = "code";
        index += 1;
      }
      continue;
    }
    if (state === "single" || state === "double" || state === "template") {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if ((state === "single" && char === "'") || (state === "double" && char === '"') || (state === "template" && char === "`")) {
        state = "code";
      }
      continue;
    }

    if (char === "/" && next === "/") {
      state = "line-comment";
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      state = "block-comment";
      index += 1;
      continue;
    }
    if (char === "'") {
      state = "single";
      continue;
    }
    if (char === '"') {
      state = "double";
      continue;
    }
    if (char === "`") {
      state = "template";
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openBraceIndex, index + 1);
      }
    }
  }

  throw new Error(`${label}: function body did not close; registry may be stale`);
}

function assertGuardInvariants(body: string, entryName: string, requiredSafeguards: GuardEntry["requiredSafeguards"]): void {
  expect(body, `${entryName}: protected body must not call execSync`).not.toContain("execSync(");
  expect(body, `${entryName}: protected body must not reference execSync at all`).not.toMatch(/\bexecSync\b/);

  for (const safeguard of requiredSafeguards) {
    expect(body, `${entryName}: missing required safeguard ${safeguard.label}`).toMatch(safeguard.pattern);
  }
}

describe("user-configured command static execSync guard", () => {
  it("protects the complete registry and required async safeguards", () => {
    expect(protectedCommandPaths.length, "registry must enumerate the protected command paths").toBeGreaterThan(0);

    for (const entry of protectedCommandPaths) {
      const source = readSource(entry.file);
      const body = sliceFunctionBody(source, entry.signature, `${entry.file} :: ${entry.name}`);
      expect(body.trim().length, `${entry.file} :: ${entry.name}: sliced body must be non-empty`).toBeGreaterThan(2);
      assertGuardInvariants(body, `${entry.file} :: ${entry.name}`, entry.requiredSafeguards);
    }
  });

  it("bites on synthetic execSync and missing-safeguard regressions", () => {
    const requiredSafeguards = [{ label: "timeout option", pattern: /timeout\s*:/ }];

    expect(() => assertGuardInvariants("{ execSync('pnpm test'); timeout: 1000; }", "synthetic execSync", requiredSafeguards)).toThrow(/execSync/);
    expect(() => assertGuardInvariants("{ execAsync('pnpm test'); }", "synthetic missing timeout", requiredSafeguards)).toThrow(/timeout option/);
    expect(() => assertGuardInvariants("{ execAsync('pnpm test', { timeout: 1000 }); }", "synthetic safe", requiredSafeguards)).not.toThrow();
  });

  it("does not false-positive on allowed git-plumbing execSync outside protected slices", () => {
    const executorSource = readSource("src/executor.ts");
    expect(executorSource, "executor keeps a git-only execSync ancestry check outside the protected configured-command helper").toContain("execSync(`git merge-base --is-ancestor");

    const configuredCommand = protectedCommandPaths.find((entry) => entry.file === "src/executor.ts" && entry.name === "runConfiguredCommand");
    expect(configuredCommand, "executor runConfiguredCommand registry entry must exist").toBeDefined();
    const body = sliceFunctionBody(executorSource, configuredCommand!.signature, "src/executor.ts :: runConfiguredCommand");
    assertGuardInvariants(body, "src/executor.ts :: runConfiguredCommand", configuredCommand!.requiredSafeguards);
  });
});
