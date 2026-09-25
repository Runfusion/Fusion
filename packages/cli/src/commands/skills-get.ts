import { renderComputerUseGuide } from "./computer/guide.js";

/** Built-in guides are rendered by this process so they match the CLI executing commands. */
export const BUILTIN_SKILL_GUIDES = ["computer-use"] as const;
export type BuiltinSkillGuide = (typeof BUILTIN_SKILL_GUIDES)[number];

export async function runSkillsGet(
  args: string[],
  options: { stdout?: (text: string) => void; stderr?: (text: string) => void } = {},
): Promise<number> {
  const write = options.stdout ?? ((text: string) => process.stdout.write(text));
  const error = options.stderr ?? ((text: string) => process.stderr.write(text));
  const name = args[0];
  if (!name) {
    error(`Usage: fn skills get <skill-name>\nKnown skills: ${BUILTIN_SKILL_GUIDES.join(", ")}\n`);
    return 1;
  }
  if (name !== "computer-use") {
    error(`Unknown built-in skill: ${name}. Known skills: ${BUILTIN_SKILL_GUIDES.join(", ")}\n`);
    return 1;
  }
  write(renderComputerUseGuide());
  return 0;
}
