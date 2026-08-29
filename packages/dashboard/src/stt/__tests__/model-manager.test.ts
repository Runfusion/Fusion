import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createVoiceModelManager, parseSafeTarListing } from "../model-manager.js";

const payload = Buffer.from("verified archive bytes");
const digest = createHash("sha256").update(payload).digest("hex");
const asset = { url: "https://example.invalid/parakeet.tar", filename: "parakeet.tar", sha256: digest, expectedFiles: ["tokens.txt"] };
const response = () => new Response(new ReadableStream({ start(controller) { controller.enqueue(payload); controller.close(); } }), { status: 200, headers: { "content-length": String(payload.length) } });
const deferred = <T = void>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };
const safeListing = "-rw-r--r-- root/root 6 2026-01-01 00:00 tokens.txt";

describe("voice model manager", () => {
  it.each([
    "-rw-r--r-- root/root 6 2026-01-01 00:00 tokens.txt",
    "-rw-r--r-- root wheel 6 Aug 16 12:34 2025 tokens.txt",
    "-rw-r--r-- 0 runner staff 93939 Aug 16  2025 tokens.txt",
  ])("accepts supported tar timestamp formats: %s", (listing) => expect(parseSafeTarListing(listing)).toEqual({ safe: true }));

  it.each([
    "lrwxrwxrwx root/root 0 2026-01-01 00:00 model -> /tmp/x",
    "hrwxrwxrwx root/root 0 2026-01-01 00:00 model hard link to other",
    "crw-rw-rw- root/root 0 2026-01-01 00:00 device",
    "-rw-r--r-- root/root 0 2026-01-01 00:00 /absolute",
    "-rw-r--r-- root/root 0 2026-01-01 00:00 ../escape",
    "-rw-r--r-- root wheel 6 Jan 1 00:00 2026 /absolute-bsd",
  ])("rejects unsafe tar metadata: %s", (listing) => expect(parseSafeTarListing(listing)).toMatchObject({ safe: false }));

  it("streams a verified archive, extracts only after a safe listing, and writes a manifest", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "voice-model-"));
    const extract = vi.fn(async (_archive: string, staging: string) => { await writeFile(join(staging, "tokens.txt"), "tokens"); });
    const manager = createVoiceModelManager({ cacheDir, asset, fetch: vi.fn(async () => response()) as typeof fetch, listArchive: async () => "-rw-r--r-- root/root 6 2026-01-01 00:00 tokens.txt", extract });
    expect(manager.scheduleDownload().state.status).toBe("downloading");
    await manager.download();
    expect(await manager.getState()).toMatchObject({ status: "installed", checksumVerified: true });
    expect(extract).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(join(cacheDir, "model", "manifest.json"), "utf8"))).toMatchObject({ sha256: digest });
  });

  it("promotes a stripped nested archive fixture with model files at the install root", async () => {
    const fixture = Buffer.from("nested Parakeet archive fixture");
    const nestedAsset = {
      url: "https://example.invalid/parakeet-nested.tar.bz2",
      filename: "parakeet-nested.tar.bz2",
      sha256: createHash("sha256").update(fixture).digest("hex"),
      expectedFiles: ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"],
      stripComponents: 1,
    };
    const cacheDir = await mkdtemp(join(tmpdir(), "voice-nested-model-"));
    const manager = createVoiceModelManager({
      cacheDir,
      asset: nestedAsset,
      fetch: vi.fn(async () => new Response(fixture)) as typeof fetch,
      listArchive: async () => [
        "drwxr-xr-x 0 runner staff 0 Aug 16  2025 sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/",
        "-rw-r--r-- 0 runner staff 1 Aug 16  2025 sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/encoder.int8.onnx",
      ].join("\n"),
      // The extract seam represents tar invoked with this fixture asset's strip-components value.
      extract: async (_archive, staging) => Promise.all(nestedAsset.expectedFiles.map((file) => writeFile(join(staging, file), "model"))).then(() => undefined),
    });

    await expect(manager.download()).resolves.toMatchObject({ status: "installed", checksumVerified: true });
    for (const expected of nestedAsset.expectedFiles) await expect(readFile(join(cacheDir, "model", expected), "utf8")).resolves.toBe("model");
  });

  it("reports a nested archive missing an expected file as incomplete", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "voice-incomplete-model-"));
    const incompleteAsset = { ...asset, expectedFiles: ["tokens.txt", "encoder.int8.onnx"], stripComponents: 1 };
    const manager = createVoiceModelManager({
      cacheDir,
      asset: incompleteAsset,
      fetch: vi.fn(async () => response()) as typeof fetch,
      listArchive: async () => "-rw-r--r-- 0 runner staff 6 Aug 16  2025 sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/tokens.txt",
      extract: async (_archive, staging) => writeFile(join(staging, "tokens.txt"), "tokens"),
    });

    await expect(manager.download()).resolves.toMatchObject({ status: "error", errorReason: "incomplete-install" });
  });

  it("reports a corrupt final model directory as incomplete instead of absent", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "voice-model-"));
    await mkdir(join(cacheDir, "model"));
    await writeFile(join(cacheDir, "model", "manifest.json"), JSON.stringify({ sha256: "stale" }));
    const manager = createVoiceModelManager({ cacheDir, asset });
    await expect(manager.getState()).resolves.toMatchObject({ status: "error", errorReason: "incomplete-install" });
  });

  it("publishes filesystem-inspected terminal states so polling snapshots stay current", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "voice-inspected-state-"));
    await mkdir(join(cacheDir, "model"));
    await writeFile(join(cacheDir, "model", "tokens.txt"), "tokens");
    await writeFile(join(cacheDir, "model", "manifest.json"), JSON.stringify({ sha256: digest }));
    const manager = createVoiceModelManager({ cacheDir, asset });
    const observed: string[] = [];
    manager.subscribe((next) => observed.push(next.status));

    await expect(manager.getState()).resolves.toMatchObject({ status: "installed" });
    expect(manager.peekState()).toMatchObject({ status: "installed" });
    await rm(join(cacheDir, "model"), { recursive: true });
    await expect(manager.getState()).resolves.toMatchObject({ status: "not-installed" });
    expect(manager.peekState()).toMatchObject({ status: "not-installed" });
    expect(observed).toEqual(["installed", "not-installed"]);
  });

  it("rolls back a prior installed model when staging promotion fails", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "voice-promotion-rollback-"));
    const modelDir = join(cacheDir, "model");
    await mkdir(modelDir);
    await writeFile(join(modelDir, "tokens.txt"), "previous");
    await writeFile(join(modelDir, "manifest.json"), JSON.stringify({ sha256: digest }));
    const move = vi.fn(async (from: string | Buffer | URL, to: string | Buffer | URL) => {
      if (String(from).includes(".staging-") && String(to) === modelDir) throw new Error("promotion failed");
      await rename(from, to);
    });
    const manager = createVoiceModelManager({
      cacheDir, asset, rename: move as typeof rename,
      fetch: vi.fn(async () => response()) as typeof fetch,
      listArchive: async () => safeListing,
      extract: async (_archive, staging) => { await writeFile(join(staging, "tokens.txt"), "replacement"); },
    });

    await manager.download();
    expect(manager.peekState()).toMatchObject({ status: "error", errorReason: "extraction-failed" });
    await expect(readFile(join(modelDir, "tokens.txt"), "utf8")).resolves.toBe("previous");
    await expect(readFile(join(modelDir, "manifest.json"), "utf8")).resolves.toContain(digest);
    expect((await readdir(cacheDir)).some((entry) => entry.startsWith(".backup-"))).toBe(false);
  });

  it("does not fetch or expose a cached model when its digest is unpinned", async () => {
    const fetch = vi.fn();
    const cacheDir = await mkdtemp(join(tmpdir(), "voice-unpinned-"));
    await mkdir(join(cacheDir, "model"));
    await writeFile(join(cacheDir, "model", "manifest.json"), JSON.stringify({ sha256: null }));
    const manager = createVoiceModelManager({ asset: { ...asset, sha256: null }, cacheDir, fetch });
    expect(manager.scheduleDownload()).toMatchObject({ accepted: false, state: { errorReason: "checksum-unpinned" } });
    await expect(manager.getState()).resolves.toMatchObject({ status: "error", errorReason: "checksum-unpinned", checksumVerified: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("labels unsafe listing and extractor failures without promotion", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "voice-model-"));
    const manager = createVoiceModelManager({ cacheDir, asset, fetch: vi.fn(async () => response()) as typeof fetch, listArchive: async () => "lrwxrwxrwx root/root 0 2026-01-01 00:00 model -> /tmp/x" });
    await manager.download();
    expect(manager.peekState()).toMatchObject({ status: "error", errorReason: "unsafe-archive" });
  });

  it.each(["fetch", "hash", "extract", "promotion"] as const)("fences deletion synchronously during %s without promotion", async (window) => {
    const cacheDir = await mkdtemp(join(tmpdir(), `voice-race-${window}-`));
    const gate = deferred();
    let observedSignal: AbortSignal | undefined;
    const extract = vi.fn(async (_archive: string, staging: string, signal: AbortSignal) => {
      observedSignal = signal;
      await writeFile(join(staging, "tokens.txt"), "tokens");
      if (window === "extract") await gate.promise;
    });
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      observedSignal = init?.signal as AbortSignal;
      if (window !== "fetch") return response();
      return new Response(new ReadableStream({ async start(controller) { controller.enqueue(payload); await gate.promise; controller.close(); } }), { status: 200 });
    }) as typeof globalThis.fetch;
    const manager = createVoiceModelManager({
      cacheDir, asset, fetch, extract,
      listArchive: async (_archive, signal) => { observedSignal = signal; if (window === "hash") await gate.promise; return safeListing; },
      beforePromote: async (signal) => { observedSignal = signal; if (window === "promotion") await gate.promise; },
    });
    manager.scheduleDownload();
    await vi.waitFor(() => expect(observedSignal).toBeDefined());
    const removal = manager.remove();
    // Phase A is deliberately synchronous, before any controllable worker window releases.
    expect(observedSignal!.aborted).toBe(true);
    gate.resolve();
    await removal;
    expect(await manager.getState()).toMatchObject({ status: "not-installed" });
    expect((await readdir(cacheDir)).filter((entry) => entry === "model" || entry.startsWith(".partial-") || entry.startsWith(".staging-"))).toEqual([]);
    expect(extract).toHaveBeenCalledTimes(window === "fetch" || window === "hash" ? 0 : 1);
  });

  it("queues a later download behind remove cleanup without deleting its generation", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "voice-cleanup-barrier-"));
    const cleanup = deferred();
    const fetch = vi.fn(async () => response()) as typeof fetch;
    const manager = createVoiceModelManager({ cacheDir, asset, fetch, listArchive: async () => safeListing, extract: async (_archive, staging) => { await writeFile(join(staging, "tokens.txt"), "tokens"); }, beforeCleanup: async () => cleanup.promise });
    const removing = manager.remove();
    const scheduled = manager.scheduleDownload();
    expect(scheduled).toMatchObject({ accepted: true, state: { status: "queued" } });
    expect(fetch).not.toHaveBeenCalled();
    cleanup.resolve();
    await removing;
    await manager.download();
    expect(await manager.getState()).toMatchObject({ status: "installed", checksumVerified: true });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("fences an in-flight download immediately before queued cleanup", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "voice-model-"));
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let observedSignal: AbortSignal | undefined;
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      observedSignal = init?.signal as AbortSignal;
      return new Response(new ReadableStream({ async start(controller) { controller.enqueue(payload); await blocked; controller.enqueue(payload); controller.close(); } }), { status: 200 });
    }) as typeof globalThis.fetch;
    const manager = createVoiceModelManager({ cacheDir, asset, fetch, listArchive: async () => "-rw-r--r-- root/root 6 2026-01-01 00:00 tokens.txt" });
    manager.scheduleDownload();
    await vi.waitFor(() => expect(observedSignal).toBeDefined());
    const removal = manager.remove();
    // Phase A is synchronous: abort happens before either the stream or cleanup is released.
    expect(observedSignal!.aborted).toBe(true);
    release();
    await removal;
    expect(await manager.getState()).toMatchObject({ status: "not-installed" });
    expect(await readdir(cacheDir)).not.toContain("model");
    expect((await readdir(cacheDir)).filter((entry) => entry.startsWith(".partial-") || entry.startsWith(".staging-"))).toEqual([]);
  });
});
