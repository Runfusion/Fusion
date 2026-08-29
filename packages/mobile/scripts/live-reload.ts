import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

type MobilePlatform = "ios" | "android";

interface Args {
  platform: MobilePlatform;
  serverUrl: string;
}

function parseArgs(argv: string[]): Args {
  let platform: MobilePlatform | undefined;
  let serverUrl = process.env.FUSION_SERVER_URL || "http://localhost:5173";

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--platform") {
      const value = argv[i + 1];
      if (value !== "ios" && value !== "android") {
        throw new Error("--platform must be either 'ios' or 'android'");
      }
      platform = value;
      i += 1;
      continue;
    }

    if (arg === "--server-url") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--server-url requires a value");
      }
      serverUrl = value;
      i += 1;
    }
  }

  if (!platform) {
    throw new Error("Missing required --platform argument");
  }

  return { platform, serverUrl };
}

async function waitForServer(serverUrl: string, timeoutMs = 120_000): Promise<void> {
  const start = Date.now();
  const healthUrl = new URL("/", serverUrl).toString();

  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(healthUrl, { method: "GET" });
      if (response.ok || response.status === 404) {
        return;
      }
    } catch {
      // server not ready yet
    }

    await delay(1_000);
  }

  throw new Error(`Timed out waiting for dev server at ${serverUrl}`);
}

function command(name: string): string {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function spawnWithInheritedIo(bin: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(bin, args, {
    stdio: "inherit",
    env,
  });
}

async function run(): Promise<void> {
  const { platform, serverUrl } = parseArgs(process.argv.slice(2));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FUSION_LIVE_RELOAD: "true",
    FUSION_SERVER_URL: serverUrl,
  };

  const devServer = spawnWithInheritedIo(command("pnpm"), ["--filter", "@fusion/dashboard", "dev:serve"], env);

  const cleanup = () => {
    if (!devServer.killed) {
      devServer.kill("SIGTERM");
    }
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  try {
    await waitForServer(serverUrl);

    const capRun = spawnWithInheritedIo(command("npx"), ["cap", "run", platform], env);

    await new Promise<void>((resolve, reject) => {
      capRun.on("error", reject);
      capRun.on("exit", (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`cap run ${platform} exited with code ${code ?? "unknown"}`));
      });
    });
  } finally {
    cleanup();
  }
}

run().catch((error) => {
  console.error("[mobile live-reload]", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
