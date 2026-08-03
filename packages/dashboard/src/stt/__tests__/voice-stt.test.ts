import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createVoiceModelManager } from "../model-manager.js";
import { createParakeetService } from "../parakeet-service.js";
import { PARAKEET_V3_ASSET, resolveVoiceLanguage, resolveVoiceModelId } from "../types.js";

describe("voice STT graceful degradation", () => {
  it("pins a downloadable Parakeet v3 archive with its verified model files", () => {
    expect(PARAKEET_V3_ASSET).toMatchObject({
      filename: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2",
      url: expect.stringContaining("/releases/download/"),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      expectedFiles: ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"],
      stripComponents: 1,
    });
  });

  it("opens the pinned registry asset's pre-network download gate", async () => {
    const fetch = vi.fn(async () => { throw new Error("network must not be reached by this gate test"); });
    const manager = createVoiceModelManager({ cacheDir: await mkdtemp(join(tmpdir(), "voice-registry-")), fetch: fetch as typeof globalThis.fetch });

    await expect(manager.getState()).resolves.toMatchObject({ status: "not-installed" });
    expect(manager.scheduleDownload()).toMatchObject({ accepted: true });
  });

  it("refuses an unpinned archive synchronously without fetching", () => {
    const fetch = vi.fn();
    const manager = createVoiceModelManager({ cacheDir: "/unused", fetch, asset: { url: "https://example.test/model", filename: "model.tar", sha256: null, expectedFiles: [] } });
    expect(manager.scheduleDownload()).toMatchObject({ accepted: false, state: { status: "error", errorReason: "checksum-unpinned" } });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("reports a byte mismatch without installing an archive", async () => {
    const manager = createVoiceModelManager({
      cacheDir: await mkdtemp(join(tmpdir(), "voice-mismatch-")),
      asset: { url: "https://example.test/model", filename: "model.tar", sha256: "0".repeat(64), expectedFiles: [] },
      fetch: vi.fn(async () => new Response(Buffer.from("wrong bytes"))) as typeof globalThis.fetch,
    });

    await expect(manager.download()).resolves.toMatchObject({ status: "error", errorReason: "checksum-mismatch", checksumVerified: false });
  });

  it("keeps unknown model identifiers and languages out of runtime configuration", () => {
    expect(resolveVoiceModelId(undefined)).toEqual({ id: "parakeet-v3" });
    expect(resolveVoiceModelId("../unsafe")).toEqual({ unsupported: "../unsafe" });
    expect(resolveVoiceLanguage(undefined)).toEqual({ language: "en" });
    expect(resolveVoiceLanguage("fr")).toEqual({ unsupported: "fr" });
  });
  it("reports an uninstalled model without attempting to load the native binding", async () => {
    const loadBinding = vi.fn();
    const manager = { getState: async () => ({ status: "not-installed" as const }) } as ReturnType<typeof createVoiceModelManager>;
    const service = createParakeetService({ manager, loadBinding });

    await expect(service.getRuntimeStatus()).resolves.toEqual({ status: "unavailable", unavailableReason: "model-not-installed" });
    expect(loadBinding).not.toHaveBeenCalled();
  });

  it("reports a missing native binding as unavailable without throwing", async () => {
    const manager = { getState: async () => ({ status: "installed" as const, installedPath: "/model" }) } as ReturnType<typeof createVoiceModelManager>;
    const missingModule = Object.assign(new Error("not exposed to operators"), { code: "ERR_MODULE_NOT_FOUND" });
    const service = createParakeetService({ manager, loadBinding: async () => { throw missingModule; } });

    await expect(service.getRuntimeStatus()).resolves.toEqual({ status: "unavailable", unavailableReason: "runtime-module-missing" });
  });

  it("reports a platform addon load failure without leaking the loader error", async () => {
    const manager = { getState: async () => ({ status: "installed" as const, installedPath: "/model" }) } as ReturnType<typeof createVoiceModelManager>;
    const platformFailure = Object.assign(new Error("dlopen /private/operator/path"), { code: "ERR_DLOPEN_FAILED" });
    const service = createParakeetService({ manager, loadBinding: async () => { throw platformFailure; } });

    await expect(service.getRuntimeStatus()).resolves.toEqual({ status: "unavailable", unavailableReason: "runtime-platform-load-failed" });
  });

  it("reports a loaded but incompatible native binding as unavailable", async () => {
    const manager = { getState: async () => ({ status: "installed" as const, installedPath: "/model" }) } as ReturnType<typeof createVoiceModelManager>;
    const service = createParakeetService({ manager, loadBinding: async () => ({}) });
    await expect(service.getRuntimeStatus()).resolves.toEqual({ status: "unavailable", unavailableReason: "runtime-incompatible" });
  });

  it("uses sherpa's OfflineRecognizer and stream API for incremental decoding", async () => {
    let decoded = false;
    const stream = { acceptWaveform: vi.fn(), free: vi.fn() };
    const recognizer = { createStream: vi.fn(() => stream), decode: vi.fn(() => { decoded = true; }), getResult: vi.fn((received) => ({ text: received === stream && decoded ? "fresh" : "stale" })), close: vi.fn() };
    const OfflineRecognizer = vi.fn(function () { return recognizer; });
    const manager = { getState: async () => ({ status: "installed" as const, installedPath: "/model" }) } as ReturnType<typeof createVoiceModelManager>;
    const service = createParakeetService({ manager, loadBinding: async () => ({ OfflineRecognizer: OfflineRecognizer as never }) });
    const session = await service.createSession({ modelId: "parakeet-v3", language: "en" });
    expect(session.acceptChunk(Buffer.from([0, 0]), { final: false })).toEqual({ partial: "fresh" });
    expect(OfflineRecognizer).toHaveBeenCalledWith(expect.objectContaining({ modelConfig: expect.objectContaining({ transducer: expect.any(Object), tokens: "/model/tokens.txt" }) }));
    expect(stream.acceptWaveform).toHaveBeenCalledWith(expect.objectContaining({ sampleRate: 16_000, samples: expect.any(Float32Array) }));
    expect(recognizer.decode).toHaveBeenCalledWith(stream);
    expect(recognizer.getResult).toHaveBeenCalledWith(stream);
    expect(recognizer.decode).toHaveBeenCalledBefore(recognizer.getResult);
    session.close();
    expect(stream.free).toHaveBeenCalledOnce();
  });
});
