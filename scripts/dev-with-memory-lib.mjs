export function buildDevNodeArgs({
  inspectFlags = [],
  preload,
  loader,
  entry,
  args = [],
}) {
  return [
    ...inspectFlags,
    "--conditions=source",
    "--require",
    preload,
    "--import",
    `file://${loader}`,
    entry,
    ...args,
  ];
}

const VALID_PREBUILD_MODES = new Set(["auto", "none", "client", "full"]);

export function normalizePrebuildMode(value) {
  const mode = value === undefined || value === null ? "auto" : String(value).toLowerCase();
  if (mode === "" || !VALID_PREBUILD_MODES.has(mode)) {
    throw new Error(`Invalid prebuild mode "${value}". Expected one of: auto, none, client, full.`);
  }
  return mode;
}

export function hasHostOverride(args) {
  return args.includes("--host") || args.some((arg) => arg.startsWith("--host="));
}

export function buildForwardedDevArgs(args) {
  const needsDevHostInjection = args[0] === "dashboard" && !hasHostOverride(args);
  return needsDevHostInjection ? [...args, "--host", "0.0.0.0"] : args;
}

export function parseDevWrapperArgs(rawArgs, env = process.env) {
  const inspectFlags = [];
  const args = [];
  let requestedPrebuild = env.FUSION_DEV_PREBUILD ?? "auto";

  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i];
    if (arg === "--inspect" || arg === "--inspect-brk" || arg.startsWith("--inspect=") || arg.startsWith("--inspect-brk=")) {
      inspectFlags.push(arg);
      continue;
    }

    if (arg === "--prebuild") {
      const value = rawArgs[i + 1];
      if (!value) {
        throw new Error("Missing value for --prebuild. Expected one of: auto, none, client, full.");
      }
      requestedPrebuild = value;
      i += 1;
      continue;
    }

    if (arg.startsWith("--prebuild=")) {
      requestedPrebuild = arg.slice("--prebuild=".length);
      continue;
    }

    if (arg === "--skip-build") {
      requestedPrebuild = "none";
      continue;
    }

    args.push(arg);
  }

  return {
    inspectFlags,
    args,
    requestedPrebuild: normalizePrebuildMode(requestedPrebuild),
  };
}

export function resolvePrebuildMode(requestedPrebuild, forwardedArgs) {
  const mode = normalizePrebuildMode(requestedPrebuild);
  if (mode !== "auto") {
    return mode;
  }

  const command = forwardedArgs[0] ?? "dashboard";
  return command === "dashboard" ? "client" : "none";
}

export function getPrebuildCommand(mode) {
  switch (normalizePrebuildMode(mode)) {
    case "full":
      return { command: "pnpm", args: ["build"], label: "workspace build" };
    case "client":
      /*
      FNXC:DevWorkflow 2026-06-18-16:40:
      FN-6638/stale-dist: `pnpm dev dashboard` must rebuild @fusion/core and
      @fusion/engine alongside the dashboard UI, not only the client bundle.
      Although the CLI runs under `--conditions=source` (engine/core resolve to
      src), the running process and any dist-resolving consumer (plugins,
      sub-imports, a later non-dev `fn`/`pnpm local`) load built dist. Leaving
      engine/core dist stale is exactly how landed fixes (FN-6644/6647/6648,
      etc.) silently failed to run for ~2 days.

      FNXC:DevWorkflow 2026-07-10-15:40:
      FN-7779/stale-plugin-dist: the app-package build alone left plugin dist/
      stale — a source-only plugin fix (the Grok CLI-flag fix behind "messages
      aren't sending") never took effect until a manual rebuild. The client
      prebuild is now an orchestrator (scripts/dev-prebuild-client.mjs) that
      first runs the fast core → engine → dashboard build (dependency order;
      dashboard `build` also runs the vite client bundle + server tsc) and then
      incrementally rebuilds ONLY changed plugins via the content-hash skip
      cache. A single node command keeps the spawn contract cross-platform.
      */
      return {
        command: "node",
        args: ["scripts/dev-prebuild-client.mjs"],
        label: "core + engine + dashboard + changed plugins build",
      };
    case "none":
    case "auto":
      return null;
  }
}
