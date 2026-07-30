import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { resolveGlobalDir, superviseSpawn } from "@fusion/core";
import { PARAKEET_V3_ASSET, type VoiceModelAsset, type VoiceModelState } from "./types.js";

export interface VoiceModelManager {
  getState(): Promise<VoiceModelState>;
  peekState(): VoiceModelState;
  scheduleDownload(): { accepted: boolean; state: VoiceModelState };
  download(): Promise<VoiceModelState>;
  remove(): Promise<void>;
  subscribe(listener: (state: VoiceModelState) => void): () => void;
}
export interface VoiceModelManagerOptions {
  asset?: VoiceModelAsset;
  cacheDir?: string;
  fetch?: typeof globalThis.fetch;
  /** Test seam; production lists and extracts with async tar invocations. */
  extract?: (archive: string, staging: string, signal: AbortSignal) => Promise<void>;
  listArchive?: (archive: string, signal: AbortSignal) => Promise<string>;
  /** Deterministic test seam for the post-validation/pre-promotion cancellation fence. */
  beforePromote?: (signal: AbortSignal) => Promise<void>;
  /** Deterministic test seam for cleanup-barrier scheduling behavior. */
  beforeCleanup?: (generation: number) => Promise<void>;
  /** Test seam for verifying old-install rollback if promotion cannot complete. */
  rename?: typeof rename;
}

/** Reject tar metadata entries that can escape or alias the staging directory. */
export function parseSafeTarListing(listing: string): { safe: true } | { safe: false; reason: string } {
  for (const line of listing.split("\n").filter(Boolean)) {
    const type = line[0];
    if (type !== "-" && type !== "d") return { safe: false, reason: "unsafe entry type" };
    /*
     * FNXC:VoiceInput 2026-07-25-00:00:
     * The pinned Parakeet archive uses BSD `Mon DD  YYYY` metadata, in addition to GNU and
     * BSD-with-clock forms. Do not guess a column offset: owner/group fields vary, and guessing
     * could turn an absolute pathname into a harmless-looking date suffix.
     */
    const timestamp = /\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?\s+|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+(?:\d{2}:\d{2}(?::\d{2})?\s+\d{4}|\d{4})\s+/.exec(line);
    if (!timestamp || timestamp.index === undefined) return { safe: false, reason: "unparseable tar metadata" };
    const path = line.slice(timestamp.index + timestamp[0].length);
    if (!path || /\s(?:->|link to|hard link to)\s/.test(path) || path.startsWith("/") || path.split(/[\\/]+/).includes("..")) return { safe: false, reason: "unsafe entry path" };
  }
  return { safe: true };
}

/**
 * FNXC:VoiceInput 2026-07-21-17:20:
 * Voice models are on-demand, user-cache-only assets and lifecycle management remains available
 * while dictation is off. A pinned digest is mandatory. scheduleDownload publishes synchronously;
 * its worker waits behind cleanup, while remove fences the worker immediately and then serializes
 * generation-scoped cleanup. getState is authoritative and async; peekState is polling-only.
 */
export function createVoiceModelManager(options: VoiceModelManagerOptions = {}): VoiceModelManager {
  const asset = options.asset ?? PARAKEET_V3_ASSET;
  let configuredCacheDir = options.cacheDir;
  const cacheDir = () => configuredCacheDir ??= join(resolveGlobalDir(), "models", "parakeet-v3");
  const finalDir = () => join(cacheDir(), "model");
  let state: VoiceModelState = { status: "not-installed" };
  let generation = 0;
  let cleanupBarrier: Promise<void> = Promise.resolve();
  let cleanupPending = false;
  let active: { generation: number; controller: AbortController; settled: Promise<void> } | undefined;
  let work: Promise<VoiceModelState> = Promise.resolve(state);
  const listeners = new Set<(state: VoiceModelState) => void>();
  const publish = (next: VoiceModelState) => { state = next; for (const listener of listeners) listener(next); };
  const current = (g: number, signal: AbortSignal) => generation === g && !signal.aborted;
  const guarded = (g: number, signal: AbortSignal, next: VoiceModelState) => { if (current(g, signal)) publish(next); };
  const existsFile = async (file: string) => { try { const item = await stat(file); return item.isFile() && item.size > 0; } catch { return false; } };
  const removeOwn = async (...paths: Array<string | undefined>) => Promise.all(paths.filter(Boolean).map((path) => rm(path!, { recursive: true, force: true })));
  const inStaging = (staging: string, file: string) => {
    const target = resolve(staging, file);
    return relative(staging, target) !== "" && !relative(staging, target).startsWith(`..${sep}`) && !relative(staging, target).startsWith("../") ? target : undefined;
  };
  const capture = (stream: NodeJS.ReadableStream | null | undefined) => new Promise<string>((done) => {
    if (!stream) return done("");
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));
    stream.once("end", () => done(Buffer.concat(chunks).toString("utf8")));
    stream.once("close", () => done(Buffer.concat(chunks).toString("utf8")));
  });
  const runTar = async (args: string[], signal: AbortSignal) => {
    // FNXC:VoiceInput 2026-07-21-18:10: Archive inspection/extraction is a managed
    // child process so cancellation during model deletion reaches tar immediately.
    const supervised = superviseSpawn("tar", args, { stdio: ["ignore", "pipe", "pipe"], maxLifetimeMs: 120_000 });
    const onAbort = () => supervised.kill("SIGTERM");
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const [stdout, stderr, exit] = await Promise.all([capture(supervised.child.stdout), capture(supervised.child.stderr), supervised.waitExit()]);
      if (exit.code !== 0) throw new Error(stderr.trim() || `tar exited with ${exit.code ?? exit.signal ?? "an error"}`);
      return stdout;
    } finally { signal.removeEventListener("abort", onAbort); }
  };
  const listArchive = async (archive: string, signal: AbortSignal) => options.listArchive
    ? options.listArchive(archive, signal)
    : runTar(["-tvf", archive], signal);
  const extractArchive = async (archive: string, staging: string, signal: AbortSignal) => {
    if (options.extract) return options.extract(archive, staging, signal);
    await runTar(["--no-same-owner", "-x", `--strip-components=${asset.stripComponents ?? 0}`, "-f", archive, "-C", staging], signal);
  };
  const move = options.rename ?? rename;

  const perform = async (g: number, controller: AbortController): Promise<VoiceModelState> => {
    const signal = controller.signal;
    let partial: string | undefined;
    let staging: string | undefined;
    try {
      await cleanupBarrier;
      if (!current(g, signal)) return state;
      await mkdir(cacheDir(), { recursive: true });
      if (!current(g, signal)) return state;
      partial = join(cacheDir(), `.partial-${g}-${randomUUID()}`);
      staging = join(cacheDir(), `.staging-${g}-${randomUUID()}`);
      const file = await open(partial, "wx");
      try {
        const response = await (options.fetch ?? globalThis.fetch)(asset.url, { signal });
        if (!response.ok || !response.body) throw Object.assign(new Error("download failed"), { voiceReason: "network" });
        if (!current(g, signal)) return state;
        const total = Number(response.headers.get("content-length")) || undefined;
        const hash = createHash("sha256"); let bytes = 0;
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          if (!current(g, signal)) return state;
          const buffer = Buffer.from(chunk); hash.update(buffer); await file.write(buffer);
          if (!current(g, signal)) return state;
          bytes += buffer.length; guarded(g, signal, { status: "downloading", progress: total ? bytes / total : undefined, bytesDownloaded: bytes, totalBytes: total });
        }
        if (!current(g, signal)) return state;
        if (hash.digest("hex") !== asset.sha256) {
          guarded(g, signal, { status: "error", errorReason: "checksum-mismatch", checksumVerified: false });
          return state;
        }
      } finally { await file.close(); }
      if (!current(g, signal)) return state;
      const listing = await listArchive(partial, signal);
      if (!current(g, signal)) return state;
      const safe = parseSafeTarListing(listing);
      if (!safe.safe) { guarded(g, signal, { status: "error", errorReason: "unsafe-archive", errorMessage: safe.reason }); return state; }
      await mkdir(staging);
      await extractArchive(partial, staging, signal);
      if (!current(g, signal)) return state;
      for (const expected of asset.expectedFiles) {
        const target = inStaging(staging, expected);
        if (!target || !(await existsFile(target))) { guarded(g, signal, { status: "error", errorReason: "incomplete-install" }); return state; }
      }
      if (!current(g, signal)) return state;
      // Write the manifest before promotion so the promoted directory is always a complete
      // install. The previous final directory is retained as a rollback candidate until this
      // new staging directory has replaced it.
      await writeFile(join(staging, "manifest.json"), JSON.stringify({ filename: asset.filename, sha256: asset.sha256, installedAt: new Date().toISOString(), expectedFiles: asset.expectedFiles }));
      await options.beforePromote?.(signal);
      if (!current(g, signal)) return state;

      /*
       * FNXC:VoiceInput 2026-07-21-19:05:
       * A failed refresh must not destroy a working installed model. Move the old installation
       * aside, promote the fully validated staging tree, and restore the old tree if promotion
       * fails. Generation-fenced cleanup owns stale backup trees after deletion.
       */
      const backup = join(cacheDir(), `.backup-${g}-${randomUUID()}`);
      let movedPrevious = false;
      try {
        try {
          await move(finalDir(), backup);
          movedPrevious = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (!current(g, signal)) return state;
        await move(staging, finalDir()); staging = undefined;
      } catch (error) {
        if (movedPrevious) {
          try { await move(backup, finalDir()); } catch { /* Preserve the original failure. */ }
        }
        throw error;
      }
      if (!current(g, signal)) return state;
      if (movedPrevious) await rm(backup, { recursive: true, force: true }).catch(() => undefined);
      guarded(g, signal, { status: "installed", checksumVerified: true, installedPath: finalDir() });
      return state;
    } catch (error) {
      if (current(g, signal)) {
        const reason = signal.aborted ? "cancelled" : (error as { voiceReason?: string }).voiceReason === "network" ? "network" : "extraction-failed";
        guarded(g, signal, { status: "error", errorReason: reason, errorMessage: error instanceof Error ? error.message : String(error) });
      }
      return state;
    } finally {
      await removeOwn(partial, staging);
      if (active?.generation === g) active = undefined;
    }
  };

  const scheduleDownload = () => {
    if (!asset.sha256) { publish({ status: "error", errorReason: "checksum-unpinned", checksumVerified: false }); return { accepted: false, state }; }
    if (state.status === "queued" || state.status === "downloading") return { accepted: true, state };
    const g = ++generation;
    const controller = new AbortController();
    publish(cleanupPending ? { status: "queued" } : { status: "downloading", progress: 0, bytesDownloaded: 0 });
    const settled = perform(g, controller);
    active = { generation: g, controller, settled: settled.then(() => undefined) };
    work = settled;
    return { accepted: true, state };
  };

  return {
    peekState: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    scheduleDownload,
    async download() { const scheduled = scheduleDownload(); return scheduled.accepted ? work : scheduled.state; },
    async getState() {
      // An unpinned asset is never installable, even if stale files or a legacy manifest exist.
      // The mandatory checksum gate applies to status inspection as well as scheduling.
      if (!asset.sha256) {
        const unpinned = { status: "error" as const, errorReason: "checksum-unpinned" as const, checksumVerified: false };
        publish(unpinned);
        return unpinned;
      }
      if (state.status === "queued" || state.status === "downloading") return state;
      try {
        let finalExists = false;
        try { finalExists = (await stat(finalDir())).isDirectory(); } catch { /* no install yet */ }
        if (!finalExists) {
          if (state.status === "error") return state;
          const absent = { status: "not-installed" as const };
          publish(absent);
          return absent;
        }
        const manifest = JSON.parse(await readFile(join(finalDir(), "manifest.json"), "utf8"));
        if (manifest.sha256 !== asset.sha256) throw new Error("stale manifest digest");
        for (const expected of asset.expectedFiles) if (!(await existsFile(join(finalDir(), expected)))) throw new Error("missing expected model file");
        const installed = { status: "installed" as const, checksumVerified: true, installedPath: finalDir() };
        publish(installed);
        return installed;
      } catch (cause) {
        // A final directory is evidence of an interrupted/corrupt installation, not
        // an absent model. Surface an actionable state so operators can delete it.
        const corrupt = { status: "error" as const, errorReason: "incomplete-install" as const, errorMessage: cause instanceof Error ? cause.message : "incomplete model install" };
        publish(corrupt);
        return corrupt;
      } finally {
        try {
          for (const entry of await readdir(cacheDir())) {
            const own = /^\.(partial|staging|backup)-(\d+)-/.exec(entry);
            if (own && Number(own[2]) !== active?.generation) await rm(join(cacheDir(), entry), { recursive: true, force: true });
          }
        } catch { /* Cache absence and corruption must not break dashboard boot. */ }
      }
    },
    remove() {
      const g = ++generation;
      const stale = active;
      if (stale) { stale.controller.abort(); active = undefined; }
      cleanupPending = true;
      const previous = cleanupBarrier;
      const pending = cleanupBarrier = previous.then(async () => {
        await stale?.settled.catch(() => undefined);
        await options.beforeCleanup?.(g);
        await rm(finalDir(), { recursive: true, force: true });
        try {
          for (const entry of await readdir(cacheDir())) {
            const match = /^\.(partial|staging|backup)-(\d+)-/.exec(entry);
            if (match && Number(match[2]) <= g) await rm(join(cacheDir(), entry), { recursive: true, force: true });
          }
        } catch { /* absent cache is already clean */ }
        if (generation === g) publish({ status: "not-installed" });
      }).finally(() => { if (cleanupBarrier === pending) cleanupPending = false; });
      return pending;
    },
  };
}
