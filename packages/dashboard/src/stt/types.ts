export type VoiceModelStatus = "not-installed" | "queued" | "downloading" | "installed" | "error";
export type VoiceModelErrorReason = "checksum-unpinned" | "checksum-mismatch" | "network" | "extraction-failed" | "unsafe-archive" | "incomplete-install" | "cancelled";
export interface VoiceModelState { status: VoiceModelStatus; progress?: number; bytesDownloaded?: number; totalBytes?: number; errorReason?: VoiceModelErrorReason; errorMessage?: string; checksumVerified?: boolean; installedPath?: string; }
export type VoiceRuntimeStatus = "available" | "unavailable";
export type VoiceModelId = "parakeet-v3";
export const DEFAULT_VOICE_MODEL_ID: VoiceModelId = "parakeet-v3";
export const SUPPORTED_VOICE_LANGUAGES = ["en"] as const;
export const DEFAULT_VOICE_LANGUAGE = "en";
export interface VoiceModelAsset { url: string; filename: string; sha256: string | null; expectedFiles: string[]; stripComponents?: number; }
/**
 * FNXC:VoiceInput 2026-07-25-00:00:
 * Pin sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2 to the locally verified upstream
 * SHA-256 because GitHub's release API publishes no digest for this asset. The archive nests
 * one top-level directory, so extraction strips one component while the checksum gate remains
 * mandatory before any download can be installed.
 */
export const PARAKEET_V3_ASSET: VoiceModelAsset = {
  url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2",
  filename: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2",
  sha256: "5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf",
  expectedFiles: ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"],
  stripComponents: 1,
};
export const VOICE_MODEL_REGISTRY: Record<VoiceModelId, VoiceModelAsset> = { "parakeet-v3": PARAKEET_V3_ASSET };
export function resolveVoiceModelId(raw?: string): { id: VoiceModelId } | { unsupported: string } { return raw === undefined || raw === DEFAULT_VOICE_MODEL_ID ? { id: DEFAULT_VOICE_MODEL_ID } : { unsupported: raw }; }
export function resolveVoiceLanguage(raw?: string): { language: string } | { unsupported: string } { return raw === undefined || raw === DEFAULT_VOICE_LANGUAGE ? { language: DEFAULT_VOICE_LANGUAGE } : { unsupported: raw }; }
