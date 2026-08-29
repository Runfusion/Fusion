#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { checkCliRuntimeRouting } from "./lib/cli-runtime-routing-check.mjs";

const route = "packages/dashboard/src/routes/register-model-routes.ts";
const cachesDir = "packages/dashboard/src";
const census = "packages/engine/src/agents/cli-provider-routing.ts";
try {
  const constantSources = readdirSync(cachesDir)
    .filter((name) => name.endsWith("model-cache.ts"))
    .map((name) => readFileSync(join(cachesDir, name), "utf8"));
  const violations = checkCliRuntimeRouting({
    routeSource: readFileSync(route, "utf8"),
    censusSource: readFileSync(census, "utf8"),
    constantSources,
  });
  if (violations.length) {
    console.error("check-cli-runtime-routing: FAILED\n" + violations.map((item) => `- ${item}`).join("\n"));
    process.exit(1);
  }
  console.log("check-cli-runtime-routing: ok");
} catch (error) {
  console.error(`check-cli-runtime-routing: could not inspect required source: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
