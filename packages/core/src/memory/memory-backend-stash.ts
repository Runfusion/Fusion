/**
 * Stash Agent Memory backend for Fusion.
 *
 * Exposes the operator's Stash knowledge-base (~/git/stash) as an optional LCM
 * memory backend. Stash is a self-hosted personal memory/knowledge server that
 * stores timestamped events (conversation turns, tool calls, notes) and exposes
 * full-text search over them.
 *
 * Transport: REST (pi-plugin-rewrite), NOT MCP.
 *   - SEARCH (read):  GET  /api/v1/me/sessions/events/search?q=<query>&limit=<n>
 *   - CAPTURE (write): POST /api/v1/me/sessions/events/batch
 * Auth: `Authorization: Bearer <stash API key>`.
 *
 * FNXC:StashBackend 2026-08-05-16:06:
 * The original RUFU-026 brief referenced an MCP server at /api/v1/mcp with
 * stash_session_search / stash_session_upload / stash_memory_append tools.
 * That was VERIFIED WRONG against the current stash checkout
 * (pi-plugin-rewrite): there is no /api/v1/mcp, no mcp_service.py, no such
 * MCP tools. The current stash exposes search + capture via REST only. This
 * backend is a minimal fetch-based REST client over the two endpoints and does
 * NOT use @modelcontextprotocol/sdk.
 *
 * Callers choosing the stash backend must supply auth + isolation via the
 * MemoryBackend constructor options:
 *   - apiKey: the stash API key (read from secrets store, NEVER hardcoded).
 *   - baseUrl: the stash server URL (defaults to http://127.0.0.1:3457).
 *
 * Source of truth: `stashUrl`/`stashApiKey` come from project settings +
 * the global secrets store. Project value wins over global; unset falls back
 * to the default base URL.
 */

import http from "node:http";
import https from "node:https";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import type {
  MemoryBackend,
  MemoryBackendCapabilities,
  MemoryReadResult,
  MemoryWriteResult,
  MemoryGetOptions,
  MemoryGetResult,
  MemorySearchOptions,
  MemorySearchResult,
  MemoryCaptureEvent,
  MemoryCaptureResult,
  MemoryWriteIdentity,
} from "./memory-backend.js";
import {
  resolveStashMemorySettings,
  type MemoryBackendSettings,
  type StashSecretsReader,
} from "./stash-settings.js";

// ── Types ────────────────────────────────────────────────────────────

/** One captured event stored in stash. */
export interface StashEvent extends MemoryCaptureEvent {
  /** top-level stash-required session id (MemoryCaptureEvent has no such field). */
  session_id?: string;
  /**
   * FNXC:RUFU121FolderAssignment 2026-08-18-19:53:
   * RUFU-121: top-level per-project session-folder id (Stash
   * HistoryEventCreateRequest.session_folder_id, UUID | null). Stamped by
   * capture()/write() when a project identity resolves.
   */
  session_folder_id?: string;
}

interface StashSearchResultItem {
  id?: string | number;
  content?: string;
  event_type?: string;
  agent_name?: string;
  session_id?: string;
  created_at?: string;
  snippet?: string;
  [key: string]: unknown;
}

interface StashSearchResponse {
  results?: StashSearchResultItem[];
  events?: StashSearchResultItem[];
  count?: number;
  [key: string]: unknown;
}

interface StashBatchResponse {
  inserted?: number;
  deduped?: number;
  count?: number;
  [key: string]: unknown;
}

// ── HTTP transport seam (RUFU-121) ────────────────────────────────────

/**
 * FNXC:RUFU121TransportSeam 2026-08-18-19:53:
 * RUFU-121: injectable HTTP transport seam for the Stash backend and the
 * standalone Stash helpers (queryStashEvents/deleteStashChatSession). Tests
 * inject a recorder fake — no real network in unit tests.
 */
export type StashHttpMethod = "GET" | "POST" | "PATCH" | "DELETE";
export type StashHttpClient = (
  path: string,
  method: StashHttpMethod,
  payload?: unknown,
) => Promise<unknown>;

/**
 * FNXC:RUFU121TransportSeam 2026-08-18-19:53:
 * RUFU-121: the real node:http JSON transport (moved out of
 * StashMemoryBackend.httpRequest so standalone helpers share it without a
 * backend instance). Same wire behavior as before: 10s timeout, Bearer auth,
 * JSON body, 2xx → parsed body (or null), otherwise reject.
 *
 * FNXC:StashTransportScheme 2026-08-21-13:35:
 * RUFU-146 review (PRRT_kwDOSA-8Y86a7RZf): the transport must follow the
 * baseUrl scheme. Self-hosted Stash deployments sit behind TLS reverse
 * proxies, and the default operator setup is a non-loopback https URL — the
 * previous unconditional node:http.request made every such deployment fail
 * with an http/https protocol mismatch. Select node:https for `https:`
 * bases, node:http otherwise, and preserve any base-URL path prefix (e.g.
 * http://host/stash) so proxied deployments keep their /stash routing.
 */
export function stashHttpJsonRequest<T>(
  baseUrl: string,
  apiKey: string,
  path: string,
  method: StashHttpMethod,
  payload?: unknown,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // Resolve `path` against the full base URL INCLUDING its path prefix:
    // `new URL("/api/v1/…", "http://host/stash")` drops the /stash segment,
    // so strip the leading slash and let URL resolution re-append it.
    const url = new URL(path.startsWith("/") ? path.slice(1) : path, baseUrl.replace(/\/+$/, "") + "/");
    const body = payload !== undefined ? JSON.stringify(payload) : undefined;
    const headers: http.OutgoingHttpHeaders = { Accept: "application/json" };
    if (body) headers["Content-Type"] = "application/json";
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers,
      timeout: 10_000,
    };

    // FNXC:StashTransportScheme 2026-08-21-13:35: transport follows the scheme.
    const req = (url.protocol === "https:" ? https : http).request(options, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve((data ? JSON.parse(data) : null) as T);
          } catch {
            reject(new Error(`Invalid JSON response (${res.statusCode}): ${data.substring(0, 200)}`));
          }
        } else {
          reject(new Error(`Stash returned ${res.statusCode}: ${data.substring(0, 200)}`));
        }
      });
    });

    req.on("error", (err) => reject(err));
    req.on("timeout", () => { req.destroy(); reject(new Error("Stash request timed out")); });

    if (body) req.write(body);
    req.end();
  });
}

// ── Defaults ─────────────────────────────────────────────────────────

export const DEFAULT_STASH_URL = "http://127.0.0.1:3457";

/*
FNXC:RUFU122ChunkedUpload 2026-08-19-04:30:
RUFU-122: Stash's /events/batch endpoint rejects a POST carrying more than 100
events (verified against the live instance in preflight — the 200 cap from the
earlier RUFU-068 spec was wrong). capture() therefore uploads transcripts in
sequential chunks of this size; any single capture exceeding it (the task
terminal transcript, up to 20000 events) is split, never silently truncated.
*/
export const STASH_EVENT_BATCH_CHUNK_SIZE = 100;

/**
 * FNXC:RUFU121FolderCache 2026-08-18-19:53:
 * RUFU-121 per-process session-folder cache. Key `${baseUrl}::${projectId}`
 * — the baseUrl segment guarantees different Stash instances (or test fakes)
 * never share a folder id. Successes only, TTL 1h; failures are never cached
 * (fail-open, retried on the next capture). __resetStashFolderCacheForTests()
 * clears it for test isolation.
 */
const STASH_FOLDER_CACHE_TTL_MS = 3_600_000;
const stashFolderCache = new Map<string, { folderId: string; expiresAt: number }>();

/** RUFU-121 test seam: clear the per-process session-folder cache. */
export function __resetStashFolderCacheForTests(): void {
  stashFolderCache.clear();
}

/*
FNXC:Rufu126VectorSearch 2026-08-19-10:50:
RUFU-126 (D3): per-process NEGATIVE vector-capability cache. Keyed by baseUrl
only (vector capability is a property of the Stash instance, not the project).
Records ONLY definitive "this server cannot do vector search" responses —
404 (unpatched server, no /events/semantic-search route), 405, 501, and 503
(embedder unconfigured) — parsed from the transport's `Stash returned <code>:`
rejection prefix. 422/500 and network errors are NEVER cached (transient or
malformed — retry on the next call). TTL 1h, mirroring the session-folder
cache; __resetVectorCapabilityCacheForTests() clears it for test isolation.
*/
const STASH_VECTOR_NEGATIVE_CACHE_TTL_MS = 3_600_000;
const stashVectorNegativeCache = new Map<string, { expiresAt: number }>();

/** RUFU-126 test seam: clear the per-process negative vector-capability cache. */
export function __resetVectorCapabilityCacheForTests(): void {
  stashVectorNegativeCache.clear();
}

/**
 * Derive a stable, per-project stash session namespace discriminator prefix.
 *
 * FNXC:StashIsolation 2026-08-05-16:06:
 * All events uploaded by Fusion are tagged with a per-project discriminator so
 * search can be scoped to the current project. STASH ITSELF enforces
 * cross-project isolation at the SQL level (memory_service.search_scope_events:
 * `owner_user_id IN accessible_scope_ids_sql(1)`), so the discriminator tag is
 * NOT the isolation mechanism — it is only a provenance/grrapability tag. We
 * NEVER rely on an in-memory filter as the isolation mechanism.
 */
function projectDiscriminatorFor(rootDir: string | undefined): string {
  if (!rootDir) return "fusion-default";
  const projectName = basename(rootDir) || "project";
  const slug = createHash("sha1").update(rootDir).digest("hex").slice(0, 10);
  return `${projectName}-${slug}`;
}

/**
 * FNXC:RUFU121QueryNormalization 2026-08-18-19:53:
 * RUFU-121: normalize a raw recall query to a
 * Postgres `websearch_to_tsquery('english')`-safe form. Stash's search
 * pipeline runs the tsquery over the full event text; un-normalized input
 * risks parser errors (unbalanced quotes, exotic characters) or silently
 * wrong tokenization.
 *
 * Algorithm (deterministic, pure):
 * 1. Strip non-ASCII (keep \x20–\x7E only), collapse whitespace runs to one
 *    space, trim.
 * 2. If ANY token is exactly `OR` (case-sensitive): keep ALL word tokens
 *    plus the `OR` tokens in order (pure-punctuation tokens dropped).
 *    Otherwise keep ONLY the first word token (websearch's implicit AND
 *    would over-narrow multi-token user queries).
 * 3. Strip all non-`[A-Za-z0-9]` from each kept token; drop tokens that
 *    become empty.
 * 4. Join with single spaces.
 * 5. Cap at 100 characters on a token boundary (drop trailing tokens;
 *    never truncate mid-token).
 *
 * null/undefined/empty/whitespace-only → "" (caller decides the
 * fail-closed behavior).
 */
export function normalizeStashSearchQuery(raw: string | null | undefined): string {
  if (raw == null) return "";
  const ascii = raw.replace(/[^\x20-\x7E]/g, "");
  const collapsed = ascii.replace(/ +/g, " ").trim();
  if (collapsed === "") return "";
  const tokens = collapsed.split(" ");
  // Step 2: OR-preserving mode keeps word tokens ("OR" is itself a word
  // token); default mode keeps only the first word token.
  const kept = tokens.includes("OR")
    ? tokens.filter((t) => /[A-Za-z0-9]/.test(t))
    : tokens.filter((t) => /[A-Za-z0-9]/.test(t)).slice(0, 1);
  const cleaned = kept.map((t) => t.replace(/[^A-Za-z0-9]/g, "")).filter((t) => t.length > 0);
  // Step 5: 100-char cap on a token boundary — never mid-token.
  let joined = "";
  for (const t of cleaned) {
    const candidate = joined === "" ? t : `${joined} ${t}`;
    if (candidate.length > 100) break;
    joined = candidate;
  }
  return joined;
}

// ── Stash Memory Backend ─────────────────────────────────────────────

/**
 * Memory backend that delegates read/search/write to the Stash REST API.
 *
 * Capabilities:
 * - `read()`: Searches stash for the current project's most relevant memories
 *   (broad empty query) and returns them as markdown. Fails CLOSED to
 *   {content:"", exists:false}.
 * - `search()`: GET /api/v1/me/sessions/events/search → MemorySearchResult[].
 * - `write()`: POST /api/v1/me/sessions/events/batch (best-effort; never throws).
 * - `read()/get()/exists()`: fail closed on any error (stash down, auth
 *   failure, parse error) — NEVER blocks a run.
 * - `capture()/endSession()`: same write path, best-effort and non-blocking.
 */
export class StashMemoryBackend implements MemoryBackend {
  readonly type = "stash";
  readonly name = "Stash (personal knowledge-base)";
  readonly capabilities: MemoryBackendCapabilities = {
    readable: true,
    writable: true,
    supportsAtomicWrite: false,
    hasConflictResolution: true,
    persistent: true,
  };

  private readonly baseUrl: string;
  private readonly apiKey: string;

  /*
  FNXC:Rufu126VectorSearch 2026-08-19-10:50:
  RUFU-126 (D3): opt-in vector (semantic) search, default OFF. Enabled by the
  per-project `stashVectorSearch` setting (settings-schema.ts) threaded through
  resolveMemoryBackend. Default-off = zero behavior change until the operator
  enables it (this is a prototype); rejected alternative was automatic
  capability detection (changes default behavior + per-process 404 round-trip
  cost against unpatched servers).
  */
  private readonly vectorSearch: boolean;

  /**
   * FNXC:RUFU121TransportSeam 2026-08-18-19:53:
   * RUFU-121: injectable clock (default Date.now) for the session-folder
   * cache TTL and injectable HTTP transport seam (default: real node:http
   * JSON transport). Tests inject a fake clock + recorder http — no network.
   */
  private readonly now: () => number;
  private readonly client: StashHttpClient;

  constructor(options?: {
    baseUrl?: string;
    apiKey?: string;
    /** RUFU-121: injectable clock for the session-folder cache TTL. */
    now?: () => number;
    /** RUFU-121: injectable HTTP transport seam (recorder fake in tests). */
    httpClient?: StashHttpClient;
    /** RUFU-126: opt-in vector (semantic) search path (default false). */
    vectorSearch?: boolean;
  }) {
    this.baseUrl = (options?.baseUrl ?? DEFAULT_STASH_URL).replace(/\/+$/, "");
    this.apiKey = options?.apiKey ?? "";
    this.vectorSearch = options?.vectorSearch === true;
    this.now = options?.now ?? (() => Date.now());
    this.client =
      options?.httpClient ??
      ((path, method, payload) => stashHttpJsonRequest(this.baseUrl, this.apiKey, path, method, payload));
  }

  /** Per-project provenance discriminator (not the isolation mechanism). */
  private discriminatorFor(rootDir: string): string {
    return projectDiscriminatorFor(rootDir);
  }

  /**
   * Stable per-project session id for free-text `write()` captures (which have
   * no caller-supplied session id). Stash requires a non-empty top-level
   * session_id; deriving one from the project discriminator keeps write()
   * idempotent per project without colliding across projects.
   */
  private sessionIdFor(rootDir: string): string {
    const d = this.discriminatorFor(rootDir) || "fusion";
    return `fusion-${d}`.slice(0, 64);
  }

  /**
   * FNXC:RUFU121FolderNaming 2026-08-18-19:53:
   * RUFU-121: resolve (get-or-create) the per-project Stash session folder.
   * Display name `Fusion — <project>` (U+2014 em dash; `Fusion` alone when
   * the name is unavailable); stable machine identity `external_key`
   * `fusion-<projectId>` so project renames never break resolution.
   * Best-effort: any failure or absent id → undefined (capture proceeds
   * folder-less); failures are never cached.
   */
  private async resolveProjectFolderId(projectId: string, projectName?: string): Promise<string | undefined> {
    const cacheKey = `${this.baseUrl}::${projectId}`;
    const now = this.now();
    const cached = stashFolderCache.get(cacheKey);
    if (cached && cached.expiresAt > now) return cached.folderId;
    // FNXC:RUFU121FolderNaming 2026-08-18-19:53: U+2014 em dash between "Fusion" and the project name.
    const trimmedName = projectName?.trim();
    const name = trimmedName ? `Fusion \u2014 ${trimmedName}` : "Fusion";
    try {
      const resp = await this.client("/api/v1/me/session-folders/get-or-create", "POST", {
        name,
        external_key: `fusion-${projectId}`,
      });
      const rawId = (resp as { id?: unknown } | null)?.id;
      const folderId = typeof rawId === "string" ? rawId : typeof rawId === "number" ? String(rawId) : undefined;
      if (!folderId) return undefined;
      // FNXC:RUFU121FolderCache 2026-08-18-19:53: successes only — never cache failures.
      stashFolderCache.set(cacheKey, { folderId, expiresAt: now + STASH_FOLDER_CACHE_TTL_MS });
      return folderId;
    } catch {
      return undefined;
    }
  }

  // ── read ───────────────────────────────────────────────────────────

  /**
   * Read the most relevant stash memories for a project as markdown.
   * Sends a broad empty query. Fails CLOSED: any error -> {content:"",exists:false}.
   */
  async read(rootDir: string): Promise<MemoryReadResult> {
    try {
      const results = await this.search(rootDir, { query: "", limit: 10 });
      if (results.length === 0) {
        return { content: "", exists: false, backend: this.type };
      }
      const header = `\`\`\`\n[Stash Memory] ${results.length} memories recalled\n\`\`\`\n\n`;
      const body = results
        .map((r) => `### ${r.path}\n${r.snippet}`)
        .join("\n\n---\n\n");
      return { content: header + body, exists: true, backend: this.type };
    } catch {
      // FNXC:StashFailClosed 2026-08-05-16:06:
      // Stash down / auth / parse failure must never throw out of read() — the
      // seam-level getProjectMemory wrapper and buildProactiveMemoryCueBlock
      // depend on empty reads meaning "no memory available", not "backend error".
      return { content: "", exists: false, backend: this.type };
    }
  }

  // ── write ──────────────────────────────────────────────────────────

  /**
   * Capture a memory event via POST /api/v1/me/sessions/events/batch.
   * Best-effort: never throws. On any failure returns {success:false}.
   *
   * FNXC:RUFU121WriteIdentity 2026-08-18-19:53:
   * RUFU-121: optional trailing identity meta. When it carries a projectId,
   * the event is classified into the per-project session folder
   * (session_folder_id) and metadata gains project/project_name keys — same
   * fail-open contract as capture().
   */
  async write(rootDir: string, content: string, meta?: MemoryWriteIdentity): Promise<MemoryWriteResult> {
    const projectId = meta?.projectId ?? null;
    const projectName = meta?.projectName ?? null;
    // FNXC:RUFU121FolderAssignment 2026-08-18-19:53: best-effort folder
    // resolution — failure/absence proceeds folder-less (backward compat).
    const sessionFolderId = projectId ? await this.resolveProjectFolderId(projectId, projectName ?? undefined) : undefined;
    try {
      await this.batchUpload(this.discriminatorFor(rootDir), [
        {
          event_type: "memory",
          content: content.substring(0, 4000),
          // FNXC:StashEventShape 2026-08-07-10:39: mirror the capture() fix —
          // stash requires top-level agent_name + session_id, so write() must
          // supply stable defaults rather than letting batchUpload fall back.
          agent_name: "fusion",
          session_id: this.sessionIdFor(rootDir),
          ...(sessionFolderId ? { session_folder_id: sessionFolderId } : {}),
          // FNXC:RUFU121MetadataEnrichment 2026-08-18-19:53:
          // RUFU-121 identity enrichment — keys appear only when the value is
          // present (never `undefined` spam).
          metadata: {
            discriminator: this.discriminatorFor(rootDir),
            ...(projectId ? { project: projectId } : {}),
            ...(projectName ? { project_name: projectName } : {}),
          },
        },
      ]);
      return { success: true, backend: this.type };
    } catch {
      return { success: false, backend: this.type };
    }
  }

  // ── get ────────────────────────────────────────────────────────────

  /**
   * Not file-path oriented — fails closed to an empty result without throwing.
   */
  async get(_rootDir: string, options: MemoryGetOptions): Promise<MemoryGetResult> {
    return {
      path: options.path,
      content: "",
      startLine: 1,
      endLine: 1,
      totalLines: 0,
      backend: this.type,
    };
  }

  // ── search ─────────────────────────────────────────────────────────

  /**
   * Search stash events via GET /api/v1/me/sessions/events/search.
   * Maps each result to a MemorySearchResult. Fails CLOSED to [] on any error.
   *
   * FNXC:Rufu126VectorSearch 2026-08-19-10:50:
   * RUFU-126: vector-first / fallback invariant (decisions D1–D5, see
   * docs/research/stash-vector-search-evaluation.md):
   * - D1: the vector path is a SEPARATE endpoint (GET
   *   /api/v1/me/sessions/events/semantic-search), not a mode=vector param —
   *   FastAPI silently ignores undeclared params, so an unpatched server
   *   would return keyword results mislabeled as vector; a new path 404s
   *   cleanly and matches Stash's /me/pages/semantic-search precedent.
   * - D2: applies only to MULTI-word queries (≥2 whitespace-separated tokens
   *   in the trimmed raw query); single-word queries stay keyword-only
   *   (exact-token FTS is the best single-token baseline).
   * - Fallback (load-bearing): on ANY vector failure — network error/timeout,
   *   non-2xx, malformed body, or an EMPTY vector result list — control falls
   *   through to the RUFU-121 keyword path BYTE-IDENTICAL below (normalized
   *   q, legacy empty-query URL, limit cap, fail-closed []). The vector path
   *   can therefore never make recall worse than the keyword baseline.
   * - D3: negative-capability cache (per-process, baseUrl-keyed, TTL 1h)
   *   suppresses the vector attempt after definitive 404/405/501/503 —
   *   never after 422/500 or network errors.
   * - D5: vector score = response `rank` (= cosine similarity, 0..1); the
   *   keyword path keeps positional scores (2/1). The scales differ —
   *   consumers with client-side min-score filters must treat score scales
   *   per-backend. Missing/non-finite rank → 1.0.
   */
  async search(rootDir: string, options: MemorySearchOptions): Promise<MemorySearchResult[]> {
    const req = options.query || "";
    const limit = Math.max(1, Math.min(options.limit ?? 5, 20));
    // ── RUFU-126 vector-first branch (D1/D2/D3) ──
    // Multi-word raw queries only; suppressed while a definitive
    // no-vector response is cached for this baseUrl. null → fall through;
    // the keyword path below is byte-identical (RUFU-121).
    const rawTrimmed = req.trim();
    if (
      this.vectorSearch &&
      rawTrimmed.length > 0 &&
      rawTrimmed.split(/\s+/).length >= 2 &&
      this.vectorSearchAvailable()
    ) {
      const vectorHits = await this.vectorSearchHits(rawTrimmed, limit);
      if (vectorHits) return vectorHits;
    }
    /*
    FNXC:RUFU121TopicRemoval 2026-08-18-19:53:
    RUFU-121: removes the inert `&topic=` query param. Stash's search_events
    route (backend/routers/memory.py) accepts only q+limit and has no topic
    filter (verified 2026-08-18 against /home/schindler/git/stash); the param
    was always dropped server-side. MemorySearchOptions.topic stays for the
    other backends. Stash topic-like recall scoping uses the structured
    queryStashEvents() filters.

    URL contract (load-bearing):
    - empty/whitespace raw query → LEGACY URL preserved BYTE-IDENTICAL
      (raw, as encoded today); read()/exists() broad recall relies on the
      current fail-closed path for this shape.
    - non-empty raw query → `q=` + normalizeStashSearchQuery(raw) (Postgres
      websearch_to_tsquery('english')-safe); a query that normalizes to ""
      returns [] with NO HTTP call (Stash 422s empty q).
    */
    let q = req;
    if (req.trim().length > 0) {
      const normalized = normalizeStashSearchQuery(req);
      if (normalized === "") return [];
      q = normalized;
    }
    try {
      const resp = await this.httpRequest<StashSearchResponse>(
        `/api/v1/me/sessions/events/search?q=${encodeURIComponent(q)}&limit=${limit}`,
        "GET",
      );
      const items = resp.results ?? resp.events ?? [];
      return items
        .filter((it) => it && typeof it === "object")
        .map((it, idx) => ({
          path: it.session_id ? `stash://session/${it.session_id}` : `stash://event/${it.id ?? idx}`,
          lineStart: 1,
          lineEnd: 1,
          snippet: (it.snippet ?? it.content ?? "").substring(0, 500),
          score: 2 - Math.min(idx, 1), // ordered descending relevance
          backend: this.type,
        }));
    } catch {
      // FNXC:StashFailClosed 2026-08-05-16:06:
      // stash down -> [] -> LCM cue "" -> run proceeds. Never throws.
      return [];
    }
  }

  /**
   * RUFU-126 (D3): false while a definitive no-vector response (404/405/501/
   * 503) is cached for this baseUrl and its TTL has not expired.
   */
  private vectorSearchAvailable(): boolean {
    const entry = stashVectorNegativeCache.get(this.baseUrl);
    return !entry || entry.expiresAt <= this.now();
  }

  /*
  FNXC:Rufu126VectorSearch 2026-08-19-10:50:
  RUFU-126 (D1): one semantic-search attempt. Returns mapped hits on 2xx with
  a non-empty results array; null on ANY other outcome (network error/timeout,
  non-2xx, malformed body, empty list) so the caller falls through to the
  keyword path. Definitive no-vector statuses {404, 405, 501, 503} are
  negatively cached per baseUrl (TTL 1h); 422/500 and network errors are never
  cached (transient/malformed — retry next call). The raw trimmed query is sent
  UN-normalized (the embedder tokenizes on its own), capped at 200 chars.
  */
  private async vectorSearchHits(rawQuery: string, limit: number): Promise<MemorySearchResult[] | null> {
    const q = rawQuery.slice(0, 200);
    try {
      const resp = await this.httpRequest<StashSearchResponse>(
        `/api/v1/me/sessions/events/semantic-search?q=${encodeURIComponent(q)}&limit=${limit}`,
        "GET",
      );
      const items = resp?.results ?? resp?.events;
      if (!Array.isArray(items) || items.length === 0) return null; // empty list → keyword fallback
      const hits = items
        .filter((it): it is StashSearchResultItem => Boolean(it) && typeof it === "object")
        .map((it, idx) => {
          // D5: vector rank = similarity (0..1); missing/null/non-finite → 1.0.
          const rawRank = it.rank;
          const rank =
            typeof rawRank === "number"
              ? rawRank
              : typeof rawRank === "string" && rawRank.trim() !== ""
                ? Number(rawRank)
                : NaN;
          return {
            path: it.session_id ? `stash://session/${it.session_id}` : `stash://event/${it.id ?? idx}`,
            lineStart: 1,
            lineEnd: 1,
            snippet: (it.content ?? it.snippet ?? "").substring(0, 500),
            score: Number.isFinite(rank) ? rank : 1.0,
            backend: this.type,
          } as MemorySearchResult;
        });
      return hits.length > 0 ? hits : null;
    } catch (err) {
      const status = this.stashErrorStatus(err);
      if (status !== null && (status === 404 || status === 405 || status === 501 || status === 503)) {
        stashVectorNegativeCache.set(this.baseUrl, {
          expiresAt: this.now() + STASH_VECTOR_NEGATIVE_CACHE_TTL_MS,
        });
      }
      return null;
    }
  }

  /**
   * RUFU-126: parse the `Stash returned <code>: ...` status out of the
   * transport seam's rejection message; null for any other error shape.
   */
  private stashErrorStatus(err: unknown): number | null {
    if (typeof err !== "object" || err === null) return null;
    const msg = (err as { message?: unknown }).message;
    if (typeof msg !== "string") return null;
    const m = /^Stash returned (\d{3}):/.exec(msg);
    return m ? Number(m[1]) : null;
  }

  // ── exists ─────────────────────────────────────────────────────────

  /**
   * Probe stash reachability. Never throws — returns false on any error
   * (stash down means "no memory here", consistent with fail-closed).
   */
  async exists(_rootDir: string): Promise<boolean> {
    try {
      const resp = await this.httpRequest<StashSearchResponse>(
        "/api/v1/me/sessions/events/search?q=&limit=1",
        "GET",
      );
      return resp !== null && resp !== undefined;
    } catch {
      return false;
    }
  }

  // ── Capture seam (WRITE side) ──────────────────────────────────────

  /**
   * Capture a session chunk as events. Modeled on the optional capture seam.
   * Deterministic, non-LLM, best-effort: never throws, never blocks a run.
   *
   * FNXC:StashCaptureIdempotency 2026-08-05-16:06:
   * push_events_batch is idempotent via tuple upsert (replace=false semantics),
   * so re-capturing the same (session, content) tuple is a no-op. A session_id
   * namespace `fusion-<taskId>-<sessionHash>` never collides with the stash
   * pi-plugin's `sess_*` session ids.
   */
  /**
   * Capture memory events via POST /api/v1/me/sessions/events/batch.
   * Best-effort: never throws. On any failure returns {ok:false}.
   *
   * FNXC:StashEventShape 2026-08-07-10:39:
   * Stash's HistoryEventCreateRequest requires top-level `agent_name` (1-64)
   * and `session_id` (1-64) on every event — they are NOT optional metadata.
   * Sending them only inside `metadata` makes the server return 422 and the
   * capture silently drop (ok:false). We therefore always surface both at the
   * top level: agent_name defaults to "fusion" for this backend, and
   * session_id is the capture session id. Verified live against stash: a
   * batch missing these fields returns 422 "Field required"; the same events
   * with them inserted return 201.
   */
  async capture(
    sessionId: string,
    events: MemoryCaptureEvent[],
    metadata?: {
      taskId?: string;
      projectRoot?: string;
      topic?: string;
      /** FNXC:RUFU121CaptureIdentity 2026-08-18-19:53: RUFU-121 identity (see MemoryBackend.capture). */
      projectId?: string;
      projectName?: string;
      chatTitle?: string;
    },
  ): Promise<MemoryCaptureResult> {
    const rootDir = metadata?.projectRoot;
    const taskId = metadata?.taskId;
    const topic = metadata?.topic;
    // FNXC:RUFU121CaptureIdentity 2026-08-18-19:53: RUFU-121 optional identity.
    const projectId = metadata?.projectId;
    const projectName = metadata?.projectName;
    const chatTitle = metadata?.chatTitle;
    const discriminator = projectDiscriminatorFor(rootDir);
    /*
    FNXC:RUFU121FolderAssignment 2026-08-18-19:53:
    RUFU-121: every batch event is classified into the per-project Stash
    session folder when a project identity is available; an absent projectId
    keeps today's folder-less capture (backward compat).
    */
    const sessionFolderId = projectId ? await this.resolveProjectFolderId(projectId, projectName) : undefined;
    const tagged = events.map((e) => ({
      ...e,
      // Surface the stash-required top-level identifiers — metadata.tags are
      // provenance only and must not be confused with required request fields.
      agent_name: e.agent_name ?? "fusion",
      session_id: (e as StashEvent).session_id ?? sessionId,
      ...(sessionFolderId ? { session_folder_id: sessionFolderId } : {}),
      metadata: {
        ...(e.metadata ?? {}),
        discriminator,
        task_id: taskId,
        session_id: sessionId,
        // RUFU-035: capture stays topic-agnostic for write — every session is
        // still captured. The active topic is only recorded as session metadata
        // so a topic-aware search route can filter on it.
        ...(topic ? { topic } : {}),
        // FNXC:RUFU121MetadataEnrichment 2026-08-18-19:53:
        // RUFU-121 identity enrichment — keys appear only when the value is
        // present (never `undefined` spam).
        ...(projectId ? { project: projectId } : {}),
        ...(projectName ? { project_name: projectName } : {}),
        ...(chatTitle ? { chat_title: chatTitle } : {}),
      },
    }));
    if (tagged.length === 0) {
      // The captureMemory facade already no-ops on an empty list; keep the sink
      // safe for direct callers too (an empty POST is never issued).
      return { inserted: 0, deduped: 0, ok: true };
    }
    /*
    FNXC:RUFU122ChunkedUpload 2026-08-19-04:30:
    RUFU-122: Stash caps events per /events/batch POST at 100 (verified against
    the live instance in preflight); the task terminal transcript (up to 20000
    events) must therefore upload in sequential 100-event chunks — one chunk
    per POST, no retries, stop at the first failed chunk. `inserted`/`deduped`
    accumulate the LEADING successful chunks (the partial result); ok:true only
    when EVERY chunk succeeded, so a partial upload is always distinguishable
    from a full one. The pre-cap path (tagged.length <= 100) issues exactly one
    POST of the full tagged array — byte-identical to the previous single-upload
    wire contract. Dedup remains server-side per-event content addressing: each
    chunk is an ordinary batch POST. Never throws.
    */
    let inserted = 0;
    let deduped = 0;
    let allChunksSucceeded = true;
    for (let start = 0; start < tagged.length; start += STASH_EVENT_BATCH_CHUNK_SIZE) {
      const chunk = tagged.slice(start, start + STASH_EVENT_BATCH_CHUNK_SIZE);
      try {
        const raw = (await this.batchUpload(discriminator, chunk)) as unknown;
        // FNXC:StashEmptyBatch2xx 2026-08-21-13:35:
        // RUFU-146 review (PRRT_kwDOSA-8Y86bC_sK): a 2xx with an empty body
        // (204, or a 200 whose FFI layer emits no payload) is a VALID zero
        // count — the transport resolves it to null, and treating it as a
        // failure previously flipped ok:false (and stopped the chunk loop)
        // on every such server. Count it as a successful 0-inserted chunk.
        if (raw == null) continue;
        // Stash returns a JSON array ([HistoryEventResponse]) for /events/batch;
        // older/FFI mocks return { inserted, deduped }. Accept both so the count
        // is meaningful and unit tests stay green (FNXC:StashEventShape).
        inserted += Array.isArray(raw)
          ? raw.length
          : ((raw as StashBatchResponse).inserted ?? (raw as StashBatchResponse).count ?? 0);
        deduped += Array.isArray(raw) ? 0 : ((raw as StashBatchResponse).deduped ?? 0);
      } catch {
        // Partial failure: keep the leading chunks' counts, stop, and mark the
        // upload incomplete — no retries, no further chunks.
        allChunksSucceeded = false;
        break;
      }
    }
    return { inserted, deduped, ok: allChunksSucceeded };
  }

  /** End session — no-op for a stateless REST backend. */
  async endSession(_sessionId: string): Promise<void> {
    // Stash capture is per-event and idempotent; there is no server session to flush.
    return;
  }

  // ── Private HTTP helpers ───────────────────────────────────────────

  /** POST /api/v1/me/sessions/events/batch — idempotent push_events_batch. */
  private async batchUpload(discriminator: string, events: StashEvent[]): Promise<StashBatchResponse> {
    return this.httpRequest<StashBatchResponse>("/api/v1/me/sessions/events/batch", "POST", {
      events: events.map((e) => ({
        ...e,
        // FNXC:StashEventShape 2026-08-07-10:39: fail-closed last line of defence.
        // Stash rejects any event missing top-level agent_name / session_id with
        // 422. Capture and write already surface both, but keep a default here so
        // a future caller can never silently drop a capture to a 422.
        agent_name: e.agent_name ?? "fusion",
        session_id: e.session_id ?? this.sessionIdFor(""),
        metadata: { ...(e.metadata ?? {}), discriminator },
      })),
    });
  }

  /**
   * FNXC:RUFU121TransportSeam 2026-08-18-19:53:
   * RUFU-121: thin typed wrapper over the injectable transport seam. The real
   * node:http transport moved to module-level `stashHttpJsonRequest` so the
   * standalone helpers share it without a backend instance; behavior is
   * unchanged (10s timeout, Bearer auth, 2xx-only).
   */
  private httpRequest<T>(path: string, method: StashHttpMethod, body?: unknown): Promise<T> {
    return this.client(path, method, body) as Promise<T>;
  }
}

// ── Standalone Stash helpers (RUFU-121) ──────────────────────────────

/**
 * FNXC:RUFU121StructuredQuery 2026-08-18-19:53:
 * RUFU-121: filters for Stash's structured event-query endpoint
 * (GET /api/v1/me/sessions/events — the verified route in the Stash checkout;
 * the spec's shorthand `GET /api/v1/me/events` is not a real route).
 */
export interface StashEventQueryFilters {
  /** Exact-match filter on the event's top-level agent_name. */
  agentName?: string;
  /** Exact-match filter on the event's top-level session_id. */
  sessionId?: string;
  /** Exact-match filter on the event's top-level event_type. */
  eventType?: string;
  /** ISO-8601 lower bound (inclusive). */
  after?: string;
  /** ISO-8601 upper bound (exclusive). */
  before?: string;
  /** Result cap, clamped to 1..200 (Stash's hard limit). Default 50. */
  limit?: number;
  /** Result ordering. Default "desc" (newest first). */
  order?: "asc" | "desc";
}

/** Build the structured event-query path (query string included). */
function buildStashEventQueryPath(filters: StashEventQueryFilters): string {
  const params: string[] = [];
  if (filters.agentName !== undefined) params.push(`agent_name=${encodeURIComponent(filters.agentName)}`);
  if (filters.sessionId !== undefined) params.push(`session_id=${encodeURIComponent(filters.sessionId)}`);
  if (filters.eventType !== undefined) params.push(`event_type=${encodeURIComponent(filters.eventType)}`);
  if (filters.after !== undefined) params.push(`after=${encodeURIComponent(filters.after)}`);
  if (filters.before !== undefined) params.push(`before=${encodeURIComponent(filters.before)}`);
  params.push(`limit=${Math.max(1, Math.min(filters.limit ?? 50, 200))}`);
  params.push(`order=${filters.order === "asc" ? "asc" : "desc"}`);
  return `/api/v1/me/sessions/events?${params.join("&")}`;
}

/**
 * FNXC:RUFU121StructuredQuery 2026-08-18-19:53:
 * RUFU-121: one-shot structured query of Stash's event store (the recall
 * seam for RUFU-120). Returns { events, hasMore }; malformed/missing
 * `events` degrades to []. Transport errors PROPAGATE to the caller — the
 * caller owns degradation policy (this is a query helper, not the
 * best-effort capture/delete path). `http` injects a recorder fake in
 * tests; default is the real node:http transport.
 */
export async function queryStashEvents(
  baseUrl: string,
  apiKey: string,
  filters: StashEventQueryFilters = {},
  http?: StashHttpClient,
): Promise<{ events: Array<Record<string, unknown>>; hasMore: boolean }> {
  const base = (baseUrl ?? DEFAULT_STASH_URL).replace(/\/+$/, "");
  const client: StashHttpClient =
    http ?? ((path, method, payload) => stashHttpJsonRequest(base, apiKey, path, method, payload));
  const resp = (await client(buildStashEventQueryPath(filters), "GET")) as
    | { events?: unknown; has_more?: unknown }
    | null;
  const raw = resp?.events;
  const events = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
  return { events, hasMore: resp?.has_more === true };
}

/**
 * FNXC:RUFU121DeleteSync 2026-08-18-19:53:
 * RUFU-121: result of the best-effort chat-session soft-delete sync.
 * `deleted` is true only on a confirmed DELETE; `status` distinguishes
 * "confirmed delete" / "nothing to delete (row absent / 404)" / "skipped
 * (network/5xx — session remains in Stash)".
 */
export interface StashChatSessionDeleteResult {
  deleted: boolean;
  status: "ok" | "not-found" | "skipped";
}

/**
 * FNXC:RUFU121DeleteSync 2026-08-18-19:53:
 * RUFU-121: soft-delete the Stash session row whose top-level `session_id`
 * matches a Fusion chat session id. Best-effort: NEVER throws.
 *
 * Single-shot by-id lookup (RUFU-130): GET /api/v1/me/sessions/<session_id>
 * returns the row directly (scope-bound, read-gated); on 200 take the row
 * uuid from the payload `id` field and issue
 * DELETE /api/v1/me/sessions/<row-uuid> (204) — the per-row delete
 * contract is unchanged. 404 → "not-found" (identical semantics to the
 * old windowed-scan miss: absent, unreadable, or already soft-deleted);
 * network/5xx → "skipped" (session remains in Stash — acceptable,
 * best-effort contract).
 *
 * FNXC:RUFU130ByIdLookup 2026-08-19-16:43:
 * RUFU-130: replaces RUFU-121's windowed session-list scan (client-side
 * session_id matching over the global recent window) by the single-shot
 * by-id lookup, removing the bounded-sync residual where sessions outside
 * the recent window were never found and deleted chats leaked into Stash.
 * The by-id lookup GET /api/v1/me/sessions/{session_id} is verified
 * deployed on the live backend (RUFU-129 Step 1); it returns the row with
 * `id` (the row uuid, always a string) or 404 when absent. A 200 payload
 * without a usable `id` is treated as not-found WITHOUT issuing a DELETE
 * (defense in depth — mirrors the old null-row-id behavior). The per-row
 * delete contract is unchanged, and the RUFU-125 bulk path remains paged
 * until RUFU-131 adopts the upstream bulk soft-delete endpoint.
 */
export async function deleteStashChatSession(
  baseUrl: string,
  apiKey: string,
  sessionId: string,
  http?: StashHttpClient,
): Promise<StashChatSessionDeleteResult> {
  const base = (baseUrl ?? DEFAULT_STASH_URL).replace(/\/+$/, "");
  const client: StashHttpClient =
    http ?? ((path, method, payload) => stashHttpJsonRequest(base, apiKey, path, method, payload));
  try {
    const resp = await client(`/api/v1/me/sessions/${encodeURIComponent(sessionId)}`, "GET");
    const rowId = (resp as { id?: unknown } | null)?.id;
    const rowIdStr = typeof rowId === "string" ? rowId : typeof rowId === "number" ? String(rowId) : undefined;
    if (!rowIdStr) return { deleted: false, status: "not-found" };
    await client(`/api/v1/me/sessions/${encodeURIComponent(rowIdStr)}`, "DELETE");
    return { deleted: true, status: "ok" };
  } catch (err) {
    /*
    FNXC:RUFU121DeleteSync 2026-08-18-19:53:
    404 from either call means nothing to delete; anything else (network/5xx)
    is a skip — the dashboard route must never observe a throw from this path.
    */
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("404")) return { deleted: false, status: "not-found" };
    return { deleted: false, status: "skipped" };
  }
}

// ── Bulk chat-session delete sync (RUFU-125) ─────────────────────────────

/**
 * FNXC:RUFU125BulkArchiveSync 2026-08-19-06:07:
 * RUFU-125: default page cap for the bulk session-list scan — 10 pages ×
 * 200 rows = a 2000-row lookback. Stash's session list has no by-session-id
 * filter, so the scan pages `GET /api/v1/me/sessions?limit=200&offset=<n*200>`
 * in `last_event_at DESC` order until every target matched, the server
 * window is exhausted (a page returns < 200 rows), or the cap is reached.
 * Rows older than the window are NOT soft-deleted — documented residual,
 * debug-logged at the call site.
 */
export const DEFAULT_STASH_BULK_MAX_PAGES = 10;

/**
 * FNXC:RUFU125BulkArchiveSync 2026-08-19-06:07:
 * RUFU-125: counters for the bulk soft-delete sync. `targets` is the
 * de-duplicated, blank-stripped id count; `matched` counts listed rows whose
 * top-level `session_id` was a target; `deleted` counts confirmed 2xx
 * DELETEs; `pagesScanned` counts session-list pages fetched; `truncated`
 * is true ONLY when the scan stopped (page cap or GET failure) with
 * unmatched targets still outstanding — those rows remain in Stash.
 */
export interface StashBulkChatSessionDeleteResult {
  targets: number;
  matched: number;
  deleted: number;
  pagesScanned: number;
  truncated: boolean;
}

/**
 * FNXC:RUFU125BulkArchiveSync 2026-08-19-06:07:
 * RUFU-125: soft-delete the Stash session rows matching a BULK of Fusion
 * chat session ids. The task-planner archival path bulk-deletes local chat
 * sessions via ChatStore.deleteSessionsForAgentId, which bypasses the
 * per-session `DELETE /api/chat/sessions/:id` route RUFU-121 hooks — so
 * the matching Stash rows lingered. This is the batched twin of
 * deleteStashChatSession, which RUFU-130 migrated to the single-shot by-id
 * lookup (GET /api/v1/me/sessions/{session_id}); the bulk path has no such
 * per-id endpoint yet, so this one pages
 * `GET /api/v1/me/sessions?limit=200&offset=<pages*200>` (rows arrive
 * `last_event_at DESC`) until the upstream bulk soft-delete endpoint is
 * adopted (RUFU-131), then
 * `DELETE /api/v1/me/sessions/<row.id>` (204) per matched row.
 *
 * Contract (best-effort, mirrors RUFU-121):
 * - NEVER throws. Blank/non-string ids are dropped and duplicates collapsed
 *   before any HTTP; an empty target set returns a zeroed result with ZERO
 *   HTTP calls.
 * - A row matches iff its `session_id` is a string still in the target set.
 *   Only rows with a non-null `id` (string|number → String) are matchable —
 *   a null row id means the row is already soft-deleted (the endpoint still
 *   lists such rows with `id: null`); they are skipped but still consume a
 *   lookback slot (they occupy the page they appear on).
 * - A GET failure mid-scan stops the scan with a PARTIAL result (no throw);
 *   a DELETE 404 → row not counted (concurrent delete); any other DELETE
 *   error → row not counted, remaining rows still attempted.
 * - `truncated: true` iff the scan stopped at the page cap or on a GET
 *   failure while unmatched targets remain; `false` when all targets
 *   matched or the server window was fully scanned.
 *
 * Documented residual: rows older than the page-cap window are not
 * soft-deleted and remain in Stash — the caller debug-logs the miss.
 */
export async function deleteStashChatSessions(
  baseUrl: string,
  apiKey: string,
  sessionIds: string[],
  opts?: { http?: StashHttpClient; maxPages?: number },
): Promise<StashBulkChatSessionDeleteResult> {
  const targets = [...new Set(sessionIds.filter((id) => typeof id === "string" && id.trim().length > 0))];
  if (targets.length === 0) {
    return { targets: 0, matched: 0, deleted: 0, pagesScanned: 0, truncated: false };
  }
  const maxPages = Math.max(1, opts?.maxPages ?? DEFAULT_STASH_BULK_MAX_PAGES);
  const base = (baseUrl ?? DEFAULT_STASH_URL).replace(/\/+$/, "");
  const client: StashHttpClient =
    opts?.http ?? ((path, method, payload) => stashHttpJsonRequest(base, apiKey, path, method, payload));

  const remaining = new Set(targets);
  let matched = 0;
  let deleted = 0;
  let pagesScanned = 0;
  let windowExhausted = false;
  try {
    for (let page = 0; page < maxPages && remaining.size > 0; page += 1) {
      pagesScanned = page + 1;
      let resp: unknown = null;
      try {
        resp = await client(`/api/v1/me/sessions?limit=200&offset=${page * 200}`, "GET");
      } catch {
        break; // GET failure mid-scan → partial result, never throw
      }
      const raw = (resp as { sessions?: unknown } | null)?.sessions;
      const rows = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
      for (const row of rows) {
        const sessionId = row?.session_id;
        if (typeof sessionId !== "string" || !remaining.has(sessionId)) continue;
        remaining.delete(sessionId);
        matched += 1;
        const rowId = row?.id;
        const rowIdStr =
          typeof rowId === "string" ? rowId : typeof rowId === "number" ? String(rowId) : undefined;
        if (!rowIdStr) continue; // null id: already soft-deleted — not matchable, slot consumed
        try {
          await client(`/api/v1/me/sessions/${encodeURIComponent(rowIdStr)}`, "DELETE");
          deleted += 1;
        } catch {
          // 404 → concurrent delete; 5xx/network → row stays. Either way the
          // row is not counted deleted and the scan continues with the rest.
        }
      }
      if (rows.length < 200) {
        windowExhausted = true;
        break; // server window exhausted — no further pages exist
      }
    }
  } catch {
    // Defense in depth: every inner call is already caught; this keeps the
    // never-throw contract honest if a future edit regresses one of them.
  }
  return {
    targets: targets.length,
    matched,
    deleted,
    pagesScanned,
    truncated: remaining.size > 0 && !windowExhausted,
  };
}

/**
 * FNXC:RUFU125BulkArchiveSync 2026-08-19-06:07:
 * RUFU-125: structural store surface for bulkDeleteStashChatSessions —
 * `getSettings()` plus the RUFU-121 StashSecretsReader duck type. A real
 * TaskStore satisfies it (its `Settings` type carries the
 * `[key: string]: unknown` index signature, so it is assignable to
 * MemoryBackendSettings).
 */
export interface StashBulkDeleteStore extends StashSecretsReader {
  getSettings(): Promise<MemoryBackendSettings | undefined>;
}

/**
 * FNXC:RUFU125BulkArchiveSync 2026-08-19-06:07:
 * RUFU-125: outcome of the store-resolving bulk sync wrapper. `skipped`
 * (with `skipReason`) = the sync deliberately made ZERO Stash calls — the
 * identical skip conditions as RUFU-121's per-session route sync; `skipped:
 * false` + `result` = the paged scan ran. `sync-error` covers the
 * unreachable-by-contract safety net so the never-throw promise survives a
 * future regression in a dependency.
 */
export type StashBulkChatSessionSyncSummary =
  | {
      skipped: true;
      skipReason:
        | "settings-error"
        | "memory-disabled"
        | "non-stash-backend"
        | "unresolvable-credentials"
        | "no-sessions"
        | "sync-error";
    }
  | { skipped: false; result: StashBulkChatSessionDeleteResult };

/**
 * FNXC:RUFU125BulkArchiveSync 2026-08-19-06:07:
 * RUFU-125: store-resolving wrapper for the bulk sync. Mirrors RUFU-121's
 * route skip-guards byte-for-byte — settings read, resolveStashMemorySettings
 * (per-project `stashApiKey` override wins, else the global secrets-store
 * `stash-api-key`), the same trim + DEFAULT_STASH_URL fallback the route
 * uses (mirrors resolveMemoryBackend), then the API-key gate. NEVER throws:
 * a `getSettings` rejection degrades to `settings-error`; the outer catch is
 * an unreachable safety net (resolveStashMemorySettings and
 * deleteStashChatSessions both degrade internally).
 */
export async function bulkDeleteStashChatSessions(
  store: StashBulkDeleteStore,
  sessionIds: string[],
  opts?: { http?: StashHttpClient; maxPages?: number },
): Promise<StashBulkChatSessionSyncSummary> {
  const targets = [...new Set(sessionIds.filter((id) => typeof id === "string" && id.trim().length > 0))];
  try {
    let settings: MemoryBackendSettings | undefined;
    try {
      settings = await store.getSettings();
    } catch {
      return { skipped: true, skipReason: "settings-error" };
    }
    const resolved = await resolveStashMemorySettings(store, settings);
    if (!resolved || resolved.memoryEnabled === false) {
      return { skipped: true, skipReason: "memory-disabled" };
    }
    if (resolved.memoryBackendType !== "stash") {
      return { skipped: true, skipReason: "non-stash-backend" };
    }
    const rawStashUrl = resolved.stashUrl;
    const stashUrl =
      typeof rawStashUrl === "string" && rawStashUrl.trim().length > 0
        ? rawStashUrl.trim()
        : DEFAULT_STASH_URL;
    const stashApiKey = resolved.stashApiKey;
    if (!stashApiKey) return { skipped: true, skipReason: "unresolvable-credentials" };
    if (targets.length === 0) return { skipped: true, skipReason: "no-sessions" };
    const result = await deleteStashChatSessions(stashUrl, stashApiKey, targets, opts);
    return { skipped: false, result };
  } catch {
    // Unreachable by contract — both awaited dependencies degrade internally.
    return { skipped: true, skipReason: "sync-error" };
  }
}