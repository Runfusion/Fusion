import { probeDroidBinary } from "@fusion-plugin-examples/droid-runtime/probe";

export type DroidCliBinaryStatus = Awaited<ReturnType<typeof probeDroidBinary>>;

export async function probeDroidCli(options: { timeoutMs?: number; settings?: Record<string, unknown> } = {}): Promise<DroidCliBinaryStatus> {
  return probeDroidBinary({ timeoutMs: options.timeoutMs, settings: options.settings });
}
