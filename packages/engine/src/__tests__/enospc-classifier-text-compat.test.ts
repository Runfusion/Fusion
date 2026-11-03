import { describe, expect, it, vi } from "vitest";

import { annotateEnospcFailure, type TempFsStatfsLike } from "@fusion/core";
import { classifyExternalObstacle } from "../execution-block-classifier.js";

/*
FNXC:TempFsDiagnostics 2026-11-03-08:17 (RUFU-397):
The one invariant every annotation in this task depends on: naming the temp-fs class must never change
how a failure is ROUTED. `classifyExternalObstacle` matches the literal `ENOSPC` token out of the
message text, and the annotated sentence is the text that reaches it — so an annotation that dropped,
split, or reworded the token would silently turn a host-environment freeze (correct: the operator must
fix the machine) into an AI-repairable in-worktree failure (wrong: the agent loops against a full disk).

That regression is invisible to every other gate in this repo — lint, typecheck, and build all stay
green when a prompt or message string drifts, and the classifier itself is unchanged by this task. So
the guard is on the composition: real annotated output in, expected classification out.
*/

/** Measured host shape: 0 of 1048576 inodes free while 52 G of bytes are free. */
const INODE_EXHAUSTED: TempFsStatfsLike = {
  bsize: 4096,
  frsize: 4096,
  blocks: 16453664,
  bfree: 14598829,
  bavail: (52 * 1024 ** 3) / 4096,
  files: 1048576,
  ffree: 0,
};

/** Measured byte-full shape: 0 blocks available, inodes still plentiful. */
const BYTES_FULL: TempFsStatfsLike = {
  bsize: 4096,
  frsize: 4096,
  blocks: 480431430,
  bfree: 0,
  bavail: 0,
  files: 120836096,
  ffree: 107969693,
};

const ENOSPC_SENTENCES = [
  "ENOSPC: no space left on device, mkdtemp '/tmp/fusion-ai-merge-fn-1-a1b2c3'",
  "no space left on device",
  "Error: write ENOSPC",
  "errno 28: no space left on device",
];

describe("temp-fs annotation preserves the honest-blocked classification", () => {
  it.each(ENOSPC_SENTENCES)("annotating %j still classifies as host-environment ENOSPC", (sentence) => {
    const before = classifyExternalObstacle(sentence);
    const annotated = annotateEnospcFailure(sentence, "/tmp", { statfs: () => INODE_EXHAUSTED });

    // The annotation is only interesting when it actually appended something.
    expect(annotated.length).toBeGreaterThan(sentence.length);
    expect(annotated).toContain("inode-exhausted");
    expect(classifyExternalObstacle(annotated)).toEqual({ origin: "host-environment", code: "ENOSPC" });
    /*
    FNXC:TempFsDiagnostics 2026-11-03-08:18 (RUFU-397): the honest non-regression shape.
    The annotation must never REMOVE or REROUTE a classification — that is the whole risk this guard
    exists for. It may ADD one: a sentence that says only "no space left on device" without the
    `ENOSPC` token matched no code before and looked AI-repairable, and the class line supplies the
    token so a genuine host failure freezes correctly instead of looping an agent against the machine.
    */
    if (before) {
      expect(classifyExternalObstacle(annotated)).toEqual(before);
    }
  });

  it("keeps the token for a byte-full device too (the class differs, the routing does not)", () => {
    const annotated = annotateEnospcFailure("ENOSPC: no space left on device", "/tmp", {
      statfs: () => BYTES_FULL,
    });
    expect(annotated).toContain("bytes-full");
    expect(classifyExternalObstacle(annotated)).toEqual({ origin: "host-environment", code: "ENOSPC" });
  });

  it("keeps the token when the probe is unavailable and the message passes through untouched", () => {
    const sentence = "ENOSPC: no space left on device, mkdtemp";
    const annotated = annotateEnospcFailure(sentence, "/tmp", {
      statfs: () => { throw new Error("statfs unsupported"); },
    });
    expect(annotated).toBe(sentence);
    expect(classifyExternalObstacle(annotated)).toEqual({ origin: "host-environment", code: "ENOSPC" });
  });

  it("guarantees the literal token even for a prose-only sentence that carried no code", () => {
    // "no space left on device" alone does not match the classifier's code list; the class line must
    // supply the token rather than leave a host failure looking AI-repairable.
    expect(classifyExternalObstacle("no space left on device")).toBeUndefined();
    const annotated = annotateEnospcFailure("no space left on device", "/tmp", {
      statfs: () => INODE_EXHAUSTED,
    });
    expect(annotated).toMatch(/\bENOSPC\b/);
    expect(classifyExternalObstacle(annotated)).toEqual({ origin: "host-environment", code: "ENOSPC" });
  });

  it("does not manufacture a host freeze for a non-ENOSPC failure", () => {
    const sentence = "error: failed to run task: Tests 3 failed";
    const statfs = vi.fn(() => INODE_EXHAUSTED);
    const annotated = annotateEnospcFailure(sentence, "/tmp", { statfs });
    expect(annotated).toBe(sentence);
    expect(classifyExternalObstacle(annotated)).toBeUndefined();
    // A non-ENOSPC failure must not even pay for a filesystem probe.
    expect(statfs).not.toHaveBeenCalled();
  });
});
