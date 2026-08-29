import { spawn } from "node:child_process";

export function isTTYAvailable(): boolean {
  return Boolean(process.stdout.isTTY && process.stdin.isTTY);
}

// Cross-platform clipboard write. Tries the native helper for the current
// platform; resolves false if no helper is available or the spawn fails so
// callers can surface a sensible error to the user.
export async function copyToClipboard(text: string): Promise<boolean> {
  const candidates: Array<{ cmd: string; args: string[] }> =
    process.platform === "darwin"
      ? [{ cmd: "pbcopy", args: [] }]
      : process.platform === "win32"
        ? [{ cmd: "clip", args: [] }]
        : [
            { cmd: "wl-copy", args: [] },
            { cmd: "xclip", args: ["-selection", "clipboard"] },
            { cmd: "xsel", args: ["--clipboard", "--input"] },
          ];

  for (const { cmd, args } of candidates) {
    const ok = await new Promise<boolean>((resolve) => {
      try {
        const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
        child.once("error", () => resolve(false));
        child.once("close", (code) => resolve(code === 0));
        child.stdin.end(text);
      } catch {
        resolve(false);
      }
    });
    if (ok) return true;
  }
  return false;
}
