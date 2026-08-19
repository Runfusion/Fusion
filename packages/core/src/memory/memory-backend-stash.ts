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
 */
export function stashHttpJsonRequest<T>(
  baseUrl: string,
  apiKey: string,
  path: string,
  method: StashHttpMethod,
  payload?: unknown,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const url = new URL(path, baseUrl + "/");
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

    const req = http.request(options, (res) => {
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
  }) {
    this.baseUrl = (options?.baseUrl ?? DEFAULT_STASH_URL).replace(/\/+$/, "");
    this.apiKey = options?.apiKey ?? "";
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
   */
  async search(rootDir: string, options: MemorySearchOptions): Promise<MemorySearchResult[]> {
    const req = options.query || "";
    const limit = Math.max(1, Math.min(options.limit ?? 5, 20));
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
 * Two-step lookup: Stash's DELETE takes the ROW id (uuid pk), not the
 * top-level session_id string — so first GET /api/v1/me/sessions (limit=200)
 * and match row.session_id, then DELETE /api/v1/me/sessions/<row.id> (204).
 * Missing row / 404 → "not-found" (nothing to delete); network/5xx →
 * "skipped" (session remains in Stash — acceptable, best-effort contract).
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
    const resp = await client("/api/v1/me/sessions?limit=200", "GET");
    const raw = (resp as { sessions?: unknown } | null)?.sessions;
    const rows = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
    const row = rows.find((r) => r && r.session_id === sessionId);
    const rowId = row?.id;
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