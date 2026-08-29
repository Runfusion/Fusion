import { readFile, writeFile, access, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

function projectScriptsFile(projectDir: string): string {
  return join(resolve(projectDir), ".fusion", "scripts.json");
}

function legacyProjectScriptsFile(projectDir: string): string {
  return join(resolve(projectDir), ".pi", "fusion", "scripts.json");
}

interface ScriptsData {
  scripts: Record<string, string>;
}

class ScriptStore {
  private scripts: Record<string, string> = {};
  private filePath: string;
  private legacyFilePath?: string;

  constructor(filePath: string, legacyFilePath?: string) {
    this.filePath = filePath;
    this.legacyFilePath = legacyFilePath;
  }

  async load(): Promise<void> {
    const paths = this.legacyFilePath ? [this.filePath, this.legacyFilePath] : [this.filePath];
    try {
      for (const path of paths) {
        try {
          await access(path);
          const content = await readFile(path, "utf-8");
          const data = JSON.parse(content) as ScriptsData;
          this.scripts = data.scripts || {};
          return;
        } catch {
          // Try the next candidate.
        }
      }
      this.scripts = {};
    } catch {
      // File doesn't exist or is invalid - start with empty scripts
      this.scripts = {};
    }
  }

  async save(): Promise<void> {
    const dir = this.filePath.substring(0, this.filePath.lastIndexOf("/"));
    try {
      await access(dir);
    } catch {
      await mkdir(dir, { recursive: true });
    }
    
    const data: ScriptsData = { scripts: this.scripts };
    await writeFile(this.filePath, JSON.stringify(data, null, 2), "utf-8");
  }

  getScripts(): Record<string, string> {
    return { ...this.scripts };
  }

  getScript(name: string): string | undefined {
    return this.scripts[name];
  }

  setScript(name: string, command: string): void {
    this.scripts[name] = command;
  }

  removeScript(name: string): void {
    delete this.scripts[name];
  }
}

const storeInstances = new Map<string, ScriptStore>();

export async function loadScriptStore(projectDir: string): Promise<ScriptStore> {
  const scriptsFile = projectScriptsFile(projectDir);
  let store = storeInstances.get(scriptsFile);
  if (!store) {
    store = new ScriptStore(scriptsFile, legacyProjectScriptsFile(projectDir));
    storeInstances.set(scriptsFile, store);
    await store.load();
  }
  return store;
}

export function resetScriptStore(): void {
  storeInstances.clear();
}

export { projectScriptsFile, legacyProjectScriptsFile };
export type { ScriptStore };
