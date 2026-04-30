import path from "node:path";
import { homedir } from "node:os";

export interface StoredAuthProvider {
  type: string;
  key?: string;
  access?: string;
  refresh?: string;
  expires?: number;
  accountId?: string;
}

export function getFusionAgentDir(home = process.env.HOME || process.env.USERPROFILE || homedir()): string {
  return path.join(home, ".fusion", "agent");
}

export function getFusionAuthPath(home = process.env.HOME || process.env.USERPROFILE || homedir()): string {
  return path.join(getFusionAgentDir(home), "auth.json");
}

export function getFusionModelsPath(home = process.env.HOME || process.env.USERPROFILE || homedir()): string {
  return path.join(getFusionAgentDir(home), "models.json");
}

export function getAuthFileCandidates(
  cwd = process.cwd(),
  home = process.env.HOME || process.env.USERPROFILE || homedir(),
): string[] {
  return [
    path.join(home, ".fusion", "agent", "auth.json"),
    path.join(home, ".fusion", "auth.json"),
    path.join(cwd, ".fusion", "agent", "auth.json"),
    path.join(cwd, ".fusion", "auth.json"),
    path.join(home, ".pi", "agent", "auth.json"),
    path.join(home, ".pi", "auth.json"),
  ];
}

