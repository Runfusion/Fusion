import { readFile, writeFile, access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const SCRIPTS_FILE = join(homedir(), ".pi", "fusion", "scripts.json");

interface ScriptsData {
  scripts: Record<string, string>;
}

class ScriptStore {
  private scripts: Record<string, string> = {};
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async load(): Promise<void> {
    try {
      await access(this.filePath);
      const content = await readFile(this.filePath, "utf-8");
      const data = JSON.parse(content) as ScriptsData;
      this.scripts = data.scripts || {};
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

let storeInstance: ScriptStore | null = null;

export async function loadScriptStore(): Promise<ScriptStore> {
  if (!storeInstance) {
    storeInstance = new ScriptStore(SCRIPTS_FILE);
    await storeInstance.load();
  }
  return storeInstance;
}

export function resetScriptStore(): void {
  storeInstance = null;
}

export type { ScriptStore };
