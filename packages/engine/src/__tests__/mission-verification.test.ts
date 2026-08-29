/**
 * Tests for the behavioral-verification capability (U3).
 *
 * Covers the isolation/safety contract before any real execution:
 * - command-template rejects shell metacharacters (R19)
 * - fail-closed when no isolating sandbox backend is available (R18)
 * - env scrubbed to a minimal allowlist (R18)
 * - pass-on-both regression test rejected (R5/AE5)
 * - source tree git-clean post-condition asserted (R17)
 * - no integration SHA → inconclusive (R11 fail-closed)
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  validateTestPath,
  buildVerificationCommand,
  selectIsolatingBackend,
  scrubEnv,
  VERIFICATION_ENV_ALLOWLIST,
  TestExecutionVerificationCapability,
  type CheckoutMaterializer,
  type IsolatingBackendProbe,
  type VerificationRequest,
} from "../missions/mission-verification.js";
import {
  __resetSandboxBackendForTests,
  type SandboxBackend,
  type SandboxStreamingResult,
} from "../sandbox/index.js";
import type { TaskStore } from "@fusion/core";

afterEach(() => {
  __resetSandboxBackendForTests();
  vi.restoreAllMocks();
});

// ── validateTestPath (R19) ────────────────────────────────────────────────────

describe("validateTestPath", () => {
  it("accepts a plain relative test path", () => {
    expect(validateTestPath("packages/engine/src/__tests__/foo.test.ts")).toBe(
      "packages/engine/src/__tests__/foo.test.ts",
    );
  });

  it.each([
    "foo.test.ts; rm -rf /",
    "foo.test.ts && curl evil",
    "foo.test.ts | cat",
    "$(whoami).test.ts",
    "`id`.test.ts",
    "foo.test.ts\nrm x",
    "a${b}.test.ts",
    "foo>out.test.ts",
  ])("rejects shell metacharacters: %s", (p) => {
    expect(validateTestPath(p)).toBeNull();
  });

  it("rejects absolute paths, parent escapes, flag-like, and non-strings", () => {
    expect(validateTestPath("/etc/passwd")).toBeNull();
    expect(validateTestPath("../../etc/passwd")).toBeNull();
    expect(validateTestPath("a/../../b")).toBeNull();
    expect(validateTestPath("--config=evil")).toBeNull();
    expect(validateTestPath("")).toBeNull();
    expect(validateTestPath(42 as unknown)).toBeNull();
  });
});

describe("buildVerificationCommand", () => {
  it("substitutes a validated test path into the template", () => {
    expect(buildVerificationCommand("pnpm vitest run {testPath}", "src/a.test.ts")).toBe(
      "pnpm vitest run src/a.test.ts",
    );
  });

  it("produces a whole-suite command when no path is supplied", () => {
    expect(buildVerificationCommand("pnpm vitest run {testPath}")).toBe("pnpm vitest run");
  });

  it("throws if asked to substitute an unsafe path (defense in depth)", () => {
    expect(() => buildVerificationCommand("pnpm vitest run {testPath}", "a; rm -rf /")).toThrow();
  });
});

// ── selectIsolatingBackend (R18 fail-closed) ───────────────────────────────────

describe("selectIsolatingBackend", () => {
  it("selects bubblewrap on linux when available", () => {
    expect(
      selectIsolatingBackend({ platform: "linux", bubblewrapAvailable: true, sandboxExecAvailable: false }).backendId,
    ).toBe("bubblewrap");
  });

  it("selects sandbox-exec on darwin when available", () => {
    expect(
      selectIsolatingBackend({ platform: "darwin", bubblewrapAvailable: false, sandboxExecAvailable: true }).backendId,
    ).toBe("sandbox-exec");
  });

  it("fails closed (null) when no isolating backend is available", () => {
    const sel = selectIsolatingBackend({ platform: "linux", bubblewrapAvailable: false, sandboxExecAvailable: false });
    expect(sel.backendId).toBeNull();
    expect(sel.reason).toMatch(/no isolating sandbox backend/);
  });
});

// ── scrubEnv (R18) ─────────────────────────────────────────────────────────────

describe("scrubEnv", () => {
  it("keeps only allowlisted keys and forces CI=1", () => {
    const result = scrubEnv({
      PATH: "/usr/bin",
      HOME: "/home/u",
      ANTHROPIC_API_KEY: "secret",
      DATABASE_URL: "postgres://secret",
      AWS_SECRET_ACCESS_KEY: "secret",
    });
    expect(result.PATH).toBe("/usr/bin");
    expect(result.HOME).toBe("/home/u");
    expect(result.CI).toBe("1");
    expect(result.ANTHROPIC_API_KEY).toBeUndefined();
    expect(result.DATABASE_URL).toBeUndefined();
    expect(result.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it("only ever emits allowlisted keys plus CI", () => {
    const result = scrubEnv({ FOO: "x", BAR: "y", PATH: "/bin" });
    const allowed = new Set<string>([...VERIFICATION_ENV_ALLOWLIST, "CI"]);
    for (const k of Object.keys(result)) {
      expect(allowed.has(k)).toBe(true);
    }
  });
});

// ── TestExecutionVerificationCapability ────────────────────────────────────────

function makeMockStore(): TaskStore {
  return {
    logEntry: vi.fn().mockResolvedValue(undefined),
    appendAgentLog: vi.fn().mockResolvedValue(undefined),
  } as unknown as TaskStore;
}

/** A fake materializer that records dispose/clean calls without touching git. */
function makeFakeMaterializer(): CheckoutMaterializer & {
  disposed: number;
  cleanCalls: number;
  setDirty(dirty: boolean): void;
} {
  let dirty = false;
  const state = {
    disposed: 0,
    cleanCalls: 0,
    setDirty(d: boolean) {
      dirty = d;
    },
    async materialize(_rootDir: string, _revision: string) {
      return {
        dir: "/tmp/fake-checkout",
        dispose: async () => {
          state.disposed += 1;
        },
      };
    },
    async assertSourceClean(_rootDir: string) {
      state.cleanCalls += 1;
      if (dirty) throw new Error("Source tree is not git-clean after verification run");
    },
  };
  return state;
}

/** A sandbox backend whose runStreaming returns a scripted outcome. */
function makeScriptedBackend(outcomes: SandboxStreamingResult[]): SandboxBackend {
  let i = 0;
  return {
    capabilities: () => ({
      id: "bubblewrap",
      supportsNetworkPolicy: true,
      supportsFilesystemPolicy: true,
      supportsStreaming: true,
      platform: "any",
    }),
    prepare: vi.fn().mockResolvedValue(undefined),
    run: vi.fn(),
    runStreaming: vi.fn(async () => {
      const out = outcomes[Math.min(i, outcomes.length - 1)];
      i += 1;
      return out;
    }),
    dispose: vi.fn().mockResolvedValue(undefined),
  } as unknown as SandboxBackend;
}

const isolatingProbe = (): Promise<IsolatingBackendProbe> =>
  Promise.resolve({ platform: "linux", bubblewrapAvailable: true, sandboxExecAvailable: false });

function baseRequest(overrides: Partial<VerificationRequest> = {}): VerificationRequest {
  return {
    assertionId: "CA-1",
    assertion: "the bug no longer reproduces",
    taskId: "FN-1",
    integrationSha: "abc123",
    ...overrides,
  };
}

describe("TestExecutionVerificationCapability", () => {
  it("fails closed to inconclusive when no isolating backend is available (R18)", async () => {
    const materializer = makeFakeMaterializer();
    const cap = new TestExecutionVerificationCapability({
      store: makeMockStore(),
      rootDir: "/repo",
      commandTemplate: "pnpm vitest run {testPath}",
      materializer,
      probeBackends: async () => ({ platform: "linux", bubblewrapAvailable: false, sandboxExecAvailable: false }),
    });

    const outcome = await cap.verifyBehavioralAssertion(baseRequest());
    expect(outcome.verdict).toBe("inconclusive");
    expect(outcome.reason).toMatch(/no isolating sandbox backend/);
    // Never materialized / executed.
    expect(materializer.disposed).toBe(0);
  });

  it("returns inconclusive when no integration SHA is available (R11)", async () => {
    const cap = new TestExecutionVerificationCapability({
      store: makeMockStore(),
      rootDir: "/repo",
      commandTemplate: "pnpm vitest run {testPath}",
      materializer: makeFakeMaterializer(),
      probeBackends: isolatingProbe,
    });
    const outcome = await cap.verifyBehavioralAssertion(baseRequest({ integrationSha: undefined }));
    expect(outcome.verdict).toBe("inconclusive");
    expect(outcome.reason).toMatch(/integration SHA/);
  });

  it("rejects an agent test path with shell metacharacters before execution (R19)", async () => {
    const materializer = makeFakeMaterializer();
    const cap = new TestExecutionVerificationCapability({
      store: makeMockStore(),
      rootDir: "/repo",
      commandTemplate: "pnpm vitest run {testPath}",
      materializer,
      probeBackends: isolatingProbe,
    });
    const outcome = await cap.verifyBehavioralAssertion(
      baseRequest({ proof: { testFilePath: "a.test.ts; rm -rf /" } }),
    );
    expect(outcome.verdict).toBe("inconclusive");
    expect(outcome.reason).toMatch(/shell metacharacters|rejected/);
    expect(materializer.disposed).toBe(0);
  });

  it("passes when the whole-suite run succeeds, and asserts source git-clean (R17)", async () => {
    const materializer = makeFakeMaterializer();
    const cap = new TestExecutionVerificationCapability({
      store: makeMockStore(),
      rootDir: "/repo",
      commandTemplate: "pnpm vitest run {testPath}",
      materializer,
      probeBackends: isolatingProbe,
      backendFactory: () =>
        makeScriptedBackend([{ outcome: "success", stdout: "ok", stderr: "", bufferOverflow: false }]),
    });
    const outcome = await cap.verifyBehavioralAssertion(baseRequest());
    expect(outcome.verdict).toBe("pass");
    expect(materializer.disposed).toBe(1);
    expect(materializer.cleanCalls).toBe(1);
  });

  it("rejects a regression test that passes on BOTH baseline and implementation (R5/AE5)", async () => {
    const materializer = makeFakeMaterializer();
    const cap = new TestExecutionVerificationCapability({
      store: makeMockStore(),
      rootDir: "/repo",
      commandTemplate: "pnpm vitest run {testPath}",
      materializer,
      probeBackends: isolatingProbe,
      // impl run (1st) success, baseline run (2nd) success → pass-on-both.
      backendFactory: () =>
        makeScriptedBackend([
          { outcome: "success", stdout: "ok", stderr: "", bufferOverflow: false },
          { outcome: "success", stdout: "ok", stderr: "", bufferOverflow: false },
        ]),
    });
    const outcome = await cap.verifyBehavioralAssertion(
      baseRequest({ proof: { testFilePath: "src/a.test.ts" }, mergeBaseSha: "base000" }),
    );
    expect(outcome.verdict).toBe("fail");
    expect(outcome.reason).toMatch(/both/);
  });

  it("passes when a regression test fails on baseline and passes on implementation (R5)", async () => {
    const materializer = makeFakeMaterializer();
    const cap = new TestExecutionVerificationCapability({
      store: makeMockStore(),
      rootDir: "/repo",
      commandTemplate: "pnpm vitest run {testPath}",
      materializer,
      probeBackends: isolatingProbe,
      // impl run (1st) success, baseline run (2nd) non-zero-exit → genuine proof.
      backendFactory: () =>
        makeScriptedBackend([
          { outcome: "success", stdout: "ok", stderr: "", bufferOverflow: false },
          { outcome: "non-zero-exit", stdout: "", stderr: "boom", exitCode: 1, signal: null },
        ]),
    });
    const outcome = await cap.verifyBehavioralAssertion(
      baseRequest({ proof: { testFilePath: "src/a.test.ts" }, mergeBaseSha: "base000" }),
    );
    expect(outcome.verdict).toBe("pass");
  });

  it("inconclusive when the run times out (R9), still asserts source clean", async () => {
    const materializer = makeFakeMaterializer();
    const cap = new TestExecutionVerificationCapability({
      store: makeMockStore(),
      rootDir: "/repo",
      commandTemplate: "pnpm vitest run {testPath}",
      materializer,
      probeBackends: isolatingProbe,
      backendFactory: () =>
        makeScriptedBackend([{ outcome: "timeout", stdout: "", stderr: "", timeoutMs: 1000 }]),
    });
    // A timeout surfaces as a thrown ETIMEDOUT inside runVerificationCommand,
    // which the capability catches and maps deterministically to inconclusive.
    // An infra timeout must never be surfaced as a behavioral fail — the contract
    // is that timeout/setup failures stay inconclusive.
    const outcome = await cap.verifyBehavioralAssertion(baseRequest());
    expect(outcome.verdict).toBe("inconclusive");
    expect(materializer.cleanCalls).toBe(1);
  });

  it("fails closed to inconclusive if the source tree is dirty after a run (R17 post-condition)", async () => {
    const materializer = makeFakeMaterializer();
    materializer.setDirty(true);
    const cap = new TestExecutionVerificationCapability({
      store: makeMockStore(),
      rootDir: "/repo",
      commandTemplate: "pnpm vitest run {testPath}",
      materializer,
      probeBackends: isolatingProbe,
      backendFactory: () =>
        makeScriptedBackend([{ outcome: "success", stdout: "ok", stderr: "", bufferOverflow: false }]),
    });
    // A dirty tree means verification mutated the source — never trust the
    // verdict; fail closed to inconclusive (the post-condition is checked
    // outside finally so it cannot mask the verdict via an unsafe throw).
    const outcome = await cap.verifyBehavioralAssertion(baseRequest());
    expect(outcome.verdict).toBe("inconclusive");
    expect(outcome.reason).toMatch(/git-clean/);
  });
});
