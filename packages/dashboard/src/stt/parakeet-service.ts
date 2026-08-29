import type { VoiceModelManager } from "./model-manager.js";
import { resolveVoiceLanguage, type VoiceModelId, type VoiceRuntimeStatus } from "./types.js";

export class VoiceInputError extends Error { constructor(public readonly code: "unsupported-language" | "invalid-audio" | "unavailable", message: string) { super(message); } }
export type VoiceRuntimeUnavailableReason = "model-not-installed" | "runtime-module-missing" | "runtime-platform-load-failed" | "runtime-incompatible";
export interface ParakeetService { getRuntimeStatus(): Promise<{ status: VoiceRuntimeStatus; unavailableReason?: VoiceRuntimeUnavailableReason }>; resetRuntime(): void; createSession(options: { modelId: VoiceModelId; language: string }): Promise<ParakeetSession>; }
export interface ParakeetSession { acceptChunk(pcm: Int16Array | Buffer, options: { final: boolean }): { partial?: string; text?: string; final?: true }; finish(): { text: string }; close(): void; }
interface SherpaStream { acceptWaveform(options: { sampleRate: number; samples: Float32Array }): void; free?(): void; close?(): void; }
interface SherpaRecognizer { createStream(): SherpaStream; getResult(stream: SherpaStream): { text?: string }; decode(stream: SherpaStream): void; free?(): void; close?(): void; }
interface SherpaOfflineRecognizerConstructor { new(config: { modelConfig: { transducer: { encoder: string; decoder: string; joiner: string }; tokens: string; numThreads: number; provider: string; debug: boolean }; decodingMethod: string; maxActivePaths: number }): SherpaRecognizer; }
interface SherpaBinding { OfflineRecognizer?: SherpaOfflineRecognizerConstructor; }
export interface ParakeetServiceOptions { manager: VoiceModelManager; loadBinding?: () => Promise<SherpaBinding>; }

function runtimeUnavailableReason(error: unknown): VoiceRuntimeUnavailableReason {
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") return "runtime-module-missing";
  return "runtime-platform-load-failed";
}

/**
 * FNXC:VoiceInput 2026-08-13-23:04:
 * sherpa-onnx-node is CommonJS, but cjs-module-lexer only exposes OnlineRecognizer
 * as a named ESM export. Resolve its default/module.exports values so healthy native
 * installs do not appear incompatible when OfflineRecognizer is namespace-hidden.
 */
function resolveSherpaBinding(module: unknown): SherpaBinding | undefined {
  if (!module || typeof module !== "object") return undefined;
  const namespace = module as Record<string, unknown>;
  for (const candidate of [namespace, namespace.default, namespace["module.exports"]]) {
    if (candidate && typeof candidate === "object" && typeof (candidate as SherpaBinding).OfflineRecognizer === "function") return candidate as SherpaBinding;
  }
  return undefined;
}

/**
 * FNXC:VoiceInput 2026-08-03-05:45:
 * FN-8753 keeps the sherpa addon lazy and fail-closed, but converts native import
 * failures into stable operator-safe codes. Raw loader errors can disclose paths
 * and differ by platform; Settings needs to distinguish an absent module, a
 * platform addon failure, and an incompatible export without exposing either.
 */
export function createParakeetService(options: ParakeetServiceOptions): ParakeetService {
  let bindingPromise: Promise<SherpaBinding> | undefined;
  const binding = () => bindingPromise ??= (options.loadBinding ? options.loadBinding() : new Function("specifier", "return import(specifier)")("sherpa-onnx-node") as Promise<SherpaBinding>);
  const getRuntimeStatus = async (): Promise<{ status: VoiceRuntimeStatus; unavailableReason?: VoiceRuntimeUnavailableReason }> => {
    const model = await options.manager.getState();
    if (model.status !== "installed" || !model.installedPath) return { status: "unavailable" as const, unavailableReason: "model-not-installed" };
    try {
      // A module resolving is not sufficient: a platform-mismatched or incompatible addon
      // can load without exporting the recognizer API required for transcription.
      if (!resolveSherpaBinding(await binding())) return { status: "unavailable" as const, unavailableReason: "runtime-incompatible" };
      return { status: "available" as const };
    } catch (error) { return { status: "unavailable" as const, unavailableReason: runtimeUnavailableReason(error) }; }
  };
  return {
    getRuntimeStatus,
    /**
     * FNXC:VoiceInput 2026-08-13-23:04:
     * Re-check drops a failed import attempt after an operator repairs an install. Node
     * retains successfully resolved modules, so a resolved broken native addon still
     * requires a Fusion restart; active sessions retain their constructed recognizers.
     */
    resetRuntime() { bindingPromise = undefined; },
    async createSession({ modelId: _modelId, language }) {
      if ("unsupported" in resolveVoiceLanguage(language)) throw new VoiceInputError("unsupported-language", "Unsupported language");
      const model = await options.manager.getState();
      const status = await getRuntimeStatus();
      if (status.status !== "available" || !model.installedPath) throw new VoiceInputError("unavailable", status.unavailableReason ?? "unavailable");
      const addon = resolveSherpaBinding(await binding());
      const OfflineRecognizer = addon?.OfflineRecognizer;
      if (!OfflineRecognizer) throw new VoiceInputError("unavailable", "OfflineRecognizer unavailable");
      // FNXC:VoiceInput 2026-07-21-20:30: sherpa-onnx-node's offline API owns waveform
      // ingestion on a stream, then decodes and reads that stream through its recognizer.
      // Keep the native config shaped as modelConfig; flat model-path configs are not accepted.
      const recognizer = new OfflineRecognizer({
        modelConfig: {
          transducer: {
            encoder: `${model.installedPath}/encoder.int8.onnx`,
            decoder: `${model.installedPath}/decoder.int8.onnx`,
            joiner: `${model.installedPath}/joiner.int8.onnx`,
          },
          tokens: `${model.installedPath}/tokens.txt`,
          numThreads: 1,
          provider: "cpu",
          debug: false,
        },
        decodingMethod: "greedy_search",
        maxActivePaths: 4,
      });
      const stream = recognizer.createStream();
      const decode = () => { recognizer.decode(stream); return recognizer.getResult(stream).text ?? ""; };
      return {
        acceptChunk(pcm, { final }) {
          const buffer = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
          if (!buffer.byteLength || buffer.byteLength % 2) throw new VoiceInputError("invalid-audio", "PCM must be signed 16-bit samples");
          const floats = new Float32Array(buffer.byteLength / 2);
          for (let i = 0; i < floats.length; i++) floats[i] = buffer.readInt16LE(i * 2) / 32768;
          stream.acceptWaveform({ sampleRate: 16_000, samples: floats });
          const text = decode();
          return final ? { text, final: true as const } : { partial: text };
        },
        finish: () => ({ text: decode() }),
        close: () => { stream.free?.(); stream.close?.(); recognizer.free?.(); recognizer.close?.(); },
      };
    },
  };
}
