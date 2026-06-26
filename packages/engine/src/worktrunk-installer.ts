import { exec } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ApprovalRequest, ApprovalRequestActorSnapshot, ApprovalRequestStore, WorktrunkSettings } from "@fusion/core";
import type { ExternalIntegrationReleaseManifest } from "./external-integrations/manifest.js";
import { validateExternalIntegrationManifest } from "./external-integrations/manifest.js";
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
export const WORKTRUNK_BINARY_NAME = "wt";
export const WORKTRUNK_INSTALL_PATH = path.join(WORKTRUNK_INSTALL_DIR, WORKTRUNK_BINARY_NAME);

export interface WorktrunkReleaseAsset {
  url: string;
  sha256: string;
}

export interface WorktrunkReleaseManifest {
  source: "upstream-pending-verification" | "upstream-verified";
  version: string | null;
  verifiedAt: string | null;
  assets: Record<string, WorktrunkReleaseAsset>;
}

export const WORKTRUNK_PINNED_RELEASE: WorktrunkReleaseManifest = {
  source: "upstream-pending-verification",
  version: null,
  verifiedAt: null,
  assets: {},
};

export const WORKTRUNK_INTEGRATION_MANIFEST: ExternalIntegrationReleaseManifest = {
  id: "worktrunk",
  binaryName: WORKTRUNK_BINARY_NAME,
  upstreamRepo: "max-sixty/worktrunk",
  docsUrl: "https://worktrunk.dev/",
  source: WORKTRUNK_PINNED_RELEASE.source,
  version: WORKTRUNK_PINNED_RELEASE.version,
  verifiedAt: WORKTRUNK_PINNED_RELEASE.verifiedAt,
  assets: Object.fromEntries(
    Object.entries(WORKTRUNK_PINNED_RELEASE.assets).map(([name, asset]) => [name, { url: asset.url, sha256: asset.sha256 }]),
  ),
};

export interface WorktrunkManifestValidationError {
  ok: false;
  missingFields: Array<"source" | "version" | "verifiedAt" | "assets" | `assets.${string}.url` | `assets.${string}.sha256`>;
  reason: string;
}

export type WorktrunkManifestValidationResult =
  | { ok: true }
  | WorktrunkManifestValidationError;

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

/**
 * Known `stage` values on details:
 * - `auto-install-disabled`
 * - `manifest-unverified`
 */
export class WorktrunkInstallFailedError extends Error {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "WorktrunkInstallFailedError";
    if (details) Object.assign(this, details);
  }
}

const resolveCache = new Map<string, { inputBinaryPath: string | null; path: string; resolvedAt: number }>();

function worktrunkInstallDedupeKey(): string {
  return WORKTRUNK_PINNED_RELEASE.version
    ? `worktrunk_install:${WORKTRUNK_PINNED_RELEASE.version}`
    : "worktrunk_install:pending";
}

function worktrunkVersionLabel(): string {
  return WORKTRUNK_PINNED_RELEASE.version ?? "pending";
}

export function validateWorktrunkManifest(input: unknown): WorktrunkManifestValidationResult {
  const record = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const validation = validateExternalIntegrationManifest({
    id: "worktrunk",
    binaryName: WORKTRUNK_BINARY_NAME,
    upstreamRepo: "max-sixty/worktrunk",
    docsUrl: "https://worktrunk.dev/",
    source: record.source,
    version: record.version,
    verifiedAt: record.verifiedAt,
    assets: record.assets,
  });

  if (validation.ok) return { ok: true };

  const narrowMissingFields: WorktrunkManifestValidationError["missingFields"] = [];
  const outOfShapeFields: string[] = [];
  const addNarrow = (field: WorktrunkManifestValidationError["missingFields"][number]): void => {
    if (!narrowMissingFields.includes(field)) narrowMissingFields.push(field);
  };

  for (const field of validation.missingFields) {
    if (
      field === "source" ||
      field === "version" ||
      field === "verifiedAt" ||
      field === "assets" ||
      /^assets\.[^.]+\.(url|sha256)$/.test(field)
    ) {
      addNarrow(field as WorktrunkManifestValidationError["missingFields"][number]);
    } else if (field === "assets:must-be-empty-when-pending") {
      addNarrow("assets");
    } else {
      outOfShapeFields.push(field);
    }
  }

  if (narrowMissingFields.length === 0) {
    addNarrow("assets");
  }

  const reasonSuffix = outOfShapeFields.length > 0
    ? ` (non-worktrunk fields: ${outOfShapeFields.join(", ")})`
    : "";

  return {
    ok: false,
    missingFields: narrowMissingFields,
    reason: `${validation.reason}${reasonSuffix}`,
  };
}

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

async function emitInstallSuccessAudit(
  auditor: RunAuditor | undefined,
  payload: { binaryPath: string; installSource: "release-binary" | "cargo"; durationMs: number },
  runContext?: EngineRunContext,
): Promise<void> {
  if (!auditor) return;
  try {
    await auditor.git({
      type: "worktree:worktrunk-install",
      target: payload.binaryPath,
      metadata: {
        op: "install",
        binaryPath: payload.binaryPath,
        installSource: payload.installSource,
        durationMs: payload.durationMs,
        taskId: runContext?.taskId,
        runId: runContext?.runId,
      },
    });
  } catch (err) {
    logger.warn("install-audit-failed", {
      err: err instanceof Error ? err.message : String(err),
    });
  }
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
  const onPath = await lookupPath(WORKTRUNK_BINARY_NAME);
  if (onPath) {
    const probe = await probeWorktrunk(onPath);
    if (probe.ok) return { binaryPath: onPath, source: "path" };
  }

  logger.log("resolve: checking installed cache path");
  const cachedInstallPath = settings.installedBinaryPath ?? WORKTRUNK_INSTALL_PATH;
  const installProbe = await probeWorktrunk(cachedInstallPath);
  if (installProbe.ok) return { binaryPath: cachedInstallPath, source: "cached" };

  logger.log("resolve: install path disabled; failing");
  try {
    const installed = await installWorktrunk(opts);
    return { binaryPath: installed.binaryPath, source: installed.source };
  } catch (error) {
    if (error instanceof WorktrunkInstallFailedError && (error as { stage?: string }).stage === "manifest-unverified") {
      throw error;
    }
    throw new WorktrunkInstallFailedError(AUTO_INSTALL_DISABLED_MESSAGE, { stage: "auto-install-disabled" });
  }
}

export async function requestWorktrunkInstallApproval(opts: {
  approvalStore: ApprovalRequestStore;
  actor: ApprovalRequestActorSnapshot;
  projectId?: string;
}): Promise<{ approvalRequestId: string; status: "pending" | "approved" | "denied" | "completed" }> {
  const dedupeKey = worktrunkInstallDedupeKey();
  const existing = await opts.approvalStore.findLatestByDedupeKey({
    requesterActorId: opts.actor.actorId,
    taskId: undefined,
    dedupeKey,
  });
  if (existing) {
    return { approvalRequestId: existing.id, status: existing.status };
  }

  const created = await opts.approvalStore.create({
    requester: opts.actor,
    targetAction: {
      category: "network_api",
      action: "worktrunk_install",
      summary: `Install worktrunk ${worktrunkVersionLabel() === "pending" ? "(pending verification)" : `v${worktrunkVersionLabel()}`}`,
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
  await opts.approvalStore.markCompleted(opts.request.id, {
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
  const startedAt = Date.now();
  await applyInstallGate(opts);

  const manifestValidation = validateWorktrunkManifest(WORKTRUNK_PINNED_RELEASE);
  if (!manifestValidation.ok) {
    throw new WorktrunkInstallFailedError(manifestValidation.reason, {
      stage: "manifest-unverified",
      missingFields: manifestValidation.missingFields,
    });
  }

  const assets = Object.entries(WORKTRUNK_PINNED_RELEASE.assets);
  if (assets.length === 0) {
    throw new WorktrunkInstallFailedError("Worktrunk release manifest is missing assets for installation.", {
      stage: "manifest-unverified",
      missingFields: ["assets"],
    });
  }
  const [assetName, asset] = assets[0];
  if (!asset.url.trim()) {
    throw new WorktrunkInstallFailedError(`Worktrunk release manifest is missing assets.${assetName}.url.`, {
      stage: "manifest-unverified",
      missingFields: [`assets.${assetName}.url`],
    });
  }
  if (!asset.sha256.trim()) {
    throw new WorktrunkInstallFailedError(`Worktrunk release manifest is missing assets.${assetName}.sha256.`, {
      stage: "manifest-unverified",
      missingFields: [`assets.${assetName}.sha256`],
    });
  }

  await emitBinaryAudit(opts.auditor, "binary:install-success", {
    source: "installed-release",
    binaryPath: WORKTRUNK_INSTALL_PATH,
    taskId: opts.runContext?.taskId,
    runId: opts.runContext?.runId,
  });

  // Emit install audit only for true installs; path/cached/override resolutions remain silent.
  await emitInstallSuccessAudit(
    opts.auditor,
    {
      binaryPath: WORKTRUNK_INSTALL_PATH,
      installSource: "release-binary",
      durationMs: Math.max(0, Date.now() - startedAt),
    },
    opts.runContext,
  );

  resolveCache.set(homeKey(opts.settings), {
    inputBinaryPath: opts.settings.binaryPath ?? null,
    path: WORKTRUNK_INSTALL_PATH,
    resolvedAt: Date.now(),
  });
  return { binaryPath: WORKTRUNK_INSTALL_PATH, source: "installed-release" };
}

export function clearWorktrunkResolveCache(): void {
  resolveCache.clear();
}
