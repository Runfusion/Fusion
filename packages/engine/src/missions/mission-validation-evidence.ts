import { redactSecrets, type TaskDetail } from "@fusion/core";
import { GitCheckoutMaterializer, type CheckoutMaterializer, type DisposableCheckout } from "./mission-verification.js";

export type MissionValidationEvidenceSource =
  | "repository-checkout"
  | "repository-ancestry"
  | "durable-task-evidence"
  | "forge-record";

export interface MissionValidationEvidenceUnavailable {
  source: MissionValidationEvidenceSource;
  retryable: boolean;
  /** A bounded capability label, never a provider error or credential. */
  reason: string;
}

/** A redacted, bounded record that may be supplied to the read-only validator. */
export interface MissionValidationEvidenceRecord {
  source: "durable-task-evidence" | "forge-record";
  identifier: string;
  timestamp?: string;
  excerpt: string;
}

export interface MissionValidationEvidence {
  landedSha: string;
  checkout?: DisposableCheckout;
  records: MissionValidationEvidenceRecord[];
  unavailable?: MissionValidationEvidenceUnavailable;
}

/** Read-only, provider-neutral host bridge for a task's PR or issue records. */
export interface MissionValidationForgeReader {
  read(task: Pick<TaskDetail, "prInfo" | "prInfos" | "sourceIssue" | "source" | "gitlabTracking" | "mergeDetails">): Promise<{
    records?: MissionValidationEvidenceRecord[];
    unavailable?: MissionValidationEvidenceUnavailable;
  }>;
}

/** Backward-compatible host-facing name for the read-only forge bridge. */
export type MissionForgeEvidenceReader = MissionValidationForgeReader;

/**
 * Engine-owned boundary for delivered-code inspection. Hosts may add read-only
 * forge evidence through a separate capability without exposing their clients
 * or credentials to the engine validator.
 */
export interface MissionValidationEvidenceProvider {
  prepare(input: {
    rootDir: string;
    task: Pick<TaskDetail, "mergeDetails" | "log" | "prInfo" | "prInfos" | "sourceIssue" | "source" | "gitlabTracking">;
    landedSha: string;
    requiresForgeEvidence?: boolean;
  }): Promise<MissionValidationEvidence>;
}

const MAX_RECORDS = 12;
const MAX_EXCERPT_LENGTH = 500;

/*
FNXC:MissionValidationEvidence 2026-10-04-22:32:
Task logs can contain tool stderr and command arguments. Redact before creating
an evidence record so no secret-bearing durable text reaches the validator.
*/
function boundedExcerpt(value: string): string {
  return redactSecrets(value).replace(/\s+/g, " ").trim().slice(0, MAX_EXCERPT_LENGTH);
}

function collectDurableEvidence(task: Pick<TaskDetail, "mergeDetails" | "log">): MissionValidationEvidenceRecord[] {
  const mergeSha = task.mergeDetails?.commitSha?.trim();
  const records: MissionValidationEvidenceRecord[] = [];
  if (mergeSha) {
    records.push({
      source: "durable-task-evidence",
      identifier: `landed-commit:${mergeSha}`,
      timestamp: task.mergeDetails?.mergedAt,
      excerpt: `Landed commit ${mergeSha.slice(0, 12)}`,
    });
  }
  for (const [index, entry] of (task.log ?? []).slice(-MAX_RECORDS).entries()) {
    const excerpt = boundedExcerpt(`${entry.action ?? ""} ${entry.outcome ?? ""}`);
    if (!excerpt) continue;
    records.push({
      source: "durable-task-evidence",
      identifier: `task-log:${index}`,
      timestamp: entry.timestamp,
      excerpt,
    });
  }
  return records.slice(0, MAX_RECORDS);
}

/**
 * FNXC:MissionValidationEvidence 2026-10-04-22:14:
 * FN-9464 requires completed features to inspect only the task's landed SHA.
 * A materialization outage is retryable infrastructure evidence, never a
 * permission to inspect an ambient branch or worktree. Bounded durable receipts
 * retain only operator-safe metadata for the read-only validation prompt.
 */
export class LandedValidationEvidenceProvider implements MissionValidationEvidenceProvider {
  constructor(
    private readonly materializer: CheckoutMaterializer = new GitCheckoutMaterializer(),
    private readonly forgeReader?: MissionValidationForgeReader,
  ) {}

  async prepare(input: {
    rootDir: string;
    task: Pick<TaskDetail, "mergeDetails" | "log" | "prInfo" | "prInfos" | "sourceIssue" | "source" | "gitlabTracking">;
    landedSha: string;
    requiresForgeEvidence?: boolean;
  }): Promise<MissionValidationEvidence> {
    const landedSha = input.task.mergeDetails?.commitSha?.trim();
    const records = collectDurableEvidence(input.task);
    if (!landedSha || landedSha !== input.landedSha.trim()) {
      return {
        landedSha: input.landedSha,
        records,
        unavailable: {
          source: "repository-checkout",
          retryable: true,
          reason: "landed merge SHA is unavailable",
        },
      };
    }
    let checkout: DisposableCheckout;
    try {
      checkout = await this.materializer.materialize(input.rootDir, landedSha);
    } catch {
      return {
        landedSha,
        records,
        unavailable: {
          source: "repository-checkout",
          retryable: true,
          reason: "landed revision checkout is unavailable",
        },
      };
    }

    // FNXC:MissionValidationEvidence 2026-10-04-22:12:
    // Repository materialization and forge reads are separate capabilities. A
    // forge outage must retain its own source category instead of masquerading
    // as a checkout failure after delivery code was successfully inspected.
    if (!input.requiresForgeEvidence) return { landedSha, checkout, records };
    if (!this.forgeReader) {
      return {
        landedSha,
        checkout,
        records,
        unavailable: {
          source: "forge-record",
          retryable: true,
          reason: "configured forge reader is unavailable",
        },
      };
    }
    try {
      const forge = await this.forgeReader.read(input.task);
      return {
        landedSha,
        checkout,
        records: [...records, ...(forge.records ?? [])].slice(0, MAX_RECORDS),
        unavailable: forge.unavailable,
      };
    } catch {
      return {
        landedSha,
        checkout,
        records,
        unavailable: {
          source: "forge-record",
          retryable: true,
          reason: "configured forge record read is unavailable",
        },
      };
    }
  }
}
