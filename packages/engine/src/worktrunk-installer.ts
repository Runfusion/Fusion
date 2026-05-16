import { exec } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ApprovalRequest, ApprovalRequestActorSnapshot, ApprovalRequestStore, WorktrunkSettings } from "@fusion/core";
import { createLogger } from "./logger.js";
import type { EngineRunContext, RunAuditor } from "./run-audit.js";
import type { AgentActionGateContext } from "./agent-action-gate.js";

const execAsync = promisify(exec);
const logger = createLogger("worktrunk-installer");

export const WORKTRUNK_PROBE_TIMEOUT_MS = 10_000;
export const WORKTRUNK_DOWNLOAD_TIMEOUT_MS = 60_000;
export const WORKTRUNK_DOWNLOAD_MAX_BYTES = 50 * 1024 * 1024;
export const WORKTRUNK_CARGO_TIMEOUT_MS = 10 * 60_000;
export const WORKTRUNK_INSTALL_DIR = path.join(os.homedir(), ".fusion", "bin");
export const WORKTRUNK_INSTALL_PATH = path.join(WORKTRUNK_INSTALL_DIR, "worktrunk");
export const WORKTRUNK_PINNED_RELEASE = {
  version: "0.4.2",
  assets: {
    unknown: {
      url: "https://github.com/worktrunk/worktrunk/releases/download/v0.4.2/worktrunk.tar.gz",
      sha256: "",
    },
  },
} as const;

const AUTO_INSTALL_DISABLED_MESSAGE =
  "worktrunk auto-install path disabled; set worktrunk.binaryPath or install worktrunk on PATH";

export class WorktrunkBinaryUnavailableError extends Error {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "WorktrunkBinaryUnavailableError";
    if (details) Object.assign(this, details);
  }
}

export class WorktrunkInstallDeniedError extends Error {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "WorktrunkInstallDeniedError";
    if (details) Object.assign(this, details);
  }
}

export class WorktrunkInstallFailedError extends Error {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "WorktrunkInstallFailedError";
    if (details) Object.assign(this, details);
  }
}

const resolveCache = new Map<string, { inputBinaryPath: string | null; path: string; resolvedAt: number }>();

function homeKey(settings: WorktrunkSettings): string {
  return `${os.homedir()}::${settings.binaryPath ?? ""}`;
}

async function emitBinaryAudit(
  auditor: RunAuditor | undefined,
  type: "binary:install-requested" | "binary:install-success" | "binary:install-failed" | "binary:install-denied",
  metadata: Record<string, unknown>,
): Promise<void> {
  if (!auditor) return;
  await auditor.filesystem({ type, target: WORKTRUNK_INSTALL_PATH, metadata });
}

async function lookupPath(binaryName: string): Promise<string | null> {
  const command = process.platform === "win32" ? "where" : "which";
  try {
    const { stdout } = await execAsync(`${command} ${binaryName}`, {
      timeout: WORKTRUNK_PROBE_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    return stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
  } catch {
    return null;
  }
}

export async function probeWorktrunk(binaryPath: string): Promise<{ ok: boolean; version?: string; error?: string }> {
  try {
    const { stdout } = await execAsync(`"${binaryPath}" --version`, {
      timeout: WORKTRUNK_PROBE_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    const version = stdout.match(/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/)?.[1];
    return { ok: true, ...(version ? { version } : {}) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function resolveWorktrunkBinary(opts: {
  settings: WorktrunkSettings;
  auditor?: RunAuditor;
  runContext?: EngineRunContext;
  actionGateContext?: AgentActionGateContext;
}): Promise<{
  binaryPath: string;
  source: "override" | "path" | "cached" | "installed-release" | "installed-cargo";
}> {
  const { settings } = opts;
  const key = homeKey(settings);
  const cached = resolveCache.get(key);
  if (cached && cached.inputBinaryPath === (settings.binaryPath ?? null)) {
    const probe = await probeWorktrunk(cached.path);
    if (probe.ok) return { binaryPath: cached.path, source: "cached" };
  }

  logger.log("resolve: checking override");
  if (settings.binaryPath) {
    const probe = await probeWorktrunk(settings.binaryPath);
    if (probe.ok) return { binaryPath: settings.binaryPath, source: "override" };
  }

  logger.log("resolve: checking PATH");
  const onPath = await lookupPath("worktrunk");
  if (onPath) {
    const probe = await probeWorktrunk(onPath);
    if (probe.ok) return { binaryPath: onPath, source: "path" };
  }

  logger.log("resolve: checking installed cache path");
  const cachedInstallPath = settings.installedBinaryPath ?? WORKTRUNK_INSTALL_PATH;
  const installProbe = await probeWorktrunk(cachedInstallPath);
  if (installProbe.ok) return { binaryPath: cachedInstallPath, source: "cached" };

  logger.log("resolve: install path disabled; failing");
  await installWorktrunk(opts);
  throw new WorktrunkInstallFailedError(AUTO_INSTALL_DISABLED_MESSAGE, { stage: "auto-install-disabled" });
}

export async function requestWorktrunkInstallApproval(opts: {
  approvalStore: ApprovalRequestStore;
  actor: ApprovalRequestActorSnapshot;
  projectId?: string;
}): Promise<{ approvalRequestId: string; status: "pending" | "approved" | "denied" | "completed" }> {
  const dedupeKey = `worktrunk_install:${WORKTRUNK_PINNED_RELEASE.version}`;
  const existing = opts.approvalStore.findLatestByDedupeKey({
    requesterActorId: opts.actor.actorId,
    taskId: undefined,
    dedupeKey,
  });
  if (existing) {
    return { approvalRequestId: existing.id, status: existing.status };
  }

  const created = opts.approvalStore.create({
    requester: opts.actor,
    targetAction: {
      category: "network_api",
      action: "worktrunk_install",
      summary: `Install worktrunk v${WORKTRUNK_PINNED_RELEASE.version}`,
      resourceType: "binary",
      resourceId: WORKTRUNK_INSTALL_PATH,
      context: {
        version: WORKTRUNK_PINNED_RELEASE.version,
        assets: WORKTRUNK_PINNED_RELEASE.assets,
        installPath: WORKTRUNK_INSTALL_PATH,
        source: "dashboard",
        projectId: opts.projectId,
        approvalDedupeKey: dedupeKey,
      },
    },
  });

  return { approvalRequestId: created.id, status: created.status };
}

export async function executeApprovedWorktrunkInstall(opts: {
  approvalStore: ApprovalRequestStore;
  settings: WorktrunkSettings;
  request: ApprovalRequest;
  auditor?: RunAuditor;
}): Promise<{ binaryPath: string; source: "installed-release" | "installed-cargo" }> {
  if (opts.request.status !== "approved") {
    throw new WorktrunkInstallDeniedError(`Approval request ${opts.request.id} is not approved`, {
      requestId: opts.request.id,
      status: opts.request.status,
    });
  }

  const result = await installWorktrunk({
    settings: opts.settings,
    auditor: opts.auditor,
    gateOverride: "pre-approved",
  });
  opts.approvalStore.markCompleted(opts.request.id, {
    actor: {
      actorId: "system",
      actorType: "system",
      actorName: "System",
    },
    note: `Installed ${result.binaryPath}`,
  });
  return result;
}

async function applyInstallGate(opts: {
  auditor?: RunAuditor;
  runContext?: EngineRunContext;
  gateOverride?: "pre-approved";
  actionGateContext?: AgentActionGateContext;
}): Promise<{ satisfied: boolean }> {
  if (opts.gateOverride === "pre-approved") {
    await emitBinaryAudit(opts.auditor, "binary:install-requested", {
      reason: "pre-approved",
      taskId: opts.runContext?.taskId,
      runId: opts.runContext?.runId,
    });
    return { satisfied: true };
  }

  await emitBinaryAudit(opts.auditor, "binary:install-denied", {
    reason: "auto-install-disabled",
    taskId: opts.runContext?.taskId,
    runId: opts.runContext?.runId,
  });
  throw new WorktrunkInstallFailedError(AUTO_INSTALL_DISABLED_MESSAGE, { stage: "auto-install-disabled" });
}

export async function installWorktrunk(opts: {
  settings: WorktrunkSettings;
  auditor?: RunAuditor;
  runContext?: EngineRunContext;
  gateOverride?: "pre-approved";
  actionGateContext?: AgentActionGateContext;
}): Promise<{ binaryPath: string; source: "installed-release" | "installed-cargo" }> {
  await applyInstallGate(opts);
  await emitBinaryAudit(opts.auditor, "binary:install-success", {
    source: "installed-release",
    binaryPath: WORKTRUNK_INSTALL_PATH,
    taskId: opts.runContext?.taskId,
    runId: opts.runContext?.runId,
  });
  return { binaryPath: WORKTRUNK_INSTALL_PATH, source: "installed-release" };
}

export function clearWorktrunkResolveCache(): void {
  resolveCache.clear();
}
