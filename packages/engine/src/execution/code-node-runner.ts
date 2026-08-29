/**
 * Code-node runner (U14, KTD-15).
 *
 * Executes a workflow `code` node: arbitrary user-authored TypeScript that runs
 * as a general computation escape hatch (derive a field, compute routing data,
 * call an internal API). The source is:
 *
 *   1. compiled in-memory with esbuild (TS → ESM, no bundling, no resolution);
 *   2. written to a temp module in the OS temp dir;
 *   3. executed in a CHILD `node` PROCESS with `cwd = task worktree`, a minimal
 *      env, and the serialized `ctx` delivered on stdin;
 *   4. the child default-exports `async (ctx) => result`; its JSON result is
 *      written to stdout between sentinels and parsed back here.
 *
 * Harness contract:
 *   ctx = {
 *     task: { id, title, description, column, steps, customFields },
 *     context: <walk context snapshot, JSON-safe>,
 *     artifacts: { read(key): string | undefined },   // pre-read, plain object
 *     instance?: <foreach:active when inside a foreach template>,
 *   }
 *   result = { outcome?, value?, contextPatch?, customFields? }
 *     - outcome string  → routes outcome:<value>; absent → success
 *     - contextPatch    → merged into the walk context
 *     - customFields     → written through the U11 validation authority by the
 *                          handler wiring (NOT here — the runner has no store)
 *
 * Failure posture (fail-closed, audited): throw / timeout / non-zero exit /
 * compile error → a thrown {@link CodeNodeError} carrying captured stderr
 * (capped). The handler maps it to a `failure` node outcome with the error in
 * the audit/node result. The runner never gets a store handle, engine
 * internals, or the step-list write path (KTD-15 boundaries).
 *
 * DEVIATION (documented per the plan): artifacts are PRE-READ into a plain
 * `ctx.artifacts` object (the script calls `artifacts.read(key)` synchronously
 * against the pre-read map) rather than an RPC-over-stdio bridge. This is the
 * plan's explicitly-sanctioned "SIMPLER" path — the child process needs no live
 * channel back to the engine, keeping the boundary a one-shot stdin→stdout call.
 */

import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// esbuild is loaded lazily at first compile: a top-level import would run its
// environment invariant check (TextEncoder) at module-load time in any process
// that merely imports @fusion/engine — including jsdom test environments where
// that invariant fails. Lazy loading confines esbuild to actual code-node use.
let cachedTransformSync: typeof import("esbuild").transformSync | undefined;
function getTransformSync(): typeof import("esbuild").transformSync {
  if (!cachedTransformSync) {
    const req = createRequire(import.meta.url);
    cachedTransformSync = (req("esbuild") as typeof import("esbuild")).transformSync;
  }
  return cachedTransformSync;
}
import type { CustomFieldRejection, TaskDetail, WorkflowIrNode } from "@fusion/core";

import type { WorkflowNodeResult } from "../workflows/workflow-graph-executor.js";
import { FOREACH_ACTIVE_CONTEXT_KEY, type CodeNodeRunner } from "../workflows/workflow-node-handlers.js";

/** Default code-node timeout (KTD-15). */
export const CODE_NODE_DEFAULT_TIMEOUT_MS = 30_000;
/** Hard cap on the code-node timeout (KTD-15). */
export const CODE_NODE_MAX_TIMEOUT_MS = 300_000;
/** Defensive re-check of the core source-size cap (KTD-15: ≤64KB). */
export const CODE_NODE_MAX_SOURCE_BYTES = 65_536;
/** Cap on captured stdout/stderr surfaced into the node result (~16KB each). */
export const CODE_NODE_OUTPUT_CAP_BYTES = 16_384;

/** Sentinels framing the JSON result on the child's stdout. */
const RESULT_BEGIN = "__FUSION_CODE_NODE_RESULT_BEGIN__";
const RESULT_END = "__FUSION_CODE_NODE_RESULT_END__";

/** The JSON-safe task subset handed to the code node (KTD-15). */
export interface CodeNodeTaskSubset {
  id: string;
  title: string;
  description?: string;
  column?: string;
  steps: unknown[];
  customFields: Record<string, unknown>;
}

/** The harness ctx assembled for a code-node run. */
export interface CodeNodeContext {
  task: CodeNodeTaskSubset;
  context: Record<string, unknown>;
  /** Declared artifacts, pre-read into a plain map (see module DEVIATION note). */
  artifacts: Record<string, string>;
  /** `foreach:active` instance when the node runs inside a foreach template. */
  instance?: Record<string, unknown>;
}

/** The result shape a code node returns (KTD-15). */
export interface CodeNodeResult {
  outcome?: string;
  value?: string;
  contextPatch?: Record<string, unknown>;
  customFields?: Record<string, unknown>;
}

/** Reason codes for a code-node failure (audit-stable). */
export type CodeNodeFailureReason =
  | "compile-error"
  | "source-too-large"
  | "timeout"
  | "nonzero-exit"
  | "runtime-throw"
  | "bad-result";

/** Thrown on any code-node failure; carries the audit-stable reason + captured
 *  stderr (capped). The handler maps it to a `failure` node outcome. */
export class CodeNodeError extends Error {
  readonly reason: CodeNodeFailureReason;
  readonly stderr: string;
  constructor(reason: CodeNodeFailureReason, message: string, stderr = "") {
    super(message);
    this.name = "CodeNodeError";
    this.reason = reason;
    this.stderr = stderr;
  }
}

/** Cap a string to a byte budget, appending a truncation marker. */
function capOutput(s: string): string {
  if (Buffer.byteLength(s, "utf8") <= CODE_NODE_OUTPUT_CAP_BYTES) return s;
  // Slice by characters then trim until under the byte cap (good enough; output
  // is for audit display, not byte-exact reconstruction).
  let out = s.slice(0, CODE_NODE_OUTPUT_CAP_BYTES);
  while (Buffer.byteLength(out, "utf8") > CODE_NODE_OUTPUT_CAP_BYTES) {
    out = out.slice(0, -64);
  }
  return `${out}\n…[truncated]`;
}

/** Resolve and clamp the configured timeout (KTD-15). */
export function resolveCodeNodeTimeout(timeoutMs: unknown): number {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) {
    return CODE_NODE_DEFAULT_TIMEOUT_MS;
  }
  return Math.max(1000, Math.min(CODE_NODE_MAX_TIMEOUT_MS, Math.floor(timeoutMs)));
}

/**
 * Compile a code-node source (TS) to ESM in-memory. Throws {@link CodeNodeError}
 * with reason `compile-error` on a syntax/transform failure (this is the same
 * transform the save-time validator runs via {@link validateCodeNodeSources}).
 */
export async function compileCodeNodeSource(source: string): Promise<string> {
  if (Buffer.byteLength(source, "utf8") > CODE_NODE_MAX_SOURCE_BYTES) {
    throw new CodeNodeError(
      "source-too-large",
      `code node source exceeds ${CODE_NODE_MAX_SOURCE_BYTES} bytes`,
    );
  }
  try {
    // `transformSync` runs a short-lived per-call child that exits cleanly,
    // avoiding esbuild's long-lived service process (which the test harness's
    // subprocess guard would otherwise flag as a lingering child).
    const out = getTransformSync()(source, {
      loader: "ts",
      format: "esm",
      target: "node18",
    });
    return out.code;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CodeNodeError("compile-error", `code node failed to compile: ${message}`);
  }
}

/** The child harness wrapper. Reads ctx JSON from stdin, imports the compiled
 *  user module (default export), invokes it, frames the JSON result on stdout. */
function buildChildHarness(userModuleFile: string): string {
  return `
import userMod from ${JSON.stringify(userModuleFile)};

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { data += c; });
    process.stdin.on("end", () => resolve(data));
  });
}

(async () => {
  const raw = await readStdin();
  const parsed = JSON.parse(raw);
  // Reconstruct ctx.artifacts.read from the pre-read plain map.
  const artifactsMap = parsed.artifacts || {};
  const ctx = {
    task: parsed.task,
    context: parsed.context || {},
    artifacts: {
      read(key) {
        return Object.prototype.hasOwnProperty.call(artifactsMap, key)
          ? artifactsMap[key]
          : undefined;
      },
    },
    instance: parsed.instance,
  };
  const fn = userMod;
  if (typeof fn !== "function") {
    throw new Error("code node module must default-export an async (ctx) => result function");
  }
  const result = await fn(ctx);
  process.stdout.write("${RESULT_BEGIN}" + JSON.stringify(result === undefined ? {} : result) + "${RESULT_END}");
})().catch((err) => {
  process.stderr.write(String(err && err.stack ? err.stack : err));
  process.exit(7);
});
`;
}

/** Options for {@link runCodeNode}. */
export interface RunCodeNodeOptions {
  source: string;
  timeoutMs?: number;
  cwd: string;
  ctx: CodeNodeContext;
  /** Override the node executable (tests). Defaults to the current process. */
  nodeExecPath?: string;
  /** Injected process runner seam (tests). Defaults to the real child-process
   *  execution. Lets the suite unit-test mapping logic without spawning. */
  spawnRunner?: (params: {
    nodeExecPath: string;
    harnessFile: string;
    cwd: string;
    timeoutMs: number;
    stdin: string;
  }) => Promise<{ stdout: string; stderr: string }>;
}

/**
 * Compile + execute a code node and return its parsed result. Throws
 * {@link CodeNodeError} on any failure (compile/timeout/exit/throw/bad-result).
 */
export async function runCodeNode(opts: RunCodeNodeOptions): Promise<CodeNodeResult> {
  const timeoutMs = resolveCodeNodeTimeout(opts.timeoutMs);
  const compiled = await compileCodeNodeSource(opts.source);

  const dir = await mkdtemp(join(tmpdir(), "fusion-code-node-"));
  const userModuleFile = join(dir, "user.mjs");
  const harnessFile = join(dir, "harness.mjs");
  try {
    await writeFile(userModuleFile, compiled, "utf8");
    await writeFile(harnessFile, buildChildHarness(userModuleFile), "utf8");

    const stdin = JSON.stringify({
      task: opts.ctx.task,
      context: opts.ctx.context,
      artifacts: opts.ctx.artifacts,
      instance: opts.ctx.instance,
    });

    const nodeExecPath = opts.nodeExecPath ?? process.execPath;
    const run = opts.spawnRunner ?? defaultSpawnRunner;
    let stdout: string;
    let stderr: string;
    try {
      ({ stdout, stderr } = await run({ nodeExecPath, harnessFile, cwd: opts.cwd, timeoutMs, stdin }));
    } catch (err) {
      // Classify the child failure. execFile's error carries `killed`
      // (timeout/SIGTERM), `signal`, and `code` (numeric exit code) or the string
      // ETIMEDOUT; we narrow with a permissive shape.
      const e = err as {
        killed?: boolean;
        signal?: string | null;
        code?: number | string;
        message?: string;
        stderr?: string;
      };
      const capturedStderr = capOutput(typeof e.stderr === "string" ? e.stderr : "");
      if (e.killed || e.signal === "SIGTERM" || e.code === "ETIMEDOUT") {
        throw new CodeNodeError("timeout", `code node timed out after ${timeoutMs}ms`, capturedStderr);
      }
      // Exit code 7 is our harness's caught-throw sentinel; any numeric exit code
      // is a runtime/non-zero-exit failure.
      if (typeof e.code === "number") {
        throw new CodeNodeError(
          "runtime-throw",
          `code node threw at runtime${capturedStderr ? `: ${capturedStderr.split("\n")[0]}` : ""}`,
          capturedStderr,
        );
      }
      throw new CodeNodeError("nonzero-exit", `code node exited abnormally: ${e.message ?? "unknown error"}`, capturedStderr);
    }

    // Parse the framed result.
    const begin = stdout.indexOf(RESULT_BEGIN);
    const end = stdout.indexOf(RESULT_END);
    if (begin < 0 || end < 0 || end < begin) {
      throw new CodeNodeError(
        "bad-result",
        "code node produced no parseable result",
        capOutput(stderr),
      );
    }
    const jsonStr = stdout.slice(begin + RESULT_BEGIN.length, end);
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new CodeNodeError("bad-result", `code node result was not valid JSON: ${message}`, capOutput(stderr));
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new CodeNodeError("bad-result", "code node result must be an object", capOutput(stderr));
    }
    return parsed as CodeNodeResult;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The real child-process runner: spawns `node harness.mjs`, pipes ctx on stdin,
 *  captures stdout/stderr, enforces the timeout. */
function defaultSpawnRunner(params: {
  nodeExecPath: string;
  harnessFile: string;
  cwd: string;
  timeoutMs: number;
  stdin: string;
}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      params.nodeExecPath,
      [params.harnessFile],
      {
        cwd: params.cwd,
        timeout: params.timeoutMs,
        // Ensure the timeout actually KILLS a child that traps/ignores SIGTERM:
        // execFile defaults to SIGTERM, which a long-running or signal-trapping
        // script can swallow, letting it outlive the timeout. SIGKILL cannot be
        // trapped, so the timeout is enforceable.
        killSignal: "SIGKILL",
        // Minimal env: PATH + a few harmless basics; no inherited secrets beyond
        // what the worktree-scoped script tier already has access to (KTD-15:
        // same trust as existing script steps).
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          NODE_ENV: process.env.NODE_ENV ?? "",
        },
        maxBuffer: 8 * 1024 * 1024,
        encoding: "utf8",
      },
      (err, stdout, stderr) => {
        if (err) {
          (err as NodeJS.ErrnoException & { stderr?: string; stdout?: string }).stderr = stderr;
          reject(err);
          return;
        }
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
    child.stdin?.end(params.stdin);
  });
}

/**
 * Save-time syntax validation (U14, KTD-15). Compiles every `code` node's source
 * with the same esbuild transform the runner uses; returns the nodes that fail
 * to compile with the error message. Exported so the dashboard workflow-save
 * route can reject IR with uncompilable code nodes BEFORE persistence.
 *
 * HANDOFF: the dashboard route (`register-workflow-routes.ts` →
 * `store.createWorkflowDefinition/update`) is owned by a concurrent agent and is
 * NOT wired here. Until that route calls this helper, code-node sources are
 * validated at EXECUTION time (a compile error surfaces as a `failure` node
 * outcome via {@link CodeNodeError} reason `compile-error`). See the report
 * handoff item.
 */
export async function validateCodeNodeSources(
  ir: { nodes: WorkflowIrNode[] },
): Promise<Array<{ nodeId: string; error: string }>> {
  const failures: Array<{ nodeId: string; error: string }> = [];
  for (const node of ir.nodes) {
    if (node.kind !== "code") continue;
    const source = (node.config as { source?: unknown } | undefined)?.source;
    if (typeof source !== "string" || source.length === 0) {
      failures.push({ nodeId: node.id, error: "code node has no source" });
      continue;
    }
    try {
      await compileCodeNodeSource(source);
    } catch (err) {
      failures.push({
        nodeId: node.id,
        error: err instanceof CodeNodeError ? err.message : String(err),
      });
    }
    // (A `code` node has no `template` — the only template recursion is the
    // foreach pass below; the prior code-node-loop recursion here was dead.)
  }
  // Recurse into any foreach templates (code nodes are legal inside them, KTD-15).
  for (const node of ir.nodes) {
    if (node.kind !== "foreach") continue;
    const template = (node.config as { template?: { nodes?: unknown } } | undefined)?.template;
    // Guard with an explicit array check: a malformed config where `nodes` is a
    // non-array truthy value would otherwise break the `for...of` inside the
    // recursive validateCodeNodeSources call and bubble as a 500 rather than a
    // clean validation failure.
    if (Array.isArray(template?.nodes)) {
      failures.push(...(await validateCodeNodeSources({ nodes: template.nodes as WorkflowIrNode[] })));
    } else if (template?.nodes != null) {
      failures.push({ nodeId: node.id, error: "foreach template.nodes must be an array" });
    }
  }
  return failures;
}

/** Build the JSON-safe task subset handed to a code node (KTD-15). Only the
 *  allowlisted fields cross the boundary — no store handle, no engine internals. */
export function buildCodeNodeTaskSubset(task: TaskDetail): CodeNodeTaskSubset {
  return {
    id: task.id,
    title: task.title ?? "",
    description: task.description,
    column: task.column,
    steps: Array.isArray(task.steps) ? (task.steps as unknown[]) : [],
    customFields: (task.customFields as Record<string, unknown>) ?? {},
  };
}

/** A JSON-safe deep snapshot of the walk context (drops functions/cycles via
 *  JSON round-trip; the reserved `foreach:active` instance is surfaced
 *  separately as ctx.instance, so strip it from the generic context). */
function jsonSafeContext(context: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(context)) {
    if (k === FOREACH_ACTIVE_CONTEXT_KEY) continue;
    try {
      out[k] = JSON.parse(JSON.stringify(v));
    } catch {
      // Drop non-serializable values rather than failing the whole snapshot.
    }
  }
  return out;
}

/** Injected dependencies for {@link createCodeNodeRunner} (U14). */
export interface CodeNodeRunnerDeps {
  /** Worktree cwd for the child process (defaults to rootDir if unresolved). */
  resolveCwd: (task: TaskDetail) => Promise<string> | string;
  /** Pre-read the declared artifacts into a plain map (DEVIATION note above).
   *  Returns key→content for every artifact the workflow declares (or that the
   *  node references); missing artifacts are simply absent from the map. */
  readArtifacts: (task: TaskDetail) => Promise<Record<string, string>> | Record<string, string>;
  /** Write the returned customFields patch through the U11 validation authority.
   *  Resolves a typed rejection (not throw) so the runner maps it to a node
   *  failure surfacing the rejection. */
  writeCustomFields: (
    task: TaskDetail,
    patch: Record<string, unknown>,
  ) => Promise<{ ok: true } | { ok: false; rejection: CustomFieldRejection }>;
  /** Optional audit sink for failures (reason + detail). Never throws. */
  audit?: (reason: string, detail: string) => void;
  /** Test seam: inject a process runner (forwarded to {@link runCodeNode}). */
  spawnRunner?: RunCodeNodeOptions["spawnRunner"];
}

/**
 * Build a {@link CodeNodeRunner} bound to the executor environment. The returned
 * function assembles the harness ctx (task subset, JSON-safe context,
 * pre-read artifacts, `foreach:active` instance), runs the node, and maps the
 * result to a {@link WorkflowNodeResult}: `outcome` string → `outcome:<value>`
 * (absent → success); `contextPatch` merged into the walk context; `customFields`
 * written through the U11 authority (a typed rejection → node failure). A throw
 * / timeout / non-zero exit / compile error → `failure` with the reason as the
 * value and the captured stderr audited.
 */
export function createCodeNodeRunner(deps: CodeNodeRunnerDeps): CodeNodeRunner {
  const audit = (reason: string, detail: string): void => {
    try {
      deps.audit?.(reason, detail);
    } catch {
      // Audit must never affect the run.
    }
  };

  return async (node: WorkflowIrNode, task: TaskDetail, context: Record<string, unknown>): Promise<WorkflowNodeResult> => {
    const cfg = (node.config ?? {}) as { source?: unknown; timeoutMs?: unknown };
    const source = typeof cfg.source === "string" ? cfg.source : "";

    const cwd = await deps.resolveCwd(task);
    const artifacts = await deps.readArtifacts(task);
    const instance = context[FOREACH_ACTIVE_CONTEXT_KEY] as Record<string, unknown> | undefined;

    let result: CodeNodeResult;
    try {
      result = await runCodeNode({
        source,
        timeoutMs: typeof cfg.timeoutMs === "number" ? cfg.timeoutMs : undefined,
        cwd,
        ctx: {
          task: buildCodeNodeTaskSubset(task),
          context: jsonSafeContext(context),
          artifacts,
          instance: instance ? (JSON.parse(JSON.stringify(instance)) as Record<string, unknown>) : undefined,
        },
        spawnRunner: deps.spawnRunner,
      });
    } catch (err) {
      const reason = err instanceof CodeNodeError ? err.reason : "runtime-throw";
      const stderr = err instanceof CodeNodeError ? err.stderr : "";
      const message = err instanceof Error ? err.message : String(err);
      audit(reason, `code node '${node.id}' failed (${reason}): ${message}${stderr ? `\n${stderr}` : ""}`);
      return {
        outcome: "failure",
        value: reason,
        contextPatch: { [`node:${node.id}:error`]: message, [`node:${node.id}:stderr`]: capOutput(stderr) },
      };
    }

    // customFields patch → write through the U11 authority. A typed rejection
    // surfaces as a node failure (KTD-15: fields only via the validated patch).
    if (result.customFields && Object.keys(result.customFields).length > 0) {
      const write = await deps.writeCustomFields(task, result.customFields);
      if (!write.ok) {
        const detail = `${write.rejection.code} (${write.rejection.fieldId}): ${write.rejection.detail}`;
        audit("custom-field-rejected", `code node '${node.id}' customFields write rejected — ${detail}`);
        return {
          outcome: "failure",
          value: "custom-field-rejected",
          contextPatch: { [`node:${node.id}:rejection`]: detail },
        };
      }
    }

    const patch: Record<string, unknown> = { ...(result.contextPatch ?? {}) };
    // KTD-15: a returned `outcome` string routes `outcome:<value>` edges; absent
    // → success. The graph executor routes `outcome:` edges off the node result's
    // `value`, so the returned outcome string becomes the routing value while the
    // node outcome stays `success` (an explicit `outcome:"failure"` routes the
    // `failure` edge — a routable choice, distinct from a thrown/timeout failure).
    const routingValue =
      typeof result.value === "string"
        ? result.value
        : typeof result.outcome === "string" && result.outcome.length > 0
        ? result.outcome
        : undefined;
    const nodeOutcome = result.outcome === "failure" ? "failure" : "success";
    return {
      outcome: nodeOutcome,
      value: routingValue,
      contextPatch: patch,
    };
  };
}
