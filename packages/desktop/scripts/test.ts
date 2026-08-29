import { buildDesktopVitestArgs } from "./test-args";
import { buildCore, buildDashboard, packageRoot, runWorkspaceBin } from "./workspace-tools";

async function main(): Promise<void> {
  console.log("[desktop:test] Building @fusion/core...");
  await buildCore();

  console.log("[desktop:test] Building @fusion/dashboard...");
  await buildDashboard();

  console.log("[desktop:test] Running desktop Vitest suite...");
  await runWorkspaceBin("vitest", buildDesktopVitestArgs(process.argv.slice(2)), packageRoot);
}

void main().catch((error) => {
  console.error("[desktop:test] Test run failed", error);
  process.exitCode = 1;
});
