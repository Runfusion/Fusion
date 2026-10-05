#!/usr/bin/env node

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expectedPipelineInvocations } from "../packages/engine/src/__tests__/pipeline-smoke/_pipeline-scenario-manifest.mjs";

export const REQUIRED_SHARD_ARTIFACTS = [
  "test-timings-shard-1",
  "test-timings-shard-2",
  "test-timings-shard-3",
  "test-timings-shard-4",
];

class EvidenceValidationError extends Error {
  constructor(reasons) {
    super(`Post-merge Full Suite evidence is incomplete: ${reasons.map((reason) => reason.code).join(", ")}`);
    this.name = "EvidenceValidationError";
    this.reasons = reasons;
  }
}

async function jsonFiles(root) {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      const child = path.join(root, entry.name);
      if (entry.isDirectory()) files.push(...await jsonFiles(child));
      else if (entry.isFile() && entry.name.endsWith(".json")) files.push(child);
    }
    return files;
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function invalid(reason, code, producer, detail) {
  reason.push({ code, producer, ...(detail === undefined ? {} : { detail }) });
}

function expectedPipelineKeys() {
  return expectedPipelineInvocations()
    .map(({ id, workflowId, variant }) => `${id}\u0000${workflowId}\u0000${variant ?? ""}`)
    .sort();
}

function runIdentity(env) {
  return {
    repository: env.GITHUB_REPOSITORY,
    runId: env.GITHUB_RUN_ID,
    sha: env.GITHUB_SHA,
    url: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
  };
}

function producerConclusions(env) {
  return {
    testShards: { conclusion: env.TEST_SHARDS_RESULT, nonBlocking: true },
    pipelineSmoke: { conclusion: env.PIPELINE_SMOKE_RESULT, nonBlocking: true },
  };
}

/**
 * Read downloaded producer artifacts, always write a manifest, then refuse
 * qualification when any source input is absent or invalid. This is the real
 * workflow seam rather than a serializer: it observes the downloaded layout.
 *
 * @param {{ evidenceRoot?: string, outputFile?: string, env?: NodeJS.ProcessEnv, expectedKeys?: string[] }} [options]
 * @returns {Promise<object>}
 */
export async function collectPostMergeFullSuiteEvidence(options = {}) {
  const evidenceRoot = options.evidenceRoot ?? process.env.POST_MERGE_EVIDENCE_ROOT ?? "post-merge-evidence";
  const outputFile = options.outputFile ?? path.join(evidenceRoot, "manifest.json");
  const env = options.env ?? process.env;
  const reasons = [];
  const expectedArtifacts = [];
  const shards = [];

  const rootEntries = await readdir(evidenceRoot, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of rootEntries) {
    if (/^test-timings-shard-\d+\s*\(\d+\)$/.test(entry.name)) {
      invalid(reasons, "duplicate-producer-artifact", entry.name, "duplicate artifact download directory");
    }
  }

  for (const artifact of REQUIRED_SHARD_ARTIFACTS) {
    const artifactRoot = path.join(evidenceRoot, artifact);
    const files = await jsonFiles(artifactRoot);
    const observed = { artifact, presence: files.length > 0 ? "present" : "absent", reportCount: files.length };
    expectedArtifacts.push(observed);
    if (files.length === 0) {
      invalid(reasons, "missing-timing-json", artifact);
      continue;
    }

    const reports = [];
    for (const file of files) {
      let payload;
      try {
        payload = JSON.parse(await readFile(file, "utf8"));
      } catch {
        invalid(reasons, "malformed-timing-json", artifact, path.relative(evidenceRoot, file));
        observed.presence = "invalid";
        continue;
      }
      if (!Array.isArray(payload.testResults)) {
        invalid(reasons, "invalid-timing-payload", artifact, path.relative(evidenceRoot, file));
        observed.presence = "invalid";
        continue;
      }
      const failedFullNames = [];
      let malformedAssertion = false;
      for (const result of payload.testResults) {
        if (!Array.isArray(result?.assertionResults)) {
          malformedAssertion = true;
          break;
        }
        failedFullNames.push(
          ...result.assertionResults
            .filter((assertion) => assertion?.status === "failed" && typeof assertion.fullName === "string")
            .map((assertion) => assertion.fullName),
        );
      }
      if (malformedAssertion) {
        invalid(reasons, "malformed-assertion-result", artifact, path.relative(evidenceRoot, file));
        observed.presence = "invalid";
        continue;
      }
      const diagnostic = payload?.fusionShardDiagnostic;
      if (diagnostic !== undefined && (!diagnostic || typeof diagnostic !== "object" || typeof diagnostic.stage !== "string")) {
        invalid(reasons, "malformed-shard-diagnostic", artifact, path.relative(evidenceRoot, file));
        observed.presence = "invalid";
        continue;
      }
      reports.push({
        path: path.relative(evidenceRoot, file),
        testResultCount: payload.testResults.length,
        failedFullNames: [...new Set(failedFullNames)].sort(),
        ...(diagnostic ? { diagnostic } : {}),
      });
    }
    shards.push({ artifact, reports });
  }

  const expectedKeys = options.expectedKeys ?? expectedPipelineKeys();
  const pipelineRoot = path.join(evidenceRoot, "pipeline-smoke-report");
  const pipelineFiles = await jsonFiles(pipelineRoot);
  let normalizedPipelineSmoke;
  if (pipelineFiles.length !== 1) {
    invalid(reasons, "pipeline-report-count", "pipeline-smoke-report", String(pipelineFiles.length));
  } else {
    try {
      const pipelineSmoke = JSON.parse(await readFile(pipelineFiles[0], "utf8"));
      const records = pipelineSmoke.records;
      const recordKeys = Array.isArray(records)
        ? records.map((record) => `${record?.scenarioId ?? ""}\u0000${record?.workflowId ?? ""}\u0000${record?.variant ?? ""}`)
        : [];
      const completeCensus = Array.isArray(records)
        && records.length === expectedKeys.length
        && new Set(recordKeys).size === recordKeys.length
        && JSON.stringify([...recordKeys].sort()) === JSON.stringify(expectedKeys)
        && Array.isArray(pipelineSmoke.invocationKeys)
        && JSON.stringify([...pipelineSmoke.invocationKeys].sort()) === JSON.stringify(expectedKeys);
      const valid = env.PIPELINE_SMOKE_RESULT === "success"
        && pipelineSmoke?.passed === true
        && pipelineSmoke.durationBudgetMs === 175000
        && Number.isInteger(pipelineSmoke.durationMs)
        && pipelineSmoke.durationMs >= 0
        && pipelineSmoke.durationMs <= 175000
        && completeCensus
        && !records.some((record) => record?.verdict !== "pass" || record?.expectedTerminal !== record?.observedTerminal || record?.wedge);
      if (!valid) invalid(reasons, "invalid-pipeline-smoke-report", "pipeline-smoke-report");
      else {
        normalizedPipelineSmoke = {
          report: path.relative(evidenceRoot, pipelineFiles[0]),
          conclusion: env.PIPELINE_SMOKE_RESULT,
          durationMs: pipelineSmoke.durationMs,
          durationBudgetMs: pipelineSmoke.durationBudgetMs,
          invocationCount: records.length,
        };
      }
    } catch {
      invalid(reasons, "malformed-pipeline-smoke-json", "pipeline-smoke-report");
    }
  }

  /*
  FNXC:PostMergeFullSuiteEvidence 2026-10-05-13:00:
  A reached collector must retain an absence record after a producer is cancelled or malformed,
  but that record is diagnostic only. Qualification still requires all four genuine timing
  artifacts and a valid Pipeline smoke report, so this boundary never manufactures approval.
  */
  const evidence = reasons.length === 0
    ? {
      version: 2,
      run: runIdentity(env),
      producers: producerConclusions(env),
      shards,
      pipelineSmoke: normalizedPipelineSmoke,
    }
    : {
      version: 3,
      status: "incomplete",
      run: runIdentity(env),
      producers: producerConclusions(env),
      expectedArtifacts,
      shards,
      ...(normalizedPipelineSmoke ? { pipelineSmoke: normalizedPipelineSmoke } : {}),
      failureReasons: reasons,
      qualification: { eligible: false },
    };

  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeFile(outputFile, `${JSON.stringify(evidence, null, 2)}\n`);
  if (reasons.length > 0) throw new EvidenceValidationError(reasons);
  return evidence;
}

async function main() {
  try {
    const evidence = await collectPostMergeFullSuiteEvidence();
    console.log(`Retained ${evidence.shards.length} shard artifacts and ${evidence.pipelineSmoke.invocationCount} Pipeline smoke records; test-shards=${process.env.TEST_SHARDS_RESULT}, pipeline-smoke=${process.env.PIPELINE_SMOKE_RESULT}.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
