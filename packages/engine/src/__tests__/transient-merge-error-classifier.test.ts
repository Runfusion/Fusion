import { describe, expect, it } from "vitest";
import { classifyTransientMergeError } from "../transient-merge-error-classifier.js";

describe("classifyTransientMergeError", () => {
  it("returns null for empty or missing errors", () => {
    expect(classifyTransientMergeError(null)).toBeNull();
    expect(classifyTransientMergeError(undefined)).toBeNull();
    expect(classifyTransientMergeError("")).toBeNull();
  });

  it("classifies process spawn cwd failures without over-matching bare errno prose", () => {
    expect(classifyTransientMergeError("spawn ENOTDIR")).toBe("process-spawn-failure");
    expect(classifyTransientMergeError("spawn git ENOENT")).toBe("process-spawn-failure");
    expect(classifyTransientMergeError("spawn ENOENT")).toBe("process-spawn-failure");
    expect(classifyTransientMergeError("Bash tool failed: spawn node ENOTDIR while starting merge verification"))
      .toBe("process-spawn-failure");
    expect(classifyTransientMergeError("fatal: '/var/folders/x/fusion-ai-merge-fn-1-abc' is not a working tree"))
      .toBe("process-spawn-failure");

    expect(classifyTransientMergeError("ENOTDIR while reading packages/cli/package.json"))
      .toBeNull();
    expect(classifyTransientMergeError("User noted ENOENT in a comment, but no process was spawned"))
      .toBeNull();
    expect(classifyTransientMergeError("Verification failed: cannot find module './missing-file.js'"))
      .toBeNull();
  });

  it("keeps existing transient merge classes stable", () => {
    expect(classifyTransientMergeError("Merge handoff refused (lease-handoff-failed): target-not-queued"))
      .toBe("lease-handoff-target-not-queued");

    expect(classifyTransientMergeError(
      "Integration branch main advanced concurrently (expected 5b5da2c24fa006b46139ce4566b764126c6b84ca, observed 5b5da2c24fa006b46139ce4566b764126c6b84ca) while applying 283b290aec527f9ba4244f2935700a2823dd106b",
    )).toBe("spurious-concurrent-advance-same-sha");
  });

  it("does not classify genuine concurrent advances with different SHAs", () => {
    expect(classifyTransientMergeError(
      "Integration branch main advanced concurrently (expected aaa1111aaa1111aaa1111aaa1111aaa1111aaaa, observed bbb2222bbb2222bbb2222bbb2222bbb2222bbbb) while applying ccc3333ccc3333ccc3333ccc3333ccc3333cccc",
    )).toBeNull();
  });

  /*
  FNXC:MergeReliability 2026-07-15-19:00 (FN-8004):
  The AI merge drives a real LLM turn, but no provider-side fault was modeled as transient, so a
  ~20s Grok `-32603` blip parked a task `failed` with 8 files of finished, reviewed work stranded
  in in-review. Because `status:"failed"` is exactly what suppresses both recovery paths, the
  misclassification was self-sealing.

  Per "Fix the Invariant, Not the Repro": assert the invariant across EVERY surface that can emit
  an ACP provider fault — not just the one reported Grok string.
  */
  describe("ai-provider-turn-failure (FN-8004)", () => {
    it("classifies the exact error string that terminally failed FN-8004", () => {
      // Verbatim from .fusion/tasks/FN-8004/task.json `error` — the pre-fix adapter output.
      expect(classifyTransientMergeError("Grok ACP turn failed: Internal error"))
        .toBe("ai-provider-turn-failure");
    });

    it("classifies every ACP-backed runtime's turn-failure prefix", () => {
      // Surface enumeration: all ACP adapters funnel through acp-runtime's promptAcpSession.
      for (const runtime of ["Grok", "OMP"]) {
        expect(classifyTransientMergeError(`${runtime} ACP turn failed: Internal error`))
          .toBe("ai-provider-turn-failure");
      }
    });

    it("classifies post-fix diagnostics carrying the JSON-RPC code envelope", () => {
      expect(classifyTransientMergeError("Grok ACP turn failed: Internal error (acp rpc code -32603, retryable)"))
        .toBe("ai-provider-turn-failure");
      // Reserved server-error range -32000..-32003 is retryable too.
      for (const code of [-32000, -32001, -32002, -32003]) {
        expect(classifyTransientMergeError(`Server error (acp rpc code ${code}, retryable)`))
          .toBe("ai-provider-turn-failure");
      }
    });

    it("does NOT swallow the bare JSON-RPC message without an ACP envelope", () => {
      // "Internal error" is far too generic to treat as transient globally — matching it
      // unanchored would mask real application defects as retryable infrastructure blips.
      expect(classifyTransientMergeError("Internal error")).toBeNull();
      expect(classifyTransientMergeError("Application threw Internal error while saving")).toBeNull();
      expect(classifyTransientMergeError("AssertionError: expected Internal error to be handled")).toBeNull();
    });

    it("does not classify non-retryable JSON-RPC codes (caller bugs, not provider faults)", () => {
      // -32600 invalid request / -32601 method not found / -32602 invalid params are OUR bugs;
      // retrying them just repeats the failing call.
      for (const code of [-32600, -32601, -32602]) {
        expect(classifyTransientMergeError(`Bad call (acp rpc code ${code})`)).toBeNull();
      }
    });
  });

  /*
  FNXC:MergeReliability 2026-07-15-19:00 (FN-8004):
  The inline retry gate (`project-engine.ts#maybeRetryTransientMerge`) accepted
  `isTransientError(msg) || classify(msg)`, but the self-healing sweep
  (`recoverTransientMergeFailures`) consulted ONLY this classifier. Any network-class error
  therefore got inline retries and then became invisible to the sweep once parked `failed`.
  Delegating to `isTransientError` makes the two gates agree by construction.
  */
  describe("network-transport-failure delegation (FN-8004 asymmetry)", () => {
    it("classifies network transport errors the sweep previously could not see", () => {
      for (const msg of ["socket hang up", "read ECONNRESET", "connect ECONNREFUSED 127.0.0.1:443", "upstream connect error"]) {
        expect(classifyTransientMergeError(msg)).toBe("network-transport-failure");
      }
    });

    it("still returns the specific git/merge class when both could match", () => {
      // Ordering invariant: the precise class must win the audit label.
      expect(classifyTransientMergeError("Merge handoff refused (lease-handoff-failed): target-not-queued"))
        .toBe("lease-handoff-target-not-queued");
      expect(classifyTransientMergeError("spawn git ENOENT")).toBe("process-spawn-failure");
    });

    it("leaves genuine task defects permanent", () => {
      expect(classifyTransientMergeError("Test suite failed: 3 assertions failed")).toBeNull();
      expect(classifyTransientMergeError("FileScopeViolationError: commit touches files outside scope")).toBeNull();
      expect(classifyTransientMergeError("CONFLICT (content): Merge conflict in src/app.ts")).toBeNull();
    });
  });
});
