import { readdirSync } from "node:fs";
import { join } from "node:path";
import { existsSync } from "node:fs";

const ADJECTIVES = [
  "amber", "azure", "bold", "brave", "bright",
  "calm", "clear", "cool", "coral", "crisp",
  "deft", "dusky", "eager", "early", "faint",
  "fast", "fleet", "fresh", "gentle", "gilt",
  "glad", "grand", "green", "happy", "hazy",
  "ivory", "jade", "keen", "lemon", "light",
  "lunar", "maple", "merry", "misty", "noble",
  "opal", "pale", "pearl", "plush", "proud",
  "quiet", "rapid", "rosy", "rusty", "sandy",
  "sharp", "sleek", "solar", "swift", "vivid",
];

const NOUNS = [
  "badger", "breeze", "brook", "cedar", "cliff",
  "crane", "daisy", "delta", "dune", "eagle",
  "ember", "falcon", "fern", "finch", "flame",
  "frost", "grove", "hawk", "heron", "iris",
  "lark", "lotus", "maple", "marsh", "mesa",
  "moss", "oak", "olive", "orbit", "otter",
  "panda", "peach", "petal", "pine", "plume",
  "quail", "raven", "reef", "ridge", "robin",
  "sage", "shore", "spark", "stone", "swift",
  "thorn", "tiger", "trail", "trout", "wren",
];

/**
 * Generate a random, human-friendly worktree directory name.
 *
 * Names follow an `adjective-noun` pattern (e.g., `swirly-monkey`,
 * `quiet-falcon`, `bright-orchid`) drawn from embedded word lists of
 * ~50 adjectives × ~50 nouns, producing ~2,500 unique combinations.
 *
 * **Collision avoidance:** The function checks existing subdirectories
 * under `<rootDir>/.worktrees/`. If the randomly chosen name already
 * exists, a numeric suffix is appended (e.g., `swift-falcon-2`,
 * `swift-falcon-3`) until a unique name is found.
 *
 * @param rootDir - The project root directory (parent of `.worktrees/`)
 * @returns A unique worktree directory name (not a full path)
 */
export function generateWorktreeName(rootDir: string): string {
  const adjective = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const baseName = `${adjective}-${noun}`;

  const worktreesDir = join(rootDir, ".worktrees");
  const existing = getExistingWorktreeNames(worktreesDir);

  if (!existing.has(baseName)) {
    return baseName;
  }

  // Collision — append numeric suffix
  let suffix = 2;
  while (existing.has(`${baseName}-${suffix}`)) {
    suffix++;
  }
  return `${baseName}-${suffix}`;
}

function getExistingWorktreeNames(worktreesDir: string): Set<string> {
  if (!existsSync(worktreesDir)) {
    return new Set();
  }
  try {
    const entries = readdirSync(worktreesDir, { withFileTypes: true });
    return new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name));
  } catch {
    return new Set();
  }
}
