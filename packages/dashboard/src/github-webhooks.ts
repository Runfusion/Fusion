import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IssueInfo, PrInfo } from "@kb/core";
import { GitHubClient } from "./github.js";

/**
 * GitHub App webhook configuration from environment variables.
 */
export interface GitHubAppConfig {
  appId: string;
  privateKey: string;
  webhookSecret: string;
}

/**
 * Supported GitHub webhook events for badge updates.
 */
export type SupportedGitHubEvent = "ping" | "pull_request" | "issues" | "issue_comment";

/**
 * Classification result for an incoming webhook event.
 */
export interface WebhookEventClassification {
  /** Whether this event type is supported at all */
  supported: boolean;
  /** Whether this specific event payload warrants a badge refresh */
  relevant: boolean;
  /** The resource type this event affects, if relevant */
  resourceType?: "pr" | "issue";
  /** Repository owner from the event */
  owner?: string;
  /** Repository name from the event */
  repo?: string;
  /** PR or issue number from the event */
  number?: number;
  /** Installation ID for App authentication */
  installationId?: number;
}

/**
 * Parsed badge URL components for matching tasks.
 */
export interface BadgeUrlComponents {
  owner: string;
  repo: string;
  number: number;
  resourceType: "pr" | "issue";
}

/**
 * Result of webhook signature verification.
 */
export interface VerificationResult {
  valid: boolean;
  error?: string;
}

/**
 * Read GitHub App configuration from environment variables.
 * Supports KB_GITHUB_APP_PRIVATE_KEY or KB_GITHUB_APP_PRIVATE_KEY_PATH.
 */
export function getGitHubAppConfig(): GitHubAppConfig | null {
  const appId = process.env.KB_GITHUB_APP_ID;
  const webhookSecret = process.env.KB_GITHUB_WEBHOOK_SECRET;

  let privateKey: string | undefined;
  
  if (process.env.KB_GITHUB_APP_PRIVATE_KEY) {
    privateKey = process.env.KB_GITHUB_APP_PRIVATE_KEY;
  } else if (process.env.KB_GITHUB_APP_PRIVATE_KEY_PATH) {
    try {
      privateKey = readFileSync(process.env.KB_GITHUB_APP_PRIVATE_KEY_PATH, "utf-8");
    } catch {
      // Failed to read key file
      return null;
    }
  }

  if (!appId || !privateKey || !webhookSecret) {
    return null;
  }

  return { appId, privateKey, webhookSecret };
}

/**
 * Validate that GitHub App configuration is complete.
 */
export function isGitHubAppConfigured(): boolean {
  return getGitHubAppConfig() !== null;
}

/**
 * Verify the X-Hub-Signature-256 header against the raw request body.
 * Uses constant-time comparison to prevent timing attacks.
 */
export function verifyWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): VerificationResult {
  if (!signatureHeader) {
    return { valid: false, error: "Missing signature header" };
  }

  // Expected format: "sha256=<hex_signature>"
  const expectedSignature = createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  const expectedHeader = `sha256=${expectedSignature}`;

  // Constant-time comparison to prevent timing attacks
  if (signatureHeader.length !== expectedHeader.length) {
    return { valid: false, error: "Signature mismatch" };
  }

  try {
    const signatureBuffer = Buffer.from(signatureHeader);
    const expectedBuffer = Buffer.from(expectedHeader);
    
    if (!timingSafeEqual(signatureBuffer, expectedBuffer)) {
      return { valid: false, error: "Signature mismatch" };
    }
  } catch {
    return { valid: false, error: "Signature verification failed" };
  }

  return { valid: true };
}

/**
 * Classify a GitHub webhook event to determine if it requires badge refresh.
 */
export function classifyWebhookEvent(
  eventType: string | undefined,
  payload: unknown,
): WebhookEventClassification {
  if (!eventType) {
    return { supported: false, relevant: false };
  }

  const typedPayload = payload as Record<string, unknown> | undefined;
  const repository = typedPayload?.repository as Record<string, unknown> | undefined;
  const repositoryOwner = repository?.owner as Record<string, unknown> | undefined;
  
  const owner = typeof repositoryOwner?.login === "string" 
    ? repositoryOwner.login 
    : undefined;
  const repo = typeof repository?.name === "string" 
    ? repository.name 
    : undefined;
  const installationData = typedPayload?.installation as Record<string, unknown> | undefined;
  const installationId = typeof installationData?.id === "number"
    ? installationData.id
    : undefined;

  // Handle ping events (health check from GitHub)
  if (eventType === "ping") {
    return { 
      supported: true, 
      relevant: false,
      owner,
      repo,
      installationId,
    };
  }

  // Handle pull_request events
  if (eventType === "pull_request") {
    const prNumber = typeof typedPayload?.number === "number" 
      ? typedPayload.number 
      : undefined;
    
    // All pull_request events are relevant for PR badges
    if (owner && repo && prNumber !== undefined) {
      return {
        supported: true,
        relevant: true,
        resourceType: "pr",
        owner,
        repo,
        number: prNumber,
        installationId,
      };
    }
    
    return { supported: true, relevant: false, owner, repo, installationId };
  }

  // Handle issues events
  if (eventType === "issues") {
    const issuePayload = typedPayload?.issue as Record<string, unknown> | undefined;
    const issueNumber = typeof issuePayload?.number === "number"
      ? issuePayload.number
      : undefined;
    
    // All issues events are relevant for issue badges
    if (owner && repo && issueNumber !== undefined) {
      return {
        supported: true,
        relevant: true,
        resourceType: "issue",
        owner,
        repo,
        number: issueNumber,
        installationId,
      };
    }
    
    return { supported: true, relevant: false, owner, repo, installationId };
  }

  // Handle issue_comment events (only relevant when on a PR)
  if (eventType === "issue_comment") {
    const issueData = typedPayload?.issue as Record<string, unknown> | undefined;
    const commentNumber = typeof issueData?.number === "number" ? issueData.number : undefined;
    const isPullRequest = issueData?.pull_request !== undefined;
    
    // Only process issue_comment events on PRs (not regular issues)
    if (isPullRequest && owner && repo && commentNumber !== undefined) {
      return {
        supported: true,
        relevant: true,
        resourceType: "pr",
        owner,
        repo,
        number: commentNumber,
        installationId,
      };
    }
    
    return { supported: true, relevant: false, owner, repo, installationId };
  }

  // Unsupported event type
  return { supported: false, relevant: false, owner, repo, installationId };
}

/**
 * Parse a GitHub badge URL (PR or issue) into its components.
 * Supports formats like:
 * - https://github.com/owner/repo/pull/123
 * - https://github.com/owner/repo/issues/123
 */
export function parseBadgeUrl(url: string): BadgeUrlComponents | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "github.com") {
      return null;
    }

    const pathParts = parsed.pathname.split("/").filter(Boolean);
    if (pathParts.length < 4) {
      return null;
    }

    const [owner, repo, type, numberStr] = pathParts;
    const number = parseInt(numberStr, 10);

    if (!owner || !repo || !Number.isFinite(number) || number < 1) {
      return null;
    }

    let resourceType: "pr" | "issue";
    if (type === "pull") {
      resourceType = "pr";
    } else if (type === "issues") {
      resourceType = "issue";
    } else {
      return null;
    }

    return { owner, repo, number, resourceType };
  } catch {
    return null;
  }
}

/**
 * Check if two badge URL components refer to the same resource.
 */
export function isSameResource(
  a: BadgeUrlComponents,
  b: BadgeUrlComponents,
): boolean {
  return (
    a.owner.toLowerCase() === b.owner.toLowerCase() &&
    a.repo.toLowerCase() === b.repo.toLowerCase() &&
    a.number === b.number &&
    a.resourceType === b.resourceType
  );
}

/**
 * Check if PR badge-relevant fields have changed (excluding lastCheckedAt).
 */
export function hasPrBadgeFieldsChanged(
  current: PrInfo | undefined,
  next: Omit<PrInfo, "lastCheckedAt">,
): boolean {
  if (!current) return true;

  return (
    current.url !== next.url ||
    current.number !== next.number ||
    current.status !== next.status ||
    current.title !== next.title ||
    current.headBranch !== next.headBranch ||
    current.baseBranch !== next.baseBranch ||
    current.commentCount !== next.commentCount ||
    current.lastCommentAt !== next.lastCommentAt
  );
}

/**
 * Check if issue badge-relevant fields have changed (excluding lastCheckedAt).
 */
export function hasIssueBadgeFieldsChanged(
  current: IssueInfo | undefined,
  next: Omit<IssueInfo, "lastCheckedAt">,
): boolean {
  if (!current) return true;

  return (
    current.url !== next.url ||
    current.number !== next.number ||
    current.state !== next.state ||
    current.title !== next.title ||
    current.stateReason !== next.stateReason
  );
}

/**
 * GitHub App installation token response.
 */
interface InstallationTokenResponse {
  token: string;
  expires_at: string;
}

/**
 * Generate a JWT for GitHub App authentication.
 * The JWT is used to request an installation access token.
 */
async function generateAppJWT(appId: string, privateKey: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const expiration = now + 600; // 10 minutes (GitHub requires < 10 min)

  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: now - 60, // Issued 1 minute ago to account for clock skew
    exp: expiration,
    iss: appId,
  };

  const encodedHeader = Buffer.from(JSON.stringify(header))
    .toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload))
    .toString("base64url");
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const { createSign } = await import("node:crypto");
  const signature = createSign("RSA-SHA256")
    .update(signingInput)
    .sign(privateKey, "base64url");

  return `${signingInput}.${signature}`;
}

/**
 * Fetch an installation access token for a GitHub App.
 * This token is used to make API calls on behalf of the app installation.
 */
export async function fetchInstallationToken(
  installationId: number,
  appId: string,
  privateKey: string,
): Promise<string | null> {
  try {
    const jwt = await generateAppJWT(appId, privateKey);

    const response = await fetch(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          Authorization: `Bearer ${jwt}`,
          "User-Agent": "kb-dashboard/1.0",
        },
      },
    );

    if (!response.ok) {
      return null;
    }

    const data = await response.json() as InstallationTokenResponse;
    return data.token;
  } catch {
    return null;
  }
}

/**
 * Fetch canonical badge state for a PR using GitHub App installation token.
 * This uses the same normalization as the standard GitHubClient but with
 * App authentication instead of gh CLI or user token.
 */
export async function fetchCanonicalPrInfo(
  owner: string,
  repo: string,
  number: number,
  installationToken: string,
): Promise<Omit<PrInfo, "lastCheckedAt"> | null> {
  try {
    // Fetch PR data via REST API with installation token
    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          Authorization: `Bearer ${installationToken}`,
          "User-Agent": "kb-dashboard/1.0",
        },
      },
    );

    if (!response.ok) {
      return null;
    }

    const data = await response.json() as {
      number: number;
      html_url: string;
      title: string;
      state: string;
      merged: boolean;
      head: { ref: string };
      base: { ref: string };
      comments: number;
      updated_at: string;
    };

    // Fetch comment count separately if needed (REST API includes it)
    return {
      url: data.html_url,
      number: data.number,
      status: data.merged ? "merged" : data.state === "open" ? "open" : "closed",
      title: data.title,
      headBranch: data.head.ref,
      baseBranch: data.base.ref,
      commentCount: data.comments,
      lastCommentAt: data.updated_at,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch canonical badge state for an issue using GitHub App installation token.
 */
export async function fetchCanonicalIssueInfo(
  owner: string,
  repo: string,
  number: number,
  installationToken: string,
): Promise<Omit<IssueInfo, "lastCheckedAt"> | null> {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          Authorization: `Bearer ${installationToken}`,
          "User-Agent": "kb-dashboard/1.0",
        },
      },
    );

    if (!response.ok) {
      return null;
    }

    const data = await response.json() as {
      number: number;
      html_url: string;
      title: string;
      state: string;
      state_reason?: "completed" | "not_planned" | "reopened" | null;
      pull_request?: unknown;
    };

    // Skip PRs - they come through the issues endpoint too
    if (data.pull_request) {
      return null;
    }

    return {
      url: data.html_url,
      number: data.number,
      state: data.state === "open" ? "open" : "closed",
      title: data.title,
      stateReason: data.state_reason ?? undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Webhook handler result indicating what action was taken.
 */
export interface WebhookHandlerResult {
  /** Whether the webhook was accepted (signature valid) */
  accepted: boolean;
  /** HTTP status code to return */
  statusCode: number;
  /** Tasks that were updated (for logging/telemetry) */
  updatedTaskIds: string[];
  /** Whether any badge-relevant fields actually changed */
  badgeFieldsChanged: boolean;
  /** Error message if acceptance failed */
  error?: string;
}
