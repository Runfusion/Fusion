/**
 * Mission behavioral-verification capability (U3).
 *
 * The Validator Run's read-only AI judge cannot run code, so its "pass" on a
 * *behavioral* assertion is advisory only (U2). This module supplies the
 * authoritative, NON-MUTATING verification step that confirms a behavioral/bug
 * assertion by exercising the implemented code.
 *
 * Channels:
 * - **test-execution** (this unit): run the project's scoped test suite / an
 *   agent-supplied regression test against a disposable checkout at a trusted
 *   revision, through an explicit isolating sandbox backend.
 * - **app-driving** (later unit U5/U8): drive a running app instance. Not
 *   implemented here — the capability surface is structured so it can be added
 *   without reshaping callers.
 *
 * Safety invariants enforced here (the boundary, not a convention):
 * - R18: execute under an *isolating* sandbox backend (bubblewrap / sandbox-exec)
 *   with a scrubbed env allowlist; FAIL CLOSED to a non-pass when no isolating
 *   backend is available — never fall through to the unrestricted native backend.
 * - R19: the command is built from a fixed, system-owned template into which only
 *   a validated test-file path is substituted; shell metacharacters are rejected.
 * - R11/R17: verification runs against a disposable checkout at the integration
 *   SHA (never the pruned live worktree, never the repo root); the source tree
 *   that feeds diff/merge is asserted git-clean after a run.
 * - R5/AE5: agent-supplied proof must FAIL on a second disposable checkout at
 *   `git merge-base` (a revision the agent does not control) and PASS on the
 *   implementation; a test that passes on both is rejected.
 * - R9: inconclusive / timeout / setup failure resolves to a non-pass.
 * - R10: no board / mission writes happen here.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { TaskStore } from "@fusion/core";
import type { SandboxCapabilities } from "./sandbox/index.js";
import { __setSandboxBackendForTests, resolveSandboxBackend } from "./sandbox/index.js";
import type { SandboxBackend } from "./sandbox/index.js";
import { detectBwrap } from "./sandbox/bubblewrap-detect.js";
import { detectSandboxExec } from "./sandbox/sandbox-exec-detect.js";
import { runVerificationCommand } from "./verification-utils.js";
import { createLogger } from "./logger.js";

const execAsync = promisify(exec);
const verifyLog = createLogger("mission-verify");

// ── Verdict types ───────────────────────────────────────────────────────────

/**
 * Outcome of a verification run for a single behavioral assertion.
 *
 * - `pass`: behavior confirmed by execution.
 * - `fail`: behavior observed wrong (the defect still reproduces / proof rejected).
 * - `inconclusive`: verification could not run or conclude (no isolating backend,
 *   timeout, setup failure, rejected/invalid proof input). First-class and
 *   distinct from `fail`: it must NOT spawn remediation (handled by later units),
 *   but in this unit it never resolves to a default pass either.
 */
export type VerificationVerdict = "pass" | "fail" | "inconclusive";

/** Why a verification run reached its verdict (for durable observability later). */
export interface VerificationOutcome {
  verdict: VerificationVerdict;
  /** Human-readable reason, suitable for surfacing in a failure record. */
  reason: string;
  /** The assertion this outcome corresponds to. */
  assertionId: string;
  /** Optional summarized command output for the failure record. */
  detail?: string;
}

/** Shape of agent-supplied executable proof (a regression test). */
export interface VerificationProof {
  /**
   * Path to the regression test file, relative to the checkout root. Validated
   * to reject shell metacharacters and path escapes before use (R19).
   */
  testFilePath: string;
}

/**
 * Which evidence channel(s) confirm a behavioral assertion.
 *
 * - `test`: code-level behavior, confirmed by running the suite / a regression
 *   test against a disposable checkout (U3 test-execution channel).
 * - `app`: UI/bug behavior, confirmed by driving a running app instance
 *   (U4 isolated launch + U8 driver).
 * - `both`: an assertion that is only confirmed when BOTH channels confirm it.
 *
 * Defaults conservatively to `test` when unspecified — the existing
 * test-execution behavior — so callers that do not classify an assertion keep
 * working unchanged.
 */
export type VerificationChannel = "test" | "app" | "both";

/**
 * Describes the observable UI behavior an app-driving verification must check.
 *
 * The driver navigates to `path` (relative to the isolated app's base URL) and
 * observes `selector`. `expectation` declares what a PASS looks like:
 *
 * - `present`: the assertion claims a feature/element should be present, so an
 *   `observe`→`found` is a PASS and an `observe`→`absent` is a FAIL.
 * - `absent`: the assertion claims a bug no longer reproduces, so an
 *   `observe`→`absent` is a PASS and an `observe`→`found` is a FAIL.
 *
 * In both cases a driver `inconclusive` (unavailable / un-exercisable) maps to
 * an inconclusive verdict, never pass/fail.
 */
export interface UiAssertionSpec {
  /** Path relative to the isolated app base URL, e.g. "/board". */
  path: string;
  /** Selector whose presence/absence encodes the behavior. */
  selector: string;
  /**
   * What a PASS looks like:
   * - `present`: element should be there (feature present).
   * - `absent`: element should be gone (bug no longer reproduces).
   */
  expectation: "present" | "absent";
  /** Optional per-operation timeout override. */
  timeoutMs?: number;
}

/** Input describing a single behavioral assertion to verify. */
export interface VerificationRequest {
  assertionId: string;
  /** The assertion text (for logging / reason building). */
  assertion: string;
  /** Board task id associated with the feature, used for verification-command logging. */
  taskId?: string;
  /**
   * Which evidence channel(s) confirm this assertion. Defaults to `test`
   * (the existing test-execution behavior) when unspecified.
   */
  channel?: VerificationChannel;
  /**
   * The UI behavior the app-driving channel must reproduce. Required when
   * `channel` is `app` or `both`; absent for `test`. When the channel needs app
   * driving but this is missing, the app channel resolves to inconclusive
   * (structurally un-exercisable), never a default pass/fail.
   */
  ui?: UiAssertionSpec;
  /**
   * The trusted revision (integration SHA) whose checkout the implementation is
   * verified against. When absent, verification is inconclusive (cannot
   * materialize a trusted checkout).
   */
  integrationSha?: string;
  /**
   * The `git merge-base` revision (feature branch vs base branch) used as the
   * pre-fix baseline for agent-supplied proof. Not agent-controlled.
   */
  mergeBaseSha?: string;
  /** Optional agent-supplied executable proof. */
  proof?: VerificationProof;
  /** Abort signal to bound the run. */
  signal?: AbortSignal;
}

/**
 * Injected verification capability. Mirrors the `createFnAgent` injection
 * pattern so MissionExecutionLoop can swap a real implementation for a mock in
 * tests. Optional on the loop: when absent, behavioral assertions resolve to a
 * non-pass without invoking any execution (preserving existing behavior for
 * call sites that do not inject a capability).
 */
export interface VerificationCapability {
  verifyBehavioralAssertion(request: VerificationRequest): Promise<VerificationOutcome>;
}

// ── Command-template safety (R19) ─────────────────────────────────────────────

/**
 * Characters that could break out of the fixed command template or inject
 * additional shell behavior. Agent-supplied test paths containing any of these
 * are rejected before execution.
 */
const SHELL_METACHARACTERS = /[;&|`$(){}<>!*?\[\]\\"'\n\r\t\0]/;

/**
 * Validate an agent-supplied test-file path. Returns the normalized path when
 * safe, or `null` when it must be rejected (R19).
 *
 * Rejects: empty, absolute paths, parent-dir escapes, shell metacharacters,
 * and leading dashes (which could be read as command flags).
 */
export function validateTestPath(rawPath: unknown): string | null {
  if (typeof rawPath !== "string") return null;
  const path = rawPath.trim();
  if (path.length === 0) return null;
  if (SHELL_METACHARACTERS.test(path)) return null;
  if (path.startsWith("/")) return null; // must be relative to the checkout
  if (path.startsWith("-")) return null; // could be parsed as a flag
  // Reject parent-dir escapes (any `..` segment).
  const segments = path.split("/");
  if (segments.some((seg) => seg === "..")) return null;
  return path;
}

/**
 * Build the verification command from the fixed system-owned template. Only a
 * pre-validated test path may be substituted (R19). Callers MUST pass a path
 * already run through {@link validateTestPath}; this function re-checks and
 * throws on violation as a defense-in-depth guard.
 */
export function buildVerificationCommand(template: string, validatedTestPath?: string): string {
  if (validatedTestPath !== undefined) {
    if (validateTestPath(validatedTestPath) === null) {
      throw new Error(`Refusing to build verification command: invalid test path ${JSON.stringify(validatedTestPath)}`);
    }
    if (!template.includes("{testPath}")) {
      throw new Error("Verification command template must contain a {testPath} placeholder when a test path is supplied");
    }
    return template.replace("{testPath}", validatedTestPath);
  }
  // Whole-suite invocation: the template must not reference a test path.
  return template.replace("{testPath}", "").trimEnd();
}

// ── Isolating-backend selection (R18, fail-closed) ────────────────────────────

/**
 * Result of selecting an isolating sandbox backend for verification.
 */
export interface IsolatingBackendSelection {
  /** The backend id to request from `resolveSandboxBackend`, or null if none. */
  backendId: SandboxCapabilities["id"] | null;
  /** Why no isolating backend is available (when backendId is null). */
  reason?: string;
}

/**
 * Describes the detected availability of isolating backends on this host.
 * Injectable for tests so we don't shell out to detect bwrap/sandbox-exec.
 */
export interface IsolatingBackendProbe {
  platform: NodeJS.Platform;
  bubblewrapAvailable: boolean;
  sandboxExecAvailable: boolean;
}

/**
 * Choose an isolating backend, failing closed. Returns `backendId: null` (a
 * non-pass signal) when no isolating backend is available — verification must
 * NEVER fall through to the unrestricted native backend (R18).
 */
export function selectIsolatingBackend(probe: IsolatingBackendProbe): IsolatingBackendSelection {
  if (probe.platform === "linux" && probe.bubblewrapAvailable) {
    return { backendId: "bubblewrap" };
  }
  if (probe.platform === "darwin" && probe.sandboxExecAvailable) {
    return { backendId: "sandbox-exec" };
  }
  return {
    backendId: null,
    reason: `no isolating sandbox backend available (platform=${probe.platform}, bwrap=${probe.bubblewrapAvailable}, sandbox-exec=${probe.sandboxExecAvailable})`,
  };
}

// ── Environment scrubbing (R18) ───────────────────────────────────────────────

/**
 * Environment variables permitted into the verification child process. Anything
 * not on the allowlist (API keys, auth tokens, DB credentials, agent logs) is
 * dropped so agent-authored code executes with a minimal environment.
 */
export const VERIFICATION_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TERM",
  "NODE_ENV",
  // pnpm / corepack need these to resolve the package manager in the checkout.
  "PNPM_HOME",
  "COREPACK_HOME",
  "npm_config_registry",
] as const;

/**
 * Produce a scrubbed environment containing only allowlisted keys from the
 * source environment, with `CI=1` forced for deterministic test runs.
 */
export function scrubEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const scrubbed: NodeJS.ProcessEnv = {};
  for (const key of VERIFICATION_ENV_ALLOWLIST) {
    const value = source[key];
    if (value !== undefined) {
      scrubbed[key] = value;
    }
  }
  // Force deterministic, non-interactive execution.
  scrubbed.CI = "1";
  return scrubbed;
}

// ── Disposable checkout materialization (R11/R17) ─────────────────────────────

/** A disposable checkout the verification run can execute against. */
export interface DisposableCheckout {
  /** Absolute path to the checkout root (under a run-unique tmpdir). */
  dir: string;
  /** Tear the checkout down unconditionally (idempotent). */
  dispose(): Promise<void>;
}

/**
 * Materializes disposable checkouts at a trusted revision. Injectable so tests
 * can supply a fixture checkout without invoking git.
 */
export interface CheckoutMaterializer {
  /**
   * Create a disposable checkout of `rootDir` at `revision` under a run-unique
   * tmpdir. The implementation MUST NOT mutate the source tree at `rootDir`.
   */
  materialize(rootDir: string, revision: string): Promise<DisposableCheckout>;
  /**
   * Assert that the source tree feeding diff/merge is git-clean (byte-identical)
   * — the R17 post-condition. Throws if dirty.
   */
  assertSourceClean(rootDir: string): Promise<void>;
}

/**
 * Default git-backed materializer: `git worktree add --detach <tmp> <revision>`
 * produces an isolated checkout without touching the source working tree, and
 * `git status --porcelain` on the source confirms cleanliness afterwards.
 */
export class GitCheckoutMaterializer implements CheckoutMaterializer {
  async materialize(rootDir: string, revision: string): Promise<DisposableCheckout> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fn-verify-"));
    // `git worktree add --detach` checks out the revision into a throwaway dir
    // without modifying the source working tree.
    await execAsync(`git worktree add --detach ${JSON.stringify(dir)} ${JSON.stringify(revision)}`, {
      cwd: rootDir,
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return {
      dir,
      dispose: async () => {
        try {
          await execAsync(`git worktree remove --force ${JSON.stringify(dir)}`, {
            cwd: rootDir,
            timeout: 30_000,
          });
        } catch (err) {
          verifyLog.warn(`Failed to remove verification worktree ${dir}:`, err);
        }
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      },
    };
  }

  async assertSourceClean(rootDir: string): Promise<void> {
    const { stdout } = await execAsync("git status --porcelain", {
      cwd: rootDir,
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (stdout.trim().length > 0) {
      throw new Error(`Source tree is not git-clean after verification run:\n${stdout.trim()}`);
    }
  }
}

/** Probe the host for isolating-backend availability (cached by the detectors). */
async function probeIsolatingBackends(): Promise<IsolatingBackendProbe> {
  const [bwrap, sandboxExec] = await Promise.all([
    detectBwrap().catch(() => ({ available: false })),
    detectSandboxExec().catch(() => ({ available: false })),
  ]);
  return {
    platform: process.platform,
    bubblewrapAvailable: bwrap.available,
    sandboxExecAvailable: sandboxExec.available,
  };
}

// ── Test-execution verification capability ────────────────────────────────────

export interface TestExecutionVerificationOptions {
  /** Task store, reused by runVerificationCommand for command logging. */
  store: TaskStore;
  /** Repo root whose source tree must remain git-clean. */
  rootDir: string;
  /**
   * Fixed, system-owned command template. Must contain `{testPath}` when an
   * agent-supplied proof path is used. Example: `pnpm vitest run {testPath}`.
   */
  commandTemplate: string;
  /** Injectable checkout materializer (defaults to git-backed). */
  materializer?: CheckoutMaterializer;
  /** Injectable backend probe (defaults to host detection). */
  probeBackends?: () => Promise<IsolatingBackendProbe>;
  /**
   * Injectable factory for the isolating sandbox backend, given the selected
   * backend id. Defaults to `resolveSandboxBackend({ backendId })`. Injectable so
   * tests can supply a scripted backend without mutating global sandbox state.
   */
  backendFactory?: (backendId: SandboxCapabilities["id"]) => SandboxBackend;
  /** Injectable env source (defaults to process.env). */
  envSource?: NodeJS.ProcessEnv;
}

/**
 * The test-execution channel of the verification run. Confirms a behavioral
 * assertion by running the suite / an agent-supplied regression test against a
 * disposable checkout at the integration SHA, under an isolating sandbox
 * backend with a scrubbed env. Fails closed to a non-pass on any setup failure.
 *
 * App-driving is NOT handled here; a later unit dispatches UI/bug assertions to
 * an app-driving channel. This class is the canonical pattern that channel will
 * mirror.
 */
export class TestExecutionVerificationCapability implements VerificationCapability {
  private readonly store: TaskStore;
  private readonly rootDir: string;
  private readonly commandTemplate: string;
  private readonly materializer: CheckoutMaterializer;
  private readonly probeBackends: () => Promise<IsolatingBackendProbe>;
  private readonly backendFactory: (backendId: SandboxCapabilities["id"]) => SandboxBackend;
  private readonly envSource: NodeJS.ProcessEnv;

  constructor(options: TestExecutionVerificationOptions) {
    this.store = options.store;
    this.rootDir = options.rootDir;
    this.commandTemplate = options.commandTemplate;
    this.materializer = options.materializer ?? new GitCheckoutMaterializer();
    this.probeBackends = options.probeBackends ?? probeIsolatingBackends;
    this.backendFactory = options.backendFactory ?? ((backendId) => resolveSandboxBackend({ backendId }));
    this.envSource = options.envSource ?? process.env;
  }

  async verifyBehavioralAssertion(request: VerificationRequest): Promise<VerificationOutcome> {
    const { assertionId } = request;

    // R11: a trusted revision is required to materialize a disposable checkout.
    if (!request.integrationSha) {
      return this.inconclusive(assertionId, "no integration SHA available to materialize a trusted checkout");
    }

    // R19: validate any agent-supplied proof path BEFORE doing any work.
    let validatedTestPath: string | undefined;
    if (request.proof) {
      const safe = validateTestPath(request.proof.testFilePath);
      if (safe === null) {
        return this.inconclusive(
          assertionId,
          `agent-supplied test path rejected (invalid or contains shell metacharacters): ${JSON.stringify(request.proof.testFilePath)}`,
        );
      }
      validatedTestPath = safe;
    }

    // R18: select an isolating backend, fail closed when none is available.
    const probe = await this.probeBackends();
    const selection = selectIsolatingBackend(probe);
    if (selection.backendId === null) {
      return this.inconclusive(assertionId, selection.reason ?? "no isolating sandbox backend available");
    }

    const command = buildVerificationCommand(this.commandTemplate, validatedTestPath);
    const scrubbedEnv = scrubEnv(this.envSource);
    const logTaskId = request.taskId ?? `verify-${assertionId}`;

    // Route runVerificationCommand through the explicitly-selected isolating
    // backend rather than the no-arg native fallback (R18). runVerificationCommand
    // resolves its backend via the no-arg resolveSandboxBackend(), so we pin the
    // selected isolating backend via the test-override hook for the duration of
    // the run and unconditionally restore afterwards.
    const isolating = this.backendFactory(selection.backendId);
    const restoreBackend = () => __setSandboxBackendForTests(null);
    __setSandboxBackendForTests(isolating);

    let implCheckout: DisposableCheckout | undefined;
    let baselineCheckout: DisposableCheckout | undefined;
    try {
      implCheckout = await this.materializer.materialize(this.rootDir, request.integrationSha);

      const implResult = await runVerificationCommand(
        this.store,
        implCheckout.dir,
        logTaskId,
        command,
        "test",
        request.signal,
        verifyLog,
        "reviewer",
        scrubbedEnv,
      );

      // R5/AE5: agent-supplied proof must fail on the merge-base baseline and
      // pass on the implementation. A test that passes on both is not exercising
      // the defect — reject it.
      if (validatedTestPath) {
        if (!request.mergeBaseSha) {
          return this.inconclusive(assertionId, "no merge-base SHA available to validate agent-supplied proof");
        }
        baselineCheckout = await this.materializer.materialize(this.rootDir, request.mergeBaseSha);
        const baselineResult = await runVerificationCommand(
          this.store,
          baselineCheckout.dir,
          logTaskId,
          command,
          "test",
          request.signal,
          verifyLog,
          "reviewer",
          scrubbedEnv,
        );

        if (baselineResult.success && implResult.success) {
          return {
            verdict: "fail",
            assertionId,
            reason: "agent-supplied proof passes on both the pre-fix baseline and the implementation; it does not exercise the defect",
            detail: "pass-on-both rejected (R5/AE5)",
          };
        }
        if (!baselineResult.success && implResult.success) {
          return { verdict: "pass", assertionId, reason: "regression test fails on the pre-fix baseline and passes on the implementation" };
        }
        // Fails on the implementation → defect still reproduces.
        return {
          verdict: "fail",
          assertionId,
          reason: "regression test does not pass on the implementation; behavior not confirmed",
          detail: implResult.stderr || implResult.stdout || undefined,
        };
      }

      // Whole-suite channel: pass only when the suite passes.
      if (implResult.success) {
        return { verdict: "pass", assertionId, reason: "verification suite passed on the implementation checkout" };
      }
      return {
        verdict: "fail",
        assertionId,
        reason: "verification suite failed on the implementation checkout; behavior not confirmed",
        detail: implResult.stderr || implResult.stdout || undefined,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // R9: any setup/exec failure (timeout, abort, materialization error) is a
      // non-pass; we route it to inconclusive (infra, not behavioral).
      return this.inconclusive(assertionId, `verification run could not complete: ${message}`);
    } finally {
      restoreBackend();
      await implCheckout?.dispose();
      await baselineCheckout?.dispose();
      // R17: the source tree feeding diff/merge must be byte-clean afterwards.
      try {
        await this.materializer.assertSourceClean(this.rootDir);
      } catch (cleanErr) {
        verifyLog.error("Verification post-condition violated (source not git-clean):", cleanErr);
        throw cleanErr instanceof Error ? cleanErr : new Error(String(cleanErr));
      }
    }
  }

  private inconclusive(assertionId: string, reason: string): VerificationOutcome {
    return { verdict: "inconclusive", assertionId, reason };
  }
}

// ── App-driving verification channel (U5: U4 launch + U8 driver) ───────────────
//
// UI/bug assertions are confirmed by driving a running app instance rather than
// running a test suite. This channel launches the isolated app (U4) and a
// browser driver (U8), navigates to the assertion's surface, observes the
// encoding selector, and maps the observation to a verdict.
//
// ENGINE↔PLUGIN WIRING (why a structural injected seam, not a direct import):
// the U8 driver lives in `@fusion-plugin-examples/agent-browser`, on which the
// engine has NO package dependency (the plugin depends on plugin-sdk, not the
// reverse). A direct `import` would invert that and couple the engine to a
// bundled plugin. Instead this channel takes an injected `AppDrivingDeps` seam
// whose method shapes match `launchIsolatedApp` (U4) and `launchBrowserDriver`
// (U8) STRUCTURALLY — so the real wiring (constructed where the loop is built)
// passes the plugin's `launchBrowserDriver` + the harness's `launchIsolatedApp`,
// while merge-gate tests pass a mock. This mirrors the `CheckoutMaterializer` /
// `backendFactory` injection already used by the test-execution channel and the
// `createFnAgent` injection pattern, and keeps the engine decoupled + testable.

/**
 * The slice of the U8 driver session this channel uses. Declared structurally so
 * the engine does not import the plugin; the real session (from
 * `launchBrowserDriver`) satisfies it.
 */
export interface AppDriverSession {
  navigate(
    url: string,
    opts?: { timeoutMs?: number },
  ): Promise<{ status: "ok"; url: string } | { status: "inconclusive"; reason: string; detail: string }>;
  observe(
    selector: string,
    opts?: { timeoutMs?: number; expectAbsent?: boolean },
  ): Promise<
    | { status: "found"; text: string; url: string }
    | { status: "absent"; url: string }
    | { status: "inconclusive"; reason: string; detail: string }
  >;
  dispose(): Promise<void>;
}

/** Result of attempting to acquire a driver session (structural mirror of U8's `DriverLaunchResult`). */
export type AppDriverLaunchResult =
  | { status: "ready"; session: AppDriverSession }
  | { status: "inconclusive"; reason: string; detail: string };

/** A launched isolated app instance (structural mirror of U4's `IsolatedApp`). */
export interface IsolatedAppInstance {
  baseUrl: string;
  dispose(): Promise<void>;
}

/**
 * Injected dependencies for the app-driving channel. The real implementation
 * wires `launchApp` → U4 `launchIsolatedApp` and `launchDriver` → U8
 * `launchBrowserDriver`; tests inject mocks so no real app/browser is launched.
 */
export interface AppDrivingDeps {
  /** Launch an isolated app instance (R11/R13: disposable, isolated, fresh bundle). */
  launchApp(signal?: AbortSignal): Promise<IsolatedAppInstance>;
  /** Acquire a driver session targeting the isolated instance. */
  launchDriver(baseUrl: string, signal?: AbortSignal): Promise<AppDriverLaunchResult>;
}

export interface AppDrivingVerificationOptions {
  deps: AppDrivingDeps;
}

/**
 * The app-driving channel of the verification run.
 *
 * Outcome mapping (R21) — the load-bearing table:
 *
 *  | driver result            | expectation=`present`        | expectation=`absent`         |
 *  | ------------------------ | ---------------------------- | ---------------------------- |
 *  | observe → `found`        | PASS (feature present)       | FAIL (bug still reproduces)  |
 *  | observe → `absent`       | FAIL (feature missing)       | PASS (bug no longer repros)  |
 *  | observe → `inconclusive` | INCONCLUSIVE                 | INCONCLUSIVE                 |
 *  | driver launch failed     | INCONCLUSIVE                 | INCONCLUSIVE                 |
 *  | app launch failed        | INCONCLUSIVE                 | INCONCLUSIVE                 |
 *  | navigate → `inconclusive`| INCONCLUSIVE                 | INCONCLUSIVE                 |
 *  | no `ui` spec supplied    | INCONCLUSIVE (un-exercisable)| INCONCLUSIVE (un-exercisable)|
 *
 * A driver `inconclusive` is ALWAYS inconclusive (never a default pass, never an
 * auto-fail). Only a real `found`/`absent` observation produces pass/fail.
 */
export class AppDrivingVerificationCapability implements VerificationCapability {
  private readonly deps: AppDrivingDeps;

  constructor(options: AppDrivingVerificationOptions) {
    this.deps = options.deps;
  }

  async verifyBehavioralAssertion(request: VerificationRequest): Promise<VerificationOutcome> {
    const { assertionId } = request;
    const spec = request.ui;
    if (!spec) {
      return {
        verdict: "inconclusive",
        assertionId,
        reason: "app-driving channel selected but no UI assertion spec was supplied (structurally un-exercisable)",
      };
    }

    let app: IsolatedAppInstance | undefined;
    let session: AppDriverSession | undefined;
    try {
      // R11/R13: drive the isolated instance, never the user's live app.
      try {
        app = await this.deps.launchApp(request.signal);
      } catch (err) {
        return {
          verdict: "inconclusive",
          assertionId,
          reason: `isolated app launch failed: ${errMessage(err)}`,
        };
      }

      const launch = await this.deps.launchDriver(app.baseUrl, request.signal);
      if (launch.status !== "ready") {
        return {
          verdict: "inconclusive",
          assertionId,
          reason: `app driver unavailable (${launch.reason})`,
          detail: launch.detail,
        };
      }
      session = launch.session;

      const url = joinUrl(app.baseUrl, spec.path);
      const nav = await session.navigate(url, { timeoutMs: spec.timeoutMs });
      if (nav.status !== "ok") {
        return {
          verdict: "inconclusive",
          assertionId,
          reason: `navigation to the assertion surface failed (${nav.reason})`,
          detail: nav.detail,
        };
      }

      const observation = await session.observe(spec.selector, {
        timeoutMs: spec.timeoutMs,
        expectAbsent: spec.expectation === "absent",
      });

      if (observation.status === "inconclusive") {
        // Driver inconclusive is ALWAYS inconclusive (R21).
        return {
          verdict: "inconclusive",
          assertionId,
          reason: `driver could not reach a definitive observation (${observation.reason})`,
          detail: observation.detail,
        };
      }

      // A definitive observation (`found` | `absent`) maps to pass/fail per the
      // expectation. This is the one place a real negative (`absent`) becomes a
      // PASS — for a "bug no longer reproduces" assertion.
      const present = observation.status === "found";
      if (spec.expectation === "present") {
        return present
          ? { verdict: "pass", assertionId, reason: `expected element present at ${spec.path} (${spec.selector})` }
          : { verdict: "fail", assertionId, reason: `expected element ABSENT at ${spec.path} (${spec.selector}); feature not observed` };
      }
      // expectation === "absent" (bug should no longer reproduce)
      return present
        ? {
            verdict: "fail",
            assertionId,
            reason: `defect still reproduces: element still present at ${spec.path} (${spec.selector})`,
            detail: observation.status === "found" ? observation.text : undefined,
          }
        : { verdict: "pass", assertionId, reason: `defect no longer reproduces: element absent at ${spec.path} (${spec.selector})` };
    } catch (err) {
      // Any unexpected driver/setup error is infra, not behavioral → inconclusive.
      return {
        verdict: "inconclusive",
        assertionId,
        reason: `app-driving run could not complete: ${errMessage(err)}`,
      };
    } finally {
      await session?.dispose().catch((err) => verifyLog.warn("driver dispose failed:", err));
      await app?.dispose().catch((err) => verifyLog.warn("isolated app dispose failed:", err));
    }
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function joinUrl(baseUrl: string, pathPart: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  if (!pathPart) return base;
  return `${base}/${pathPart.replace(/^\/+/, "")}`;
}

// ── Determinism contract (R20) ────────────────────────────────────────────────

/**
 * Wrap a verification capability so a verdict is only authoritative when it
 * agrees across N runs. A result that DIFFERS across runs is flaky and resolves
 * to `inconclusive` — never `fail` (R20). N is small and configurable.
 *
 * Semantics:
 * - All N runs return the SAME verdict (pass/fail/inconclusive) → that verdict.
 * - Verdicts differ across runs → `inconclusive` (flaky), with a reason naming
 *   the disagreement. In particular a run that passes then fails is flaky, NOT a
 *   fail — this is the exact false-fail class R20 removes.
 * - Short-circuit: once an `inconclusive` appears we still complete the runs is
 *   unnecessary; an early `inconclusive` already means non-authoritative, so we
 *   return inconclusive immediately to bound cost.
 *
 * The wrapper is channel-agnostic: it wraps the app-driving channel (the new,
 * fragile surface) and can wrap any capability. The test-execution channel can
 * also be wrapped, but the dispatcher applies it to app-driving by default since
 * that is where flakiness lives.
 */
export const DEFAULT_VERIFICATION_RUNS = 2;

export interface DeterministicVerificationOptions {
  inner: VerificationCapability;
  /** Number of agreeing runs required for an authoritative verdict. Default {@link DEFAULT_VERIFICATION_RUNS}. */
  runs?: number;
}

export class DeterministicVerificationCapability implements VerificationCapability {
  private readonly inner: VerificationCapability;
  private readonly runs: number;

  constructor(options: DeterministicVerificationOptions) {
    this.inner = options.inner;
    this.runs = Math.max(1, options.runs ?? DEFAULT_VERIFICATION_RUNS);
  }

  async verifyBehavioralAssertion(request: VerificationRequest): Promise<VerificationOutcome> {
    const first = await this.inner.verifyBehavioralAssertion(request);
    // An early inconclusive is already non-authoritative; bound cost.
    if (first.verdict === "inconclusive" || this.runs === 1) return first;

    for (let i = 1; i < this.runs; i += 1) {
      const next = await this.inner.verifyBehavioralAssertion(request);
      if (next.verdict === "inconclusive") {
        return {
          verdict: "inconclusive",
          assertionId: request.assertionId,
          reason: `verification non-deterministic: run ${i + 1} was inconclusive after an initial ${first.verdict}`,
        };
      }
      if (next.verdict !== first.verdict) {
        // Flaky: differs across runs → inconclusive, NEVER fail (R20).
        return {
          verdict: "inconclusive",
          assertionId: request.assertionId,
          reason: `verification flaky: result differed across ${this.runs} runs (${first.verdict} then ${next.verdict}); resolving to inconclusive rather than ${[first.verdict, next.verdict].includes("fail") ? "fail" : "pass"}`,
        };
      }
    }
    // All runs agreed → authoritative verdict (this is the only path to an
    // authoritative `fail`, satisfying "fail requires N-run agreement").
    return first;
  }
}

// ── Dispatching capability: route by assertion shape (U5 goal) ─────────────────

export interface DispatchingVerificationOptions {
  /** The U3 test-execution channel. */
  testChannel: VerificationCapability;
  /**
   * The app-driving channel. Optional: when absent, an `app`/`both` assertion
   * resolves to inconclusive (the channel is unavailable) rather than a default
   * pass/fail — preserving the fail-closed posture.
   */
  appChannel?: VerificationCapability;
}

/**
 * Routes a verification request to the right evidence channel(s) by assertion
 * shape, then combines outcomes:
 *
 * - `test` → test-execution channel only.
 * - `app`  → app-driving channel only.
 * - `both` → BOTH channels; the assertion passes ONLY when both pass.
 *   - any `fail` → `fail` (with the failing channel's reason);
 *   - else any `inconclusive` → `inconclusive`;
 *   - else (both pass) → `pass`.
 *
 * Channel defaults to `test` when unspecified (existing behavior).
 */
export class DispatchingVerificationCapability implements VerificationCapability {
  private readonly testChannel: VerificationCapability;
  private readonly appChannel?: VerificationCapability;

  constructor(options: DispatchingVerificationOptions) {
    this.testChannel = options.testChannel;
    this.appChannel = options.appChannel;
  }

  async verifyBehavioralAssertion(request: VerificationRequest): Promise<VerificationOutcome> {
    const channel: VerificationChannel = request.channel ?? "test";

    if (channel === "test") {
      return this.testChannel.verifyBehavioralAssertion(request);
    }

    if (channel === "app") {
      return this.runApp(request);
    }

    // channel === "both": passes only when both confirm.
    const [testOutcome, appOutcome] = await Promise.all([
      this.testChannel.verifyBehavioralAssertion(request),
      this.runApp(request),
    ]);
    return combineBoth(request.assertionId, testOutcome, appOutcome);
  }

  private runApp(request: VerificationRequest): Promise<VerificationOutcome> {
    if (!this.appChannel) {
      return Promise.resolve({
        verdict: "inconclusive",
        assertionId: request.assertionId,
        reason: "app-driving channel not available in this verification run",
      });
    }
    return this.appChannel.verifyBehavioralAssertion(request);
  }
}

/**
 * Combine the two channels for a `both` assertion. Any fail dominates; absent a
 * fail, any inconclusive dominates; only two passes confirm.
 */
export function combineBoth(
  assertionId: string,
  testOutcome: VerificationOutcome,
  appOutcome: VerificationOutcome,
): VerificationOutcome {
  const fail = [testOutcome, appOutcome].find((o) => o.verdict === "fail");
  if (fail) {
    return {
      verdict: "fail",
      assertionId,
      reason: `combined verification failed: ${fail.reason}`,
      detail: fail.detail,
    };
  }
  const inconclusive = [testOutcome, appOutcome].find((o) => o.verdict === "inconclusive");
  if (inconclusive) {
    return {
      verdict: "inconclusive",
      assertionId,
      reason: `combined verification inconclusive: ${inconclusive.reason}`,
      detail: inconclusive.detail,
    };
  }
  return {
    verdict: "pass",
    assertionId,
    reason: "both the test-execution and app-driving channels confirmed the behavior",
  };
}
