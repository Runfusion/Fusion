import { readFile } from "node:fs/promises";
import { join } from "node:path";

type BuildMemoryIndexInput = {
  rootDir: string;
  agentId: string;
};

type HeadingEntry = {
  heading: string;
  summary?: string;
};

const MAX_INDEX_BYTES = 800;

function clampUtf8(input: string, maxBytes: number): string {
  if (Buffer.byteLength(input, "utf8") <= maxBytes) return input;
  let out = "";
  for (const char of input) {
    if (Buffer.byteLength(out + char, "utf8") > maxBytes) break;
    out += char;
  }
  return out;
}

function parseHeadings(content: string): HeadingEntry[] {
  const lines = content.split(/\r?\n/);
  const entries: HeadingEntry[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]?.trim() ?? "";
    if (!line.startsWith("## ")) continue;

    const heading = line.slice(3).trim();
    if (!heading) continue;

    let summary: string | undefined;
    for (let j = i + 1; j < lines.length; j += 1) {
      const candidate = (lines[j] ?? "").trim();
      if (!candidate) continue;
      if (candidate.startsWith("## ")) break;
      summary = candidate;
      break;
    }
    entries.push({ heading, summary });
  }

  return entries;
}

async function buildFileSection(sectionHeader: string, displayPath: string, fsPath: string): Promise<string> {
  try {
    const content = await readFile(fsPath, "utf-8");
    const headings = parseHeadings(content);
    const lines = [sectionHeader, `- ${displayPath}`];
    for (const entry of headings) {
      const descriptor = entry.summary ? ` — ${entry.summary}` : "";
      lines.push(`  - "${entry.heading}"${descriptor}`);
    }
    return `${lines.join("\n")}\n`;
  } catch {
    return "";
  }
}

export async function buildMemoryIndex({ rootDir, agentId }: BuildMemoryIndexInput): Promise<string> {
  const safeAgentId = agentId.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
  const agentDisplayPath = `.fusion/agent-memory/${safeAgentId}/MEMORY.md`;
  const agentFsPath = join(rootDir, ".fusion", "agent-memory", safeAgentId, "MEMORY.md");

  const projectDisplayPath = ".fusion/memory/MEMORY.md";
  const projectFsPath = join(rootDir, ".fusion", "memory", "MEMORY.md");

  const [agentSection, projectSection] = await Promise.all([
    buildFileSection("## Agent Memory Index (use fn_memory_search / fn_memory_get to read)", agentDisplayPath, agentFsPath),
    buildFileSection("## Project Memory Index", projectDisplayPath, projectFsPath),
  ]);

  const assembled = [agentSection, projectSection].filter(Boolean).join("\n").trim();
  if (!assembled) return "";
  if (Buffer.byteLength(assembled, "utf8") <= MAX_INDEX_BYTES) return assembled;
  return `${clampUtf8(assembled, MAX_INDEX_BYTES - 1)}…`;
}
