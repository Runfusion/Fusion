import type { ComputerAdapter } from "./adapter.js";
import { UnsupportedComputerAdapter } from "./adapter-unsupported.js";
import { defaultComputerExecSeam, type ComputerExecSeam } from "./exec-seam.js";

export interface ComputerClock {
  now(): Date;
}

export interface MacosComputerAdapterContext {
  platform: "darwin";
  seam: ComputerExecSeam;
  clock: ComputerClock;
  projectRoot: string;
}

export type MacosComputerAdapterFactory = (context: MacosComputerAdapterContext) => ComputerAdapter;

export interface ComputerAdapterRegistryOptions {
  platform?: string;
  seam?: ComputerExecSeam;
  clock?: ComputerClock;
  projectRoot: string;
  /** Injection keeps registry tests and non-macOS hosts away from OS automation. */
  macosAdapterFactory: MacosComputerAdapterFactory;
}

const systemClock: ComputerClock = { now: () => new Date() };

/**
 * Resolves the sole first-class platform adapter. The macOS factory is injected until the concrete
 * adapter owns the OS built-in implementation, while unsupported platforms always get a rejecting adapter.
 */
export function resolveComputerAdapter(options: ComputerAdapterRegistryOptions): ComputerAdapter {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") return new UnsupportedComputerAdapter(platform);
  return options.macosAdapterFactory({
    platform: "darwin",
    seam: options.seam ?? defaultComputerExecSeam,
    clock: options.clock ?? systemClock,
    projectRoot: options.projectRoot,
  });
}
