/** Script-free @lydell/node-pty platform payload helpers shared by standalone staging. */
export function nodePtyPlatformPackageName(platform: string, arch: string): string | null {
  const token = `${platform}-${arch}`;
  return new Set(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"]).has(token)
    ? `@lydell/node-pty-${token}`
    : null;
}

export function nodePtyPrebuildRelDir(platform: string, arch: string): string {
  return `prebuilds/${platform}-${arch}`;
}

export function bunTargetToPlatformArch(target: string): { platform: string; arch: string } | null {
  const match = /^bun-(darwin|linux|windows)-(arm64|x64)$/.exec(target);
  if (!match) return null;
  return { platform: match[1] === "windows" ? "win32" : match[1], arch: match[2] };
}

/*
 * FNXC:Terminal 2026-09-04-02:17:
 * The published Windows payload exposes ConPTY directly; unlike Unix packages it
 * deliberately has no pty.node. Staging copies the full prebuild directory, so
 * companion-file changes upstream are preserved rather than guessed here.
 */
export function nodePtyRequiredNativeAssetName(platform: string): string | null {
  if (platform === "win32") return "conpty.node";
  return platform === "darwin" || platform === "linux" ? "pty.node" : null;
}

/** FNXC:Terminal 2026-09-04-01:43: Cross-target releases must fail instead of silently shipping no PTY payload. */
export function resolveStagingOutcome({ staged, allowMissingNative }: { staged: boolean; allowMissingNative: boolean }): "success" | "warn" | "fail" {
  return staged ? "success" : allowMissingNative ? "warn" : "fail";
}
