import {randomUUID} from "node:crypto";
import {mkdir, rename, unlink, writeFile} from "node:fs/promises";
import {dirname, join} from "node:path";

/*
FNXC:TaskDetailPlan 2026-08-28-15:31:
A truncating PROMPT.md write lets getTask, the narrow prompt route, and step parsing observe an empty or prefix-truncated plan. Publish through a same-directory unique temporary file so the Definition summary never disappears because a reader raced plan publication.
*/
export async function writePromptFileAtomic(promptPath: string, content: string): Promise<void> {
  const parentDir = dirname(promptPath);
  const tmpPath = join(parentDir, `PROMPT.md.${process.pid}.${randomUUID()}.tmp`);
  await mkdir(parentDir, {recursive: true});
  await writeFile(tmpPath, content);
  try {
    await rename(tmpPath, promptPath);
  } catch (error) {
    try {
      await unlink(tmpPath);
    } catch {
      // The temporary file may already be absent; preserve the rename failure.
    }
    throw error;
  }
}
