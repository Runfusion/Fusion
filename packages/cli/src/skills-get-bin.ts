#!/usr/bin/env node

import { runSkillsGet } from "./commands/skills-get.js";

function extractSkillsGetArgs(argv: string[]): string[] | undefined {
  const cleanedArgs: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--quiet" || arg === "-q" || arg === "--skip-onboarding") {
      continue;
    }
    if (arg === "--project" || arg === "-P") {
      const projectName = argv[index + 1];
      if (!projectName || projectName.startsWith("-")) return undefined;
      index += 1;
      continue;
    }
    cleanedArgs.push(arg);
  }

  return cleanedArgs[0] === "skills" && cleanedArgs[1] === "get"
    ? cleanedArgs.slice(2)
    : undefined;
}

const args = extractSkillsGetArgs(process.argv.slice(2));
if (args === undefined) {
  throw new Error("The skills-get entry requires a skills get invocation.");
}

/*
 * FNXC:SkillsGetCompletion 2026-09-25-07:52:
 * The package launcher selects this small built entry before importing the full
 * CLI bundle. A guide request is terminal output, so it must retain natural
 * stdout/stderr drain and exit behavior without paying the generic command graph's cold parse cost.
 */
process.exitCode = await runSkillsGet(args);
