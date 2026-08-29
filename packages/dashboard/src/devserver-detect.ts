import { exec } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface DetectedCommand {
  name: string;
  command: string;
  cwd: string;
  scriptName: string;
  packagePath: string;
  framework?: string;
}

interface PackageJsonShape {
  scripts?: Record<string, string>;
}

export const PRIORITY_SCRIPTS = ["dev", "start", "web", "frontend", "serve", "storybook"];

export const FRAMEWORK_PATTERNS: Record<string, RegExp> = {
  vite: /\bvite\b/,
  next: /\bnext\b/,
  nuxt: /\bnuxt\b/,
  remix: /\bremix\b/,
  astro: /\bastro\b/,
  storybook: /\bstorybook\b/,
  angular: /\bng\s+serve\b/,
  "react-scripts": /\breact-scripts\b/,
  "create-react-app": /\breact-scripts\s+start\b/,
};

export function detectFramework(scriptCommand: string): string | undefined {
  for (const [framework, pattern] of Object.entries(FRAMEWORK_PATTERNS)) {
    if (pattern.test(scriptCommand)) {
      return framework;
    }
  }

  return undefined;
}

async function readPackageJson(packagePath: string): Promise<PackageJsonShape | null> {
  try {
    const escapedPath = JSON.stringify(packagePath);
    const { stdout } = await execAsync(
      `node -e 'process.stdout.write(require("node:fs").readFileSync(${escapedPath}, "utf8"))'`,
      { maxBuffer: 1024 * 1024 },
    );

    return JSON.parse(stdout) as PackageJsonShape;
  } catch {
    return null;
  }
}

function buildDetectedCommand(
  scriptName: string,
  scriptCommand: string,
  cwd: string,
  packagePath: string,
): DetectedCommand {
  return {
    name: `Dev Server (${scriptName})`,
    command: `npm run ${scriptName}`,
    cwd,
    scriptName,
    packagePath,
    framework: detectFramework(scriptCommand),
  };
}

async function findWorkspacePackageJsons(projectRoot: string): Promise<string[]> {
  const packageFiles: string[] = [];

  for (const rootFolder of ["apps", "packages"]) {
    const rootPath = join(projectRoot, rootFolder);
    try {
      const entries = await readdir(rootPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }

        packageFiles.push(join(rootPath, entry.name, "package.json"));
      }
    } catch {
      // Ignore missing workspace directories.
    }
  }

  return packageFiles;
}

function collectFromScripts(
  scripts: Record<string, string> | undefined,
  cwd: string,
  packagePath: string,
): DetectedCommand[] {
  if (!scripts) {
    return [];
  }

  const commands: DetectedCommand[] = [];
  for (const scriptName of PRIORITY_SCRIPTS) {
    const scriptCommand = scripts[scriptName];
    if (typeof scriptCommand !== "string" || scriptCommand.trim().length === 0) {
      continue;
    }

    commands.push(buildDetectedCommand(scriptName, scriptCommand, cwd, packagePath));
  }

  return commands;
}

export async function detectDevServerCommands(projectRoot: string): Promise<DetectedCommand[]> {
  const root = resolve(projectRoot);
  const deduped = new Map<string, DetectedCommand>();

  const rootPackagePath = join(root, "package.json");
  const rootPackageJson = await readPackageJson(rootPackagePath);
  if (!rootPackageJson) {
    return [];
  }

  for (const command of collectFromScripts(rootPackageJson.scripts, root, rootPackagePath)) {
    deduped.set(`${command.cwd}::${command.scriptName}`, command);
  }

  const workspacePackageFiles = await findWorkspacePackageJsons(root);
  for (const packagePath of workspacePackageFiles) {
    const pkg = await readPackageJson(packagePath);
    if (!pkg) {
      continue;
    }

    const packageCwd = dirname(packagePath);
    const commands = collectFromScripts(pkg.scripts, packageCwd, packagePath);
    for (const command of commands) {
      deduped.set(`${command.cwd}::${command.scriptName}`, command);
    }
  }

  const results = Array.from(deduped.values());
  results.sort((a, b) => {
    const aPriority = PRIORITY_SCRIPTS.indexOf(a.scriptName);
    const bPriority = PRIORITY_SCRIPTS.indexOf(b.scriptName);
    if (aPriority !== bPriority) {
      return aPriority - bPriority;
    }

    const aDepth = a.cwd === root ? 0 : a.cwd.split(/[\\/]/).length;
    const bDepth = b.cwd === root ? 0 : b.cwd.split(/[\\/]/).length;
    if (aDepth !== bDepth) {
      return aDepth - bDepth;
    }

    return a.cwd.localeCompare(b.cwd);
  });

  return results;
}
