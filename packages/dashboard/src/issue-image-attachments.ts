import { runGhAsync, isGhAvailable, isGhAuthenticated, type TaskStore } from "@fusion/core";

/*
FNXC:IssueImportAttachments 2026-07-15-11:20:
An imported issue must carry its screenshots as real task attachments, not just as markdown image URLs inside the description.
Requirement: "ensure when importing github issues the agent will read any image attached to the issue", extended 2026-07-15-13:40 to issue COMMENTS and to GitLab.

Executors are told to read `.fusion/tasks/<id>/attachments/` (executor.ts `## Attachments` section) and triage inlines image attachments as base64 vision blocks, but nothing populated that directory for imported issues — so an issue whose entire bug report is a screenshot arrived at the agent as an unfetchable link.
Issue images live behind credentialed hosts (GitHub `user-attachments` assets redirect to a signed CDN URL; GitLab `/uploads/...` needs the instance token), so an agent with no token cannot resolve them. Import time is the only point where repo credentials are known to be present.

Provider differences are isolated in an ImageImportPolicy rather than a shared host list, because the two providers disagree on the two things that matter:
- GitHub images are ABSOLUTE URLs on a small fixed set of github.com hosts.
- GitLab images are usually RELATIVE (`/uploads/<sha>/img.png`, resolved against the PROJECT, not the instance root) and live on whatever host a self-managed instance uses.

Import must never fail because an image failed to download: the task (the operator's actual intent) matters more than its screenshots, so every download error is swallowed and reported as a count.
*/

/** Mirrors TaskStore.ALLOWED_MIME_TYPES image subset — addAttachment rejects anything else. */
export const ALLOWED_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Mirrors TaskStore.MAX_ATTACHMENT_SIZE (5MB). Checked before buffering so a huge asset can't balloon dashboard memory. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Bound per-issue work: a pathological issue (or a long comment thread) must not stall the import request. */
const MAX_IMAGES_PER_ISSUE = 10;

const DOWNLOAD_TIMEOUT_MS = 15_000;
const MAX_DOWNLOAD_REDIRECTS = 3;
const IMAGE_DOWNLOAD_CONCURRENCY = 3;

export const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/**
 * Provider-specific rules for turning an image reference in an issue body into something we may fetch.
 *
 * FNXC:IssueImportAttachments 2026-07-15-13:40:
 * `resolve` returning null is the SSRF guard: it is the single place that decides a URL is ours to fetch. Anything a policy does not recognise is skipped, so an attacker-supplied `![](http://169.254.169.254/...)` in an issue body is never requested.
 */
export interface ImageImportPolicy {
  /** Resolve a raw `src` from the body into an absolute https URL we may fetch, or null to skip it. */
  resolve(raw: string): string | null;
  /** Auth headers for the download request. */
  headers(): Promise<Record<string, string>>;
}

export interface IssueImageImportResult {
  attached: number;
  failed: number;
}

/** GitHub-hosted image hosts. Restricting the host set keeps import from fetching arbitrary attacker-supplied URLs out of an issue body (SSRF). */
const GITHUB_IMAGE_HOSTS = new Set([
  "github.com",
  "user-images.githubusercontent.com",
  "raw.githubusercontent.com",
  "private-user-images.githubusercontent.com",
  "objects.githubusercontent.com",
]);

/**
 * FNXC:IssueImportAttachments 2026-07-15-11:20:
 * Import runs in gh-cli mode by default, where GitHubClient holds no token — but `user-attachments` assets on a PRIVATE repo 404 without one. Borrow the gh CLI's own token so private-repo screenshots import as reliably as public ones. Public-repo assets download fine unauthenticated, so a missing token degrades rather than fails.
 */
async function resolveGithubToken(explicitToken?: string): Promise<string | undefined> {
  const direct = explicitToken?.trim() || process.env.GITHUB_TOKEN?.trim();
  if (direct) return direct;

  if (!isGhAvailable() || !isGhAuthenticated()) return undefined;
  try {
    const token = (await runGhAsync(["auth", "token"])).trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}

export function githubImagePolicy(options: { token?: string } = {}): ImageImportPolicy {
  let cachedToken: { value: string | undefined } | undefined;
  return {
    resolve(raw: string): string | null {
      let parsed: URL;
      try {
        parsed = new URL(raw);
      } catch {
        return null; // relative or malformed — GitHub bodies always carry absolute image URLs
      }
      if (parsed.protocol !== "https:") return null;
      if (!GITHUB_IMAGE_HOSTS.has(parsed.hostname)) return null;
      // github.com hosts every issue/PR/commit link too; only the attachment path is an image.
      if (parsed.hostname === "github.com" && !parsed.pathname.startsWith("/user-attachments/assets/")) {
        return null;
      }
      return parsed.toString();
    },
    async headers(): Promise<Record<string, string>> {
      cachedToken ??= { value: await resolveGithubToken(options.token) };
      return cachedToken.value ? { Authorization: `Bearer ${cachedToken.value}` } : {};
    },
  };
}

/**
 * FNXC:IssueImportAttachments 2026-07-15-13:40:
 * GitLab bodies reference uploads as `/uploads/<sha>/name.png`, which resolves against the PROJECT (`<instance>/<ns>/<project>/uploads/...`), not the instance root — so the project base is derived from the resource's own webUrl by cutting at GitLab's `/-/` route separator. Newer instances also emit `/-/project/<id>/uploads/...`, which IS instance-rooted; those are resolved against the origin.
 * Only the configured instance host is allowed: self-managed GitLab can be any hostname, so there is no fixed allowlist to hardcode — the trust boundary is "the instance this project is configured against".
 */
export function gitlabImagePolicy(options: { webBaseUrl: string; webUrl: string; token: string; headerName: string }): ImageImportPolicy {
  let origin: string;
  try {
    origin = new URL(options.webBaseUrl).origin;
  } catch {
    origin = "";
  }
  // "https://gitlab.com/ns/proj/-/issues/12" -> "https://gitlab.com/ns/proj"
  const projectBase = options.webUrl.split("/-/")[0]!.replace(/\/+$/u, "");
  let projectOriginPath = "";
  try {
    projectOriginPath = new URL(projectBase).pathname.replace(/\/+$/u, "");
  } catch {
    projectOriginPath = "";
  }

  return {
    resolve(raw: string): string | null {
      if (!origin) return null;
      let resolved: URL;
      try {
        if (raw.startsWith("/uploads/")) {
          resolved = new URL(`${projectBase}${raw}`);
        } else if (raw.startsWith("/")) {
          resolved = new URL(`${origin}${raw}`);
        } else {
          resolved = new URL(raw);
        }
      } catch {
        return null;
      }
      if (resolved.protocol !== "https:" || resolved.origin !== origin) return null;
      // FNXC:IssueImportAttachments 2026-07-15-14:10: A project-relative
      // upload must remain beneath the originating project after URL normalization.
      const projectUpload = `${projectOriginPath}/uploads/`;
      const instanceUpload = /^\/-\/project\/[^/]+\/uploads\//u;
      if (!resolved.pathname.startsWith(projectUpload) && !instanceUpload.test(resolved.pathname)) return null;
      return resolved.toString();
    },
    async headers() {
      return { [options.headerName]: options.token };
    },
  };
}

/**
 * Extract image references from issue/comment bodies and resolve them through a provider policy.
 *
 * FNXC:IssueImportAttachments 2026-07-15-11:20:
 * Bodies embed images two ways and both must be covered: markdown `![alt](url)` (the upload default) and raw `<img src="...">` (common when authors resize a screenshot).
 */
export function extractIssueImageUrls(
  bodies: string | null | undefined | Array<string | null | undefined>,
  policy: ImageImportPolicy,
): string[] {
  const list = Array.isArray(bodies) ? bodies : [bodies];
  const found: string[] = [];
  const seen = new Set<string>();

  const push = (raw: string) => {
    const trimmed = raw.trim().replace(/^<|>$/g, "");
    if (!trimmed) return;
    const resolved = policy.resolve(trimmed);
    if (!resolved || seen.has(resolved)) return;
    seen.add(resolved);
    found.push(resolved);
  };

  for (const body of list) {
    if (!body) continue;
    const markdownImage = /!\[[^\]]*\]\(\s*([^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
    for (const match of body.matchAll(markdownImage)) push(match[1]!);

    const htmlImage = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;
    for (const match of body.matchAll(htmlImage)) push(match[1]!);
  }

  return found.slice(0, MAX_IMAGES_PER_ISSUE);
}

function filenameFor(url: string, mimeType: string, index: number): string {
  const ext = EXT_BY_MIME[mimeType] ?? "png";
  let base = "";
  try {
    base = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
  } catch {
    base = "";
  }
  // user-attachments assets are bare UUIDs with no extension; give the agent a name that reads as an image.
  if (base && /\.(png|jpe?g|gif|webp)$/i.test(base)) return base;
  return `issue-image-${index + 1}.${ext}`;
}

async function downloadImage(
  url: string,
  authHeaders: Record<string, string>,
  policy: ImageImportPolicy,
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  let currentUrl = url;
  let response: Response | undefined;
  for (let redirects = 0; redirects <= MAX_DOWNLOAD_REDIRECTS; redirects++) {
    response = await fetch(currentUrl, {
      headers: { "User-Agent": "fn/1.0", ...authHeaders },
      redirect: "manual",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!(response.status >= 300 && response.status < 400)) break;
    const location = response.headers.get("location");
    if (!location) throw new Error(`redirect ${response.status} without location`);
    const approved = policy.resolve(new URL(location, currentUrl).toString());
    // FNXC:IssueImportAttachments 2026-07-15-14:10: Every redirect is a new
    // token-bearing request, so it must satisfy the forge policy before follow-up.
    if (!approved) throw new Error("redirect target is outside the image policy");
    currentUrl = approved;
  }
  if (!response || (response.status >= 300 && response.status < 400)) throw new Error("too many image redirects");
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const mimeType = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!ALLOWED_IMAGE_MIMES.has(mimeType)) {
    // Not an image (e.g. a login redirect landing on HTML) — skip rather than attach garbage.
    return null;
  }

  const declaredLength = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) {
    throw new Error(`image too large (${declaredLength} bytes)`);
  }

  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_IMAGE_BYTES) {
        await reader.cancel();
        throw new Error(`image too large (${bytes} bytes)`);
      }
      chunks.push(value);
    }
  } else {
    const fallback = Buffer.from(await response.arrayBuffer());
    bytes = fallback.length;
    if (bytes > MAX_IMAGE_BYTES) throw new Error(`image too large (${bytes} bytes)`);
    chunks.push(fallback);
  }
  const buffer = Buffer.concat(chunks);
  return { buffer, mimeType };
}

/**
 * Download every policy-allowed image embedded in an imported issue's body and comments, and attach them to the task.
 *
 * FNXC:IssueImportAttachments 2026-07-15-11:20:
 * Best-effort by contract — the caller has already created the task, so a throw here would fail an import that actually succeeded. Returns counts so the caller can log what landed.
 */
export async function importIssueImageAttachments(
  store: Pick<TaskStore, "addAttachment">,
  taskId: string,
  bodies: string | null | undefined | Array<string | null | undefined>,
  policy: ImageImportPolicy,
): Promise<IssueImageImportResult> {
  const urls = extractIssueImageUrls(bodies, policy);
  if (urls.length === 0) return { attached: 0, failed: 0 };

  const authHeaders = await policy.headers();
  let attached = 0;
  let failed = 0;

  const importOne = async (index: number, url: string) => {
    try {
      const image = await downloadImage(url, authHeaders, policy);
      if (!image) {
        failed++;
        return;
      }
      await store.addAttachment(taskId, filenameFor(url, image.mimeType, index), image.buffer, image.mimeType);
      attached++;
    } catch (err) {
      failed++;
      console.warn(
        `[fusion:issue-import] Skipping image ${url} for task ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  // FNXC:IssueImportAttachments 2026-07-15-14:10: Bound simultaneous remote
  // work so ten slow screenshots cannot serialize an issue import for minutes.
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(IMAGE_DOWNLOAD_CONCURRENCY, urls.length) }, async () => {
    while (nextIndex < urls.length) {
      const index = nextIndex++;
      await importOne(index, urls[index]!);
    }
  }));

  return { attached, failed };
}
