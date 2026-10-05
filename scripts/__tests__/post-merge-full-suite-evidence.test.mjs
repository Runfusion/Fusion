import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { collectPostMergeFullSuiteEvidence, REQUIRED_SHARD_ARTIFACTS } from "../post-merge-full-suite-evidence.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function createEvidenceRoot() {
  return mkdtempSync(path.join(tmpdir(), "post-merge-evidence-"));
}

function writeJson(file, payload) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(payload)}\n`);
}

function validTimingPayload() {
  return { testResults: [{ assertionResults: [{ status: "passed", fullName: "a passing test" }] }] };
}

function validPipelinePayload() {
  return {
    passed: true,
    durationMs: 12,
    durationBudgetMs: 175000,
    records: [{ scenarioId: "scenario", workflowId: "workflow", variant: "", verdict: "pass", expectedTerminal: "done", observedTerminal: "done", wedge: false }],
    invocationKeys: ["scenario\u0000workflow\u0000"],
  };
}

function writeValidPipeline(root) {
  writeJson(path.join(root, "pipeline-smoke-report", "report.json"), validPipelinePayload());
}

function collectorEnv() {
  return {
    GITHUB_REPOSITORY: "Runfusion/Fusion",
    GITHUB_RUN_ID: "future-run",
    GITHUB_SHA: "future-sha",
    GITHUB_SERVER_URL: "https://github.com",
    TEST_SHARDS_RESULT: "cancelled",
    PIPELINE_SMOKE_RESULT: "success",
  };
}

test("collector CLI retains an incomplete manifest for a cancelled missing shard without inventing timing data", async () => {
  const root = createEvidenceRoot();
  try {
    for (const artifact of REQUIRED_SHARD_ARTIFACTS.slice(1)) {
      writeJson(path.join(root, artifact, "timing.json"), validTimingPayload());
    }
    writeValidPipeline(root);

    const result = spawnSync(process.execPath, ["scripts/post-merge-full-suite-evidence.mjs"], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...collectorEnv(), POST_MERGE_EVIDENCE_ROOT: root },
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);

    const output = path.join(root, "manifest.json");
    await assert.rejects(
      collectPostMergeFullSuiteEvidence({
        evidenceRoot: root,
        outputFile: output,
        env: collectorEnv(),
        expectedKeys: ["scenario\u0000workflow\u0000"],
      }),
      /missing-timing-json/,
    );
    const manifest = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(manifest.version, 3);
    assert.equal(manifest.status, "incomplete");
    assert.equal(manifest.qualification.eligible, false);
    assert.deepEqual(manifest.expectedArtifacts.find((artifact) => artifact.artifact === "test-timings-shard-1"), {
      artifact: "test-timings-shard-1",
      presence: "absent",
      reportCount: 0,
    });
    assert.ok(manifest.failureReasons.some((reason) => reason.code === "missing-timing-json" && reason.producer === "test-timings-shard-1"));
    assert.equal(JSON.stringify(manifest).includes("testResults"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collector fails closed with machine-readable malformed and duplicate producer reasons", async () => {
  const root = createEvidenceRoot();
  try {
    for (const artifact of REQUIRED_SHARD_ARTIFACTS) {
      writeJson(path.join(root, artifact, "timing.json"), validTimingPayload());
    }
    writeFileSync(path.join(root, "test-timings-shard-2", "broken.json"), "not-json\n");
    mkdirSync(path.join(root, "test-timings-shard-3 (1)"));
    writeValidPipeline(root);

    await assert.rejects(
      collectPostMergeFullSuiteEvidence({ evidenceRoot: root, env: collectorEnv(), expectedKeys: ["scenario\u0000workflow\u0000"] }),
      /duplicate-producer-artifact/,
    );
    const manifest = JSON.parse(readFileSync(path.join(root, "manifest.json"), "utf8"));
    assert.ok(manifest.failureReasons.some((reason) => reason.code === "malformed-timing-json" && reason.producer === "test-timings-shard-2"));
    assert.ok(manifest.failureReasons.some((reason) => reason.code === "duplicate-producer-artifact" && reason.producer === "test-timings-shard-3 (1)"));
    assert.equal(manifest.qualification.eligible, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collector preserves the versioned successful normalized evidence for complete input", async () => {
  const root = createEvidenceRoot();
  try {
    for (const artifact of REQUIRED_SHARD_ARTIFACTS) {
      writeJson(path.join(root, artifact, "timing.json"), validTimingPayload());
    }
    writeValidPipeline(root);
    const evidence = await collectPostMergeFullSuiteEvidence({
      evidenceRoot: root,
      env: { ...collectorEnv(), TEST_SHARDS_RESULT: "success" },
      expectedKeys: ["scenario\u0000workflow\u0000"],
    });
    assert.equal(evidence.version, 2);
    assert.equal(evidence.shards.length, 4);
    assert.equal(evidence.pipelineSmoke.invocationCount, 1);
    assert.equal("failureReasons" in evidence, false);
    assert.equal("expectedArtifacts" in evidence, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
