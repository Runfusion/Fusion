import type { ServiceDraft } from "../wizard/types.js";

// Symbol drift note (FN-3764): draft uses `credential` field and optional `params?: string` per endpoint.
export type GeneratedCliArtifact = {
  draftId: string;
  slug: string;
  binPath: string;
  entrypoint: "node" | "npx" | "direct";
  generatedAt: string;
};

export type RunRequest = {
  endpointId: string;
  params: Record<string, string | number | boolean>;
  credentials?: Record<string, string>;
  timeoutMs?: number;
};

export type RunResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  argv: string[];
};

export type GenerateCliInput = {
  draft: ServiceDraft;
  outDir: string;
};
