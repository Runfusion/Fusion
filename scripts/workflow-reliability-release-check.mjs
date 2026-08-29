#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const currentFilePath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFilePath), "..");

export const DEFAULT_MANIFEST_PATH = "scripts/lib/workflow-reliability-release-check.json";
export const KNOWN_PACKAGES = new Map([
  ["@fusion/core", "packages/core"],
  ["@fusion/dashboard", "packages/dashboard"],
  ["@fusion/engine", "packages/engine"],
]);
export const DEFAULT_COMMAND_TIMEOUT_MS = 300_000;

/**
 * FNXC:CustomWorkflowReliability 2026-06-19-00:00:
 * FN-6694 makes the custom-workflow reliability release checklist executable for QA without adding it to the merge gate. Keep this harness on-demand, targeted to manifest-listed Vitest seams only, and fail closed when a manifest seam path is missing so release evidence cannot silently drift.
 */
export function loadManifest(manifestPath = DEFAULT_MANIFEST_PATH, { rootDir = repoRoot } = {}) {
  const absolutePath = path.isAbsolute(manifestPath) ? manifestPath : path.join(rootDir, manifestPath);
  return JSON.parse(readFileSync(absolutePath, "utf8"));
}

function normalizeManual(manifest) {
  const manualEntries = Array.isArray(manifest?.manual) ? manifest.manual : [];
  return new Map(manualEntries.map((entry) => [entry?.id, entry]));
}

function validateSeam(seam, item, index, seamIndex, { repoRoot: rootDir, existsSync: fileExists }) {
  const errors = [];
  const label = `checklist[${index}] ${item?.id ?? "<missing-id>"} seams[${seamIndex}]`;
  if (!seam || typeof seam !== "object") {
    errors.push(`${label} must be an object`);
    return errors;
  }
  if (!KNOWN_PACKAGES.has(seam.package)) {
    errors.push(`${label} references unknown package ${JSON.stringify(seam.package)}`);
  }
  if (!seam.file || typeof seam.file !== "string") {
    errors.push(`${label} must include a repo-relative file`);
  } else {
    const normalizedFile = path.normalize(seam.file);
    if (path.isAbsolute(seam.file) || normalizedFile.startsWith("..") || normalizedFile.includes(`${path.sep}..${path.sep}`)) {
      errors.push(`${label} file must stay within the repository: ${seam.file}`);
    } else if (!fileExists(path.join(rootDir, seam.file))) {
      errors.push(`${label} file does not exist: ${seam.file}`);
    }
  }
  return errors;
}

export function validateManifest(manifest, { repoRoot: rootDir = repoRoot, existsSync: fileExists = existsSync } = {}) {
  const errors = [];
  if (!manifest || typeof manifest !== "object") {
    return { ok: false, errors: ["manifest must be an object"] };
  }
  if (manifest.version !== 1) errors.push("manifest.version must be 1");
  if (!Array.isArray(manifest.checklist)) errors.push("manifest.checklist must be an array");

  const manualById = normalizeManual(manifest);
  const checklist = Array.isArray(manifest.checklist) ? manifest.checklist : [];
  const seenIds = new Set();
  checklist.forEach((item, index) => {
    const label = `checklist[${index}]`;
    if (!item || typeof item !== "object") {
      errors.push(`${label} must be an object`);
      return;
    }
    if (!item.id || typeof item.id !== "string") {
      errors.push(`${label} must include an id`);
    } else if (seenIds.has(item.id)) {
      errors.push(`${label} duplicates id ${item.id}`);
    } else {
      seenIds.add(item.id);
    }
    if (!item.title || typeof item.title !== "string") errors.push(`${label} ${item.id ?? "<missing-id>"} must include a title`);
    if (!item.journey || typeof item.journey !== "string") errors.push(`${label} ${item.id ?? "<missing-id>"} must include a journey`);

    const seams = Array.isArray(item.seams) ? item.seams : [];
    const manual = manualById.get(item.id);
    const manualReason = typeof manual?.automationDeferredReason === "string" ? manual.automationDeferredReason.trim() : "";
    if (seams.length === 0 && manualReason.length === 0) {
      errors.push(`${label} ${item.id ?? "<missing-id>"} must have at least one seam or a manual automationDeferredReason`);
    }
    seams.forEach((seam, seamIndex) => {
      errors.push(...validateSeam(seam, item, index, seamIndex, { repoRoot: rootDir, existsSync: fileExists }));
    });
  });

  const manual = Array.isArray(manifest.manual) ? manifest.manual : [];
  manual.forEach((entry, index) => {
    if (!entry?.id || typeof entry.id !== "string") errors.push(`manual[${index}] must include an id`);
    if (!entry?.title || typeof entry.title !== "string") errors.push(`manual[${index}] ${entry?.id ?? "<missing-id>"} must include a title`);
    if (!entry?.automationDeferredReason || typeof entry.automationDeferredReason !== "string" || entry.automationDeferredReason.trim().length === 0) {
      errors.push(`manual[${index}] ${entry?.id ?? "<missing-id>"} must include a non-empty automationDeferredReason`);
    }
    if (entry?.id && !seenIds.has(entry.id)) errors.push(`manual[${index}] references unknown checklist id ${entry.id}`);
  });

  return { ok: errors.length === 0, errors };
}

function distinctSeams(manifest) {
  const seen = new Set();
  const seams = [];
  for (const item of manifest.checklist ?? []) {
    for (const seam of item.seams ?? []) {
      const key = `${seam.package}\u0000${seam.file}`;
      if (seen.has(key)) continue;
      seen.add(key);
      seams.push({ package: seam.package, file: seam.file });
    }
  }
  return seams;
}

export function planCommands(manifest) {
  const byPackage = new Map();
  for (const seam of distinctSeams(manifest)) {
    if (!byPackage.has(seam.package)) byPackage.set(seam.package, []);
    byPackage.get(seam.package).push(seam.file);
  }

  return [...byPackage.entries()].map(([packageName, files]) => {
    const packageRoot = KNOWN_PACKAGES.get(packageName);
    const packageRelativeFiles = files.map((file) => path.relative(packageRoot, file));
    return {
      package: packageName,
      files,
      command: "pnpm",
      args: ["--filter", packageName, "exec", "vitest", "run", ...packageRelativeFiles, "--silent=passed-only", "--reporter=dot"],
    };
  });
}

function runProcess(command, args, { cwd, timeoutMs, stdout = process.stdout, stderr = process.stderr } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, shell: false, detached: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdoutText = "";
    let stderrText = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      stdoutText += text;
      stdout?.write?.(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      stderrText += text;
      stderr?.write?.(text);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, timedOut, stdout: stdoutText, stderr: `${stderrText}${error.message}\n` });
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode: exitCode ?? 1, signal, timedOut, stdout: stdoutText, stderr: stderrText });
    });
  });
}

export async function runReleaseCheck(manifest, { rootDir = repoRoot, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS, stdout = process.stdout, stderr = process.stderr } = {}) {
  const commands = planCommands(manifest);
  const seamResults = new Map();
  for (const planned of commands) {
    stdout?.write?.(`Running: ${planned.command} ${planned.args.join(" ")}\n`);
    const result = await runProcess(planned.command, planned.args, { cwd: rootDir, timeoutMs, stdout, stderr });
    for (const file of planned.files) {
      seamResults.set(file, {
        package: planned.package,
        file,
        status: result.exitCode === 0 && !result.timedOut ? "PASS" : "FAIL",
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        command: `${planned.command} ${planned.args.join(" ")}`,
      });
    }
  }

  return (manifest.checklist ?? []).map((item) => {
    const seams = (item.seams ?? []).map((seam) => seamResults.get(seam.file) ?? { ...seam, status: "FAIL", exitCode: null, timedOut: false, command: null });
    const manual = (manifest.manual ?? []).find((entry) => entry.id === item.id) ?? null;
    return { id: item.id, title: item.title, journey: item.journey, seams, manual };
  });
}

export function summarize(results) {
  const items = results.map((result) => {
    const seamStatuses = (result.seams ?? []).map((seam) => seam.status);
    const hasFailure = seamStatuses.includes("FAIL");
    const hasPass = seamStatuses.includes("PASS");
    const manualReason = typeof result.manual?.automationDeferredReason === "string" ? result.manual.automationDeferredReason.trim() : "";
    const status = hasFailure ? "FAIL" : hasPass ? "PASS" : manualReason ? "MANUAL" : "FAIL";
    return { ...result, status };
  });
  const counts = {
    pass: items.filter((item) => item.status === "PASS").length,
    fail: items.filter((item) => item.status === "FAIL").length,
    manual: items.filter((item) => item.status === "MANUAL").length,
    total: items.length,
  };
  return { ok: counts.fail === 0, counts, items };
}

export function renderReport(summary, { json = false } = {}) {
  if (json) return `${JSON.stringify(summary, null, 2)}\n`;
  const lines = [
    "Custom workflow reliability release-check",
    `Overall: ${summary.ok ? "PASS" : "FAIL"} (${summary.counts.pass} passed, ${summary.counts.fail} failed, ${summary.counts.manual} manual, ${summary.counts.total} total)`,
    "",
  ];
  for (const item of summary.items) {
    lines.push(`${item.status}: ${item.id} — ${item.title}`);
    for (const seam of item.seams ?? []) {
      lines.push(`  - ${seam.status}: ${seam.file} (${seam.package})`);
    }
    if (item.manual?.automationDeferredReason) {
      lines.push(`  - MANUAL: ${item.manual.automationDeferredReason}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function parseArgs(argv) {
  const args = { dryRun: false, json: false, manifestPath: DEFAULT_MANIFEST_PATH, timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--manifest") args.manifestPath = argv[++index];
    else if (arg === "--timeout-ms") args.timeoutMs = Number(argv[++index]);
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) throw new Error("--timeout-ms must be a positive number");
  return args;
}

function renderDryRun(manifest) {
  const commands = planCommands(manifest);
  const results = (manifest.checklist ?? []).map((item) => ({
    id: item.id,
    title: item.title,
    journey: item.journey,
    seams: (item.seams ?? []).map((seam) => ({ ...seam, status: "PASS", exitCode: 0, timedOut: false, command: null })),
    manual: (manifest.manual ?? []).find((entry) => entry.id === item.id) ?? null,
  }));
  return { commands, summary: summarize(results) };
}

export async function main(argv = process.argv.slice(2), { rootDir = repoRoot, stdout = process.stdout, stderr = process.stderr } = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 1;
  }
  if (args.help) {
    stdout.write("Usage: node scripts/workflow-reliability-release-check.mjs [--dry-run] [--json] [--manifest <path>] [--timeout-ms <ms>]\n");
    return 0;
  }

  let manifest;
  try {
    manifest = loadManifest(args.manifestPath, { rootDir });
  } catch (error) {
    const summary = { ok: false, counts: { pass: 0, fail: 1, manual: 0, total: 1 }, items: [{ id: "manifest", title: "Manifest load", status: "FAIL", seams: [], error: error.message }] };
    stdout.write(renderReport(summary, { json: args.json }));
    return 1;
  }

  const validation = validateManifest(manifest, { repoRoot: rootDir, existsSync });
  if (!validation.ok) {
    const summary = { ok: false, counts: { pass: 0, fail: validation.errors.length, manual: 0, total: validation.errors.length }, items: validation.errors.map((error, index) => ({ id: `manifest-${index + 1}`, title: error, status: "FAIL", seams: [] })) };
    stdout.write(renderReport(summary, { json: args.json }));
    return 1;
  }

  if (args.dryRun) {
    const dryRun = renderDryRun(manifest);
    if (args.json) {
      stdout.write(`${JSON.stringify({ ok: dryRun.summary.ok, dryRun: true, commands: dryRun.commands, summary: dryRun.summary }, null, 2)}\n`);
    } else {
      stdout.write("Dry run: manifest is valid. Planned commands:\n");
      for (const command of dryRun.commands) stdout.write(`- ${command.command} ${command.args.join(" ")}\n`);
      stdout.write("\n");
      stdout.write(renderReport(dryRun.summary));
    }
    return dryRun.summary.ok ? 0 : 1;
  }

  const results = await runReleaseCheck(manifest, { rootDir, timeoutMs: args.timeoutMs, stdout: args.json ? { write: () => {} } : stdout, stderr });
  const summary = summarize(results);
  stdout.write(renderReport(summary, { json: args.json }));
  return summary.ok ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const exitCode = await main();
  process.exitCode = exitCode;
}
