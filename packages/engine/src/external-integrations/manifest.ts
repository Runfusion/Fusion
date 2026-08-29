export interface ExternalIntegrationReleaseAsset {
  url: string;
  sha256: string;
}

export interface ExternalIntegrationReleaseManifest {
  /** Stable id used in run-audit + diagnostics (e.g. "worktrunk", "cloudflared"). */
  id: string;
  /** Canonical CLI / binary name probed on PATH (e.g. "wt", "cloudflared"). */
  binaryName: string;
  /** Canonical upstream GitHub repo, "<owner>/<repo>" (e.g. "max-sixty/worktrunk"). */
  upstreamRepo: string;
  /** Canonical docs URL (project homepage or docs site). */
  docsUrl: string;
  /** Verification status — `upstream-pending-verification` means assets MUST be empty. */
  source: "upstream-pending-verification" | "upstream-verified";
  version: string | null;
  verifiedAt: string | null;
  assets: Record<string, ExternalIntegrationReleaseAsset>;
}

export interface ExternalIntegrationManifestValidationError {
  ok: false;
  integrationId: string;
  missingFields: string[];
  reason: string;
}

export type ExternalIntegrationManifestValidationResult =
  | { ok: true }
  | ExternalIntegrationManifestValidationError;

const UPSTREAM_REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function asRecord(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  return input as Record<string, unknown>;
}

function pushMissing(missingFields: string[], field: string): void {
  if (!missingFields.includes(field)) missingFields.push(field);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function validateExternalIntegrationManifest(
  input: unknown,
): ExternalIntegrationManifestValidationResult {
  const missingFields: string[] = [];
  const record = asRecord(input);
  const integrationId = nonEmptyString(record?.id) ? record.id : "unknown";

  if (!record) {
    return {
      ok: false,
      integrationId,
      missingFields: ["id", "binaryName", "upstreamRepo", "docsUrl", "source", "version", "verifiedAt", "assets"],
      reason: "External integration manifest must be an object.",
    };
  }

  if (!nonEmptyString(record.id)) pushMissing(missingFields, "id");
  if (!nonEmptyString(record.binaryName)) pushMissing(missingFields, "binaryName");
  if (!nonEmptyString(record.upstreamRepo)) {
    pushMissing(missingFields, "upstreamRepo");
  } else if (!UPSTREAM_REPO_PATTERN.test(record.upstreamRepo)) {
    pushMissing(missingFields, "upstreamRepo");
  }
  if (!nonEmptyString(record.docsUrl)) {
    pushMissing(missingFields, "docsUrl");
  } else if (!record.docsUrl.startsWith("https://")) {
    pushMissing(missingFields, "docsUrl");
  }

  const assetsRecord = asRecord(record.assets);
  if (!assetsRecord) pushMissing(missingFields, "assets");

  const source = record.source;
  if (source !== "upstream-verified" && source !== "upstream-pending-verification") {
    pushMissing(missingFields, "source");
    if (record.version !== null) pushMissing(missingFields, "version");
    if (record.verifiedAt !== null) pushMissing(missingFields, "verifiedAt");
  }

  const trustedHost = nonEmptyString(record.docsUrl)
    ? (() => {
        try {
          return new URL(record.docsUrl).host;
        } catch {
          return "";
        }
      })()
    : "";

  if (source === "upstream-verified") {
    if (!nonEmptyString(record.version)) pushMissing(missingFields, "version");
    if (!nonEmptyString(record.verifiedAt)) pushMissing(missingFields, "verifiedAt");

    if (!assetsRecord || Object.keys(assetsRecord).length === 0) {
      pushMissing(missingFields, "assets");
    } else {
      const upstreamRepo = nonEmptyString(record.upstreamRepo) ? record.upstreamRepo : "";
      const githubPrefix = `https://github.com/${upstreamRepo}/releases/`;
      const trustedPrefix = trustedHost ? `https://${trustedHost}/` : "";

      for (const [assetKey, assetValue] of Object.entries(assetsRecord)) {
        const asset = asRecord(assetValue);
        if (!asset || !nonEmptyString(asset.url)) {
          pushMissing(missingFields, `assets.${assetKey}.url`);
        } else {
          const url = asset.url;
          const urlOk = url.startsWith(githubPrefix) || (trustedPrefix.length > 0 && url.startsWith(trustedPrefix));
          if (!urlOk) pushMissing(missingFields, `assets.${assetKey}.url`);
        }

        if (!asset || !nonEmptyString(asset.sha256) || !SHA256_PATTERN.test(asset.sha256)) {
          pushMissing(missingFields, `assets.${assetKey}.sha256`);
        }
      }
    }
  }

  if (source === "upstream-pending-verification") {
    const hasAssets = assetsRecord && Object.keys(assetsRecord).length > 0;
    if (hasAssets || record.version !== null || record.verifiedAt !== null) {
      pushMissing(missingFields, "assets:must-be-empty-when-pending");
    }
  }

  if (missingFields.length > 0) {
    return {
      ok: false,
      integrationId,
      missingFields,
      reason: `External integration manifest is missing required fields: ${missingFields.join(", ")}`,
    };
  }

  return { ok: true };
}
